# POC GraphRAG — plano de cuidados veterinários

Serviço brasileiro de sugestão de plano de cuidados. Roda inteiro com Docker Compose: **Ollama + Neo4j + seed + API**.

O modelo só pode devolver tratamentos que existem em `api/data/clinica-catalogo.csv`. Os textos em `api/data/docs/` (português brasileiro) viram embeddings e as fontes voltam no JSON.

## Subir

Na raiz do repositório:

```bash
docker compose up --build
```

A primeira vez baixa `embeddinggemma` e `llama3.2:3b` (demora). Espere o serviço `seed` terminar. A API fica em `http://localhost:3000`.

## Testar

```bash
curl -sf http://localhost:3000/health
sh scripts/request.sh
```

`request.sh` envia um Labrador e um Persa e recusa qualquer `planItemName` que não esteja no CSV.

## Contrato

`POST /v1/care-plan`

```json
{
  "name": "Thor",
  "breed": "Labrador",
  "species": "cachorro",
  "sex": "macho",
  "weight": 28.5,
  "age": 3,
  "isCastrated": false
}
```

`species`: `cachorro` | `gato`.

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

Filtro obrigatório: se o modelo inventar um nome, a API descarta. Se nada restar, HTTP 502.

## Dados

- Catálogo da clínica (ficção): `api/data/clinica-catalogo.csv`
- Documentos para embedding (resumos em pt-BR, com URL da fonte):
  - WSAVA 2024 — [diretrizes de vacinação](https://wsava.org/global-guidelines/vaccination-guidelines/)
  - AAHA/AAFP 2020 — [vacinação felina](https://www.aaha.org/resources/2020-aahaaafp-feline-vaccination-guidelines/)
  - Instituto Pasteur-SP — [antirrábica](https://www.saude.sp.gov.br/resources/instituto-pasteur/pdf/nota-tecnica/informetecnicoip01_vacinacaoantirrabicaparacaes-gatos.pdf)
  - Labrador — [AKC](https://www.akc.org/dog-breeds/labrador-retriever/)
  - Persa / DRP — [Cornell](https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center/health-information/feline-health-topics/polycystic-kidney-disease)

## App mobile

Defina `EXPO_PUBLIC_RAG_API_URL` (iOS Simulator: `http://localhost:3000`; emulador Android: `http://10.0.2.2:3000`). Depois de finalizar uma consulta, a tela de sucesso chama a API e a de tratamento mostra o plano e as fontes.

## Azure Container Registry

A imagem da API (sem Neo4j e sem Ollama) é o que vai para o ACR. Não coloque senha no Dockerfile. Não habilite anonymous pull.

```bash
docker build --platform linux/amd64 -f Dockerfile api/ -t "$ACR_LOGIN_SERVER/veti-rag:latest"
az acr login --name "$ACR_NAME"
docker push "$ACR_LOGIN_SERVER/veti-rag:latest"
```

Em produção, `NEO4J_URI` e `OLLAMA_BASE_URL` entram como variáveis de ambiente.

Stack alinhada ao tutorial [neo4j-ai-experiments](https://github.com/ErickWendel/neo4j-ai-experiments): Node 22, `@langchain/community@0.3.28`, `@langchain/core@0.3.37`, `@langchain/ollama@0.1.5`, `neo4j-driver@5.28.0`.
