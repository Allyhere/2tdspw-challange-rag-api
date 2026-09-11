# Diretrizes para agentes — GraphRAG de plano de cuidados

POC em pt-BR: `POST /v1/care-plan` devolve itens **somente** do catálogo `api/data/clinica-catalogo.csv`. O LLM escolhe ids; recorrência e duração saem do nó `Treatment`. Não invente tratamento, exame ou intervalo.

Stack: Express + Neo4j + Gemini (`gemini-3.5-flash-lite` + `gemini-embedding-001`, 768-d). Sem Ollama.

## Condutas em `api/data/docs/`

Formato obrigatório: [`docs-template.md`](docs-template.md). Resumo operacional:

- Um `.md` por raça **com conduta distinta**; diretrizes globais (WSAVA, AAHA felina, antirrábica, dermatite) ficam em arquivos separados, **sem** `raca` / `especie` no front-matter.
- Front-matter: `fonte`, `url` (única), `editora`. Raça: `raca` = `breed` do JSON (ex. `Labrador`, `Persa`, `SRD`) e `especie` = `cachorro` | `gato`.
- O seed fatia em parágrafos (linha em branco) e **descarta ≤40 caracteres**. Sem `#` / `##` como bloco isolado.
- Cada bloco (80–500 caracteres, 4–7 por arquivo) começa com `Cachorro da raça <raca>` ou `Gato da raça <raca>` — a query é `` `${species} da raça ${breed}` ``.
- Diretriz global: comece com `Cachorro`, `Gato` ou `Cachorro ou gato`.
- Cite nomes **exatos** do CSV no mesmo bloco do sinônimo clínico (`vermes` + Vermífugo + Exame de fezes).
- Não recopiar calendário WSAVA dentro do doc de raça.
- **Não** colocar o template em `api/data/docs/`.

Catálogo permitido: V10, V8, Antirrábica, Giárdia, Vermífugo, Hemograma, Exame de fezes, Castração, V5, Vacina FeLV, Teste FIV/FeLV, Avaliação de peso e escore corporal, Ultrassom abdominal, Tratamento de dermatite, Raspado de pele.

Serviço novo = linha no CSV com `id` estável. Raça nova = `.md` novo, não linha de catálogo.

## Ingestão

Não apagar o grafo inteiro para acrescentar um arquivo. Upsert de `Treatment` por `id`; `Source` por `url`; re-embedar só se o SHA-256 do `.md` mudou; invalidar cache daquela `raca`+`especie` (doc global: cache todo). Subir `k` da busca vetorial (alvo 8–12) quando houver dezenas de raças.

```bash
# pasta api, stack no ar
npm run seed
# ou, depois do endpoint de ingest:
# curl -sf -X POST http://localhost:3000/v1/ingest
```

`GEMINI_API_KEY` no `.env`. Compose: Neo4j + seed + API (sem Ollama). Porta 3000 / Browser 7474.

## O que não fazer

- Não usar File Search / RAG gerenciado como planejador (inventa item fora do CSV).
- Não recomendar produto que não está no catálogo.
- Não commitar `.env`.
