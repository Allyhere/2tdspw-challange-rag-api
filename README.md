# POC GraphRAG — plano de cuidados veterinários

Serviço em português brasileiro que sugere um **plano de cuidados** a partir do perfil do pet (e, se houver, da consulta). Tudo sobe com Docker Compose: **Gemini + Neo4j + seed + API**.

A ideia do projeto é mostrar GraphRAG na prática: o modelo de linguagem **não inventa tratamentos**. Ele só escolhe itens que existem no catálogo da clínica (`api/data/clinica-catalogo.csv`). Textos em `api/data/docs/` viram embeddings no grafo; as fontes usadas voltam no JSON da resposta.

---

## Como usar

### 1. Subir o ambiente

Na raiz do repositório, com `GEMINI_API_KEY` no `.env` (veja `.env.example`):

```bash
docker compose up --build
```

O `seed` chama a API do Gemini para embedding e indexa os `.md` no Neo4j. A API fica em `http://localhost:3000`. Não há Ollama neste POC.

O Neo4j Browser fica em `http://localhost:7474` (usuário `neo4j`, senha `password`). Útil para inspecionar nós `Treatment`, `GuidelineChunk` e `Source`.

### 2. Conferir se está no ar

```bash
curl -sf http://localhost:3000/health
```

Resposta esperada: `{"ok":true,"provider":"gemini",...}`.

### 3. Pedir um plano

O contrato é `POST /v1/care-plan`. Campos obrigatórios descrevem o pet; os da consulta são opcionais.

```bash
curl -sf -X POST http://localhost:3000/v1/care-plan \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Thor",
    "breed": "Labrador",
    "species": "cachorro",
    "sex": "macho",
    "weight": 28.5,
    "age": 3,
    "isCastrated": false
  }'
```

Para validar os casos de raça (Labrador, Persa) e SRD (cão e gato) e recusar qualquer `planItemName` que não esteja no CSV:

```bash
sh scripts/request.sh
```

### 4. Convidar o tutor (chat)

Depois do plano, `POST /v1/conversations` gera o convite em tom de WhatsApp. O canal `"api"` devolve o texto no JSON (Twilio/Telegram entram depois no mesmo motor).

```bash
curl -sf -X POST http://localhost:3000/v1/conversations \
  -H "Content-Type: application/json" \
  -d '{
    "tutor": { "name": "Ana" },
    "pet": { "name": "Thor", "breed": "Labrador", "species": "cachorro" },
    "carePlan": [
      { "planItemName": "V10", "planRecurrency": "recurrent", "planRecurrencyRate": 12, "planDurationInMonths": 60 },
      { "planItemName": "Antirrábica", "planRecurrency": "recurrent", "planRecurrencyRate": 12, "planDurationInMonths": 60 },
      { "planItemName": "Exame de fezes", "planRecurrency": "recurrent", "planRecurrencyRate": 6, "planDurationInMonths": 12 }
    ]
  }'
```

Resposta: `{ "id", "status": "invited", "message": { "id", "role": "assistant", "text", "createdAt" } }`. Use o `id` nas próximas chamadas.

```bash
# pergunta sobre um procedimento (status continua invited)
curl -sf -X POST http://localhost:3000/v1/conversations/<id>/messages \
  -H "Content-Type: application/json" \
  -d '{"text":"O que é a V10?"}'

# aceite ou recusa
curl -sf -X POST http://localhost:3000/v1/conversations/<id>/messages \
  -H "Content-Type: application/json" \
  -d '{"text":"Pode sim"}'

# thread persistida
curl -sf http://localhost:3000/v1/conversations/<id>
```

`providerMessageId` no body da mensagem é opcional (MessageSid do Twilio, depois).

### 5. Reindexar documentos

`POST /v1/ingest` relê `api/data/docs/*.md` e o CSV **sem apagar o grafo**. Re-embeda só arquivos cujo SHA-256 mudou. Body vazio = incremental; `{ "force": true }` reindexa tudo.

O serviço **api** monta `./api/data` em `/app/data`: um `.md` novo entra no próximo ingest, sem rebuild da imagem.

```bash
curl -sf -X POST http://localhost:3000/v1/ingest
```

Resposta: `{ "treatments", "ingested", "skipped", "removed", "chunksWritten" }`.

Candidatos de URL (só imprime; não baixa página): `node scripts/harvest-allowlist.mjs`. Resuma no [`docs-template.md`](docs-template.md), aproveite, depois ingira.

### 6. App mobile

Defina `EXPO_PUBLIC_RAG_API_URL` (iOS Simulator: `http://localhost:3000`; emulador Android: `http://10.0.2.2:3000`). Depois de finalizar uma consulta, a tela de sucesso chama a API e a de tratamento mostra o plano e as fontes.

---

## O que o sistema faz

Você envia o perfil de um cão ou gato. A API devolve:

1. **`carePlanDescription`** — um resumo em pt-BR do animal e das prioridades do plano.
2. **`carePlan`** — lista de itens da clínica (vacina, exame, terapia, procedimento), com recorrência e duração.
3. **`sources`** — documentos de diretriz que o retriever achou relevantes (título, URL, editora).

O modelo **escolhe ids** do catálogo. Recorrência, intervalo e duração **não vêm do LLM**: a API copia esses campos do nó `Treatment` correspondente. Se o modelo inventar um nome, o item é descartado. Se nada restar, a API cai no catálogo filtrado pelo grafo; se o grafo também estiver vazio, responde HTTP 502.

---

## Arquitetura

Três peças, cada uma com um papel claro:

```
┌─────────────┐     POST /v1/care-plan      ┌──────────────────┐
│  App / curl │ ──────────────────────────► │  API (Express)   │
└─────────────┘                             │  porta 3000      │
                                            └────────┬─────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          │                          │                          │
                          ▼                          ▼                          ▼
                   ┌─────────────┐          ┌─────────────────┐        ┌─────────────────┐
                   │   Gemini    │          │     Neo4j       │        │  seed (one-shot)│
                   │  API        │          │  :7687 / :7474  │        │  carrega o grafo│
                   │             │          │                 │        └─────────────────┘
                   │ embedding-  │          │ Treatment       │
                   │ 001 (768-d) │          │ GuidelineChunk  │
                   │ flash-lite  │          │ Source          │
                   └─────────────┘          │ CachedCarePlan  │
                                            │ Conversation    │
                                            │ Message         │
                                            └─────────────────┘
```

| Serviço | Função |
| --- | --- |
| **api** | Recebe o JSON, valida, orquestra cache → retrieval → LLM → grounding. Expõe `POST /v1/ingest` e o chat de convite (`/v1/conversations`). |
| **neo4j** | Grafo da clínica: tratamentos aplicáveis, chunks de diretriz com vetor, cache de planos, conversas e mensagens. |
| **Gemini** | Embeddings (`gemini-embedding-001`, 768-d) e chat (`gemini-3.5-flash-lite`) com JSON schema. |
| **seed** | Chama a mesma ingestão incremental (`runIngest`): upsert de tratamentos, re-embed só se o hash do `.md` mudou. Roda uma vez e sai. |

A API não guarda estado em memória além da conexão. Conhecimento clínico e catálogo vivem no grafo. O LLM só ranqueia ids já filtrados.

### Mapa do código

| Caminho | Papel |
| --- | --- |
| `api/src/index.js` | Sobe o HTTP (listen / shutdown). |
| `api/src/app.js` | Rotas: `/health`, `POST /v1/care-plan`, `POST /v1/ingest`, `/v1/conversations`. |
| `api/src/schema.js` | Validação Zod do payload e do JSON do modelo. |
| `api/src/conversation.js` | Motor do convite: start / handleInbound / get; intent → status; RAG nas perguntas. |
| `api/src/conversationStore.js` | Persistência `Conversation` + `Message` (Neo4j; memória nos testes). |
| `api/src/rag.js` | Pipeline GraphRAG: query, embedding, LLM, grounding, descrição. |
| `api/src/ingest.js` | Upsert CSV + docs: hash skip, chunks por `Source.url`, invalida cache. |
| `api/src/neo4j.js` | Cypher: filtro de tratamentos, busca vetorial, cache (`breed`/`species`). |
| `api/src/config.js` | URI, modelos Gemini, `VECTOR_K` (padrão 8, alvo 8–12). |
| `api/src/gemini.js` | Cliente REST: generateContent (JSON schema) e batchEmbedContents. |
| `api/prompts/carePlan.md` | Prompt do plano: “copie ids do catálogo”. |
| `api/prompts/careInvite.md` | Prompt do convite WhatsApp: reply + intent. |
| `api/data/seed.js` | One-shot: espera Neo4j/Gemini e chama `runIngest`. |
| `api/data/clinica-catalogo.csv` | Menu real da clínica (ficção). |
| `api/data/docs/*.md` | Resumos em pt-BR com URL da fonte. |
| `scripts/harvest-allowlist.mjs` | Dry-run: imprime URLs de hosts permitidos (não faz crawl). |

---

## Como o GraphRAG funciona aqui

**RAG** (Retrieval-Augmented Generation) significa: antes de o modelo responder, o sistema **busca trechos** relacionados à pergunta e entrega esse contexto junto com o prompt. **GraphRAG**, neste POC, combina duas recuperações no mesmo grafo:

1. **Filtro estruturado (grafo)** — “quais itens do catálogo este pet *pode* receber?”
2. **Busca vetorial (embeddings)** — “quais trechos de diretriz *parecem* relevantes para este caso?”

O LLM recebe o pet + a lista já filtrada e devolve só ids. As fontes da busca vetorial vão no campo `sources`, para o cliente mostrar de onde veio o respaldo.

### O que vive no grafo

```
(:Treatment)                         catálogo da clínica (CSV)
(:GuidelineChunk)-[:FROM]->(:Source) trechos + metadados da diretriz
(:CachedCarePlan)                    plano já gerado para um perfil demográfico
(:Message)-[:IN]->(:Conversation)    convite ao tutor e thread (providerMessageId opcional)
```

- **`Treatment`**: id, nome, espécie, faixa de idade/peso, se é só para não castrado, recorrência e duração.
- **`GuidelineChunk`**: parágrafo do markdown + vetor de 768 dimensões (cosine).
- **`Source`**: título, URL e editora lidos do front-matter do `.md`.
- **`Conversation` / `Message`**: convite persistido (tutor, pet, plano do mês, status) e a thread. `providerMessageId` fica vazio no canal `api`.

O seed (e `POST /v1/ingest`) **não apaga o grafo**. Faz upsert de `Treatment` por id e de `Source` por URL; só re-embeda o `.md` se o SHA-256 mudou. Cada documento vira parágrafos (> 40 caracteres) com embeddings Gemini (`gemini-embedding-001`, 768-d, L2) no índice `guideline_index`. Doc de raça invalida o cache daquela `raca`+`especie`; diretriz global apaga todo `CachedCarePlan`.

### Caminho de uma requisição

```
payload
  │
  ├─ 1. Zod valida nome, raça, espécie, sexo, peso, idade, castração
  │     (+ resumo / diagnóstico / prescrição / exames, se vierem)
  │
  ├─ 2. Cache demográfico
  │     • sem dados de consulta → procura CachedCarePlan (hash da raça, espécie, sexo, peso, idade, castração e dos modelos)
  │     • com dados de consulta → ignora o cache (o plano precisa refletir aquele atendimento)
  │
  ├─ 3. Em paralelo
  │     • Gemini embeddings: vetoriza uma frase do tipo
  │       "cachorro da raça Labrador, 28.5kg, 3 anos, macho, não castrado. Diagnóstico: …"
  │     • Cypher: Treatments cuja espécie/idade/peso/castração batem com o pet
  │
  ├─ 4. Busca vetorial: os `VECTOR_K` chunks mais próximos (padrão 8, cosine) + Source ligada
  │
  ├─ 5. LLM (gemini-3.5-flash-lite, temperature 0, JSON schema)
  │     recebe o pet e o catálogo filtrado; responde {"ids":["v10","antirabica",…]}
  │
  ├─ 6. Grounding
  │     cada id/nome é casado com o Treatment; metadados vêm do CSV, não do modelo
  │     se o modelo falhar ou não copiar ids → usa até 8 itens do filtro Cypher
  │
  └─ 7. Monta a descrição em pt-BR, devolve sources únicas e grava o cache
        (só quando não houve contexto de consulta)
```

Tempos de cada etapa vão no header `Server-Timing` (`cache`, `embed`, `vector`, `catalog`, `llm`, `post`, `total`).

### Por que o modelo não inventa o menu

Há três camadas, de propósito:

1. O **Cypher** já corta tratamentos de outra espécie, fora da faixa de idade/peso, ou castração em animal já castrado.
2. O **prompt** pede ids literais do catálogo e proíbe inventar.
3. A **API** resolve cada id contra o catálogo (match exato, depois normalizado). Nome inventado some. Recorrência e duração saem do nó, não do texto gerado.

Isso é o “grounding”: geração ancorada em dados da clínica, não em memória paramétrica do modelo.

### Cache

A chave é um SHA-256 do perfil demográfico + nomes dos modelos. Dois Labradores iguais (mesmo peso, idade, sexo, castração) reaproveitam o plano. Um Thor com `diagnostico: "dermatite atópica"` **não** usa esse cache: o filtro `hasConsultaContext` força retrieval + LLM de novo, para o quadro clínico entrar na escolha (ex.: incluir `dermatite` e `raspado-pele`).

---

## Contrato da API

`GET /health` — `{ ok, provider, chatModel, embedModel }`.

`POST /v1/ingest` — body opcional `{ "force": true }`. Resposta: contagens `treatments` / `ingested` / `skipped` / `removed` / `chunksWritten`.

`POST /v1/care-plan`

`species`: `cachorro` | `gato`. Campos da consulta (`resumo`, `diagnostico`, `prescription`, `exams`) são opcionais.

```json
{
  "name": "Thor",
  "breed": "Labrador",
  "species": "cachorro",
  "sex": "macho",
  "weight": 28.5,
  "age": 3,
  "isCastrated": false,
  "resumo": "Tosse seca há 3 dias",
  "diagnostico": "Suspeita de traqueobronquite",
  "prescription": ["V10"],
  "exams": [{ "name": "Hemograma", "date": "2026-09-08" }]
}
```

Resposta:

```json
{
  "carePlanDescription": "resumo em pt-BR",
  "carePlan": [
    {
      "planItemName": "V10",
      "planRecurrency": "recurrent",
      "planRecurrencyRate": 12,
      "planDurationInMonths": 60
    }
  ],
  "sources": [
    { "title": "...", "url": "https://...", "publisher": "..." }
  ]
}
```

Erros úteis:

| HTTP | Quando |
| --- | --- |
| **400** | Payload inválido (Zod). |
| **502** | Nenhum item do catálogo se aplica, ou falha ao gerar o plano. |

`POST /v1/conversations` — tutor (`name`, `phone` opcional), pet (`name`, `breed`, `species`, …), `carePlan` já fatiado para o próximo mês, `channel` opcional (`api` | `whatsapp` | `telegram`, padrão `api`). Resposta: `{ id, status: "invited", message }`.

`POST /v1/conversations/:id/messages` — `{ "text", "providerMessageId?" }`. Resposta: `{ id, status, message }`. Status: `invited` → `accepted` | `declined`. Perguntas sobre os procedimentos do plano ficam em `invited` e usam os chunks GraphRAG.

`GET /v1/conversations/:id` — snapshot (tutor, pet, plano) e a thread em ordem.

| HTTP | Quando |
| --- | --- |
| **400** | Payload inválido (Zod). |
| **404** | Conversa inexistente. |
| **502** | Falha ao gerar o turno (Gemini). |

---

## Dados

- Catálogo da clínica (ficção): `api/data/clinica-catalogo.csv`
- Documentos para embedding (resumos em pt-BR, com URL da fonte):
  - WSAVA 2024 — [diretrizes de vacinação](https://wsava.org/global-guidelines/vaccination-guidelines/)
  - AAHA/AAFP 2020 — [vacinação felina](https://www.aaha.org/resources/2020-aahaaafp-feline-vaccination-guidelines/)
  - Instituto Pasteur-SP — [antirrábica](https://www.saude.sp.gov.br/resources/instituto-pasteur/pdf/nota-tecnica/informetecnicoip01_vacinacaoantirrabicaparacaes-gatos.pdf)
  - Labrador — [AKC](https://www.akc.org/dog-breeds/labrador-retriever/)
  - Cão SRD — [AAHA, estágio de vida canina](https://www.aaha.org/resources/life-stage-canine-2019/)
  - Persa / DRP — [Cornell](https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center/health-information/feline-health-topics/polycystic-kidney-disease)
  - Gato SRD — [Cornell, cuidados com o gato](https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center/health-information/feline-health-topics/choosing-and-caring-your-new-cat)
  - Dermatite atópica — [Merck Veterinary Manual](https://www.merckvetmanual.com/integumentary-system/atopic-dermatitis/atopic-dermatitis-in-animals)

Para incluir um tratamento novo: acrescente uma linha no CSV (com id estável) e rode o ingest. Para incluir conhecimento novo: um `.md` em `api/data/docs/` com front-matter `fonte`, `url` e `editora` (veja `docs-template.md`). Os serviços **api** e **seed** montam `api/data` em `/app/data`. Com o stack no ar:

```bash
curl -sf -X POST http://localhost:3000/v1/ingest
```

(Ou `docker compose up --force-recreate --no-deps seed`, ou `npm run seed` na pasta `api`.)
