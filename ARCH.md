# Architecture — GraphRAG care plan API

This document describes the **current POC** (Express + Neo4j + Gemini) and a **scalable target** that keeps the same product invariant: the model never invents a treatment, exam, or interval. Plan items come only from the clinic catalog; recurrence and duration come from `Treatment` nodes, not from generated text.

Operational how-to lives in [README.md](README.md). Document authoring rules live in [docs-template.md](docs-template.md) and [AGENTS.md](AGENTS.md).

---

## 1. System context

The API sits between a veterinary client (mobile app, `curl`, later WhatsApp/Telegram) and two backends: a **graph of clinic knowledge** and a **hosted LLM**.

```mermaid
C4Context
    title System context — POC GraphRAG
    Person(tutor, "Tutor / clinic staff", "Asks for a care plan or answers the invite")
    System(api, "Care plan API", "Validates input, retrieves catalog + guidelines, grounds LLM output")
    System_Ext(gemini, "Google Gemini", "gemini-embedding-001 (768-d) and gemini-3.5-flash-lite")
    System_Ext(client, "Client app", "Expo / HTTP; WhatsApp and Telegram later")
    SystemDb(neo4j, "Neo4j 5.26", "Treatments, guideline chunks, cache, conversations")

    Rel(tutor, client, "Uses")
    Rel(client, api, "POST /v1/care-plan, /v1/conversations")
    Rel(api, neo4j, "Cypher + vector index")
    Rel(api, gemini, "embed + generateContent (JSON schema)")
```

**What the system is allowed to do**

- Choose **ids** that already exist in `api/data/clinica-catalogo.csv`.
- Copy recurrence, interval, and duration from the matching `Treatment`.
- Cite guideline `Source` metadata (title, URL, publisher) retrieved by vector search.
- Invite the tutor and answer questions **only** about items already in the sent plan.

**What the system must not do**

- Invent a product, vaccine, exam, or interval that is not in the catalog.
- Use managed File Search / hosted RAG as the planner (it would hallucinate off-catalog items).
- Treat the LLM as source of truth for schedule fields.

---

## 2. Containers (current POC)

Docker Compose runs three local pieces. Gemini is external. There is no Ollama.

```mermaid
flowchart LR
    subgraph clients [Clients]
        App[App / curl]
    end

    subgraph compose [docker-compose]
        API["api :3000<br/>Express, Node 22"]
        Seed["seed<br/>one-shot ingest"]
        Neo[("neo4j :7687 / :7474<br/>community")]
        Data["./api/data<br/>CSV + docs/*.md"]
    end

    Gemini["Gemini API<br/>embed + flash-lite"]

    App -->|HTTP| API
    Seed -->|runIngest| Neo
    Seed -->|batchEmbedContents| Gemini
    API -->|Bolt| Neo
    API -->|REST| Gemini
    Data -.->|volume :ro /app/data| API
    Data -.->|volume :ro /app/data| Seed
    Seed -->|must finish| API
```

| Container | Role | Scale characteristic |
| --- | --- | --- |
| **api** | HTTP, Zod validation, GraphRAG orchestration, conversation engine, ingest endpoint | One process, pool of 10 Bolt connections |
| **neo4j** | Catalog graph, cosine vector index `guideline_index`, demographic cache, conversation store | Single Community instance, volume `neo4j_data` |
| **seed** | Waits for Neo4j + Gemini, calls `runIngest`, exits | Blocks API start (`service_completed_successfully`) |
| **Gemini** | Embeddings (`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`, L2-normalized 768-d) and JSON chat | Shared SaaS quota; on the request path |

The API holds **no clinical state in memory**. Knowledge and catalog live in the graph. Tests swap the conversation store for an in-memory map.

---

## 3. Code map

```mermaid
flowchart TB
    index["src/index.js<br/>listen / SIGTERM"]
    app["src/app.js<br/>routes"]
    rag["src/rag.js<br/>care-plan pipeline"]
    conv["src/conversation.js<br/>invite + turns"]
    store["src/conversationStore.js"]
    ingest["src/ingest.js"]
    neo["src/neo4j.js"]
    gem["src/gemini.js"]
    schema["src/schema.js<br/>Zod"]
    cfg["src/config.js"]
    p1["prompts/carePlan.md"]
    p2["prompts/careInvite.md"]

    index --> app
    app --> rag
    app --> conv
    app --> ingest
    app --> schema
    rag --> neo
    rag --> gem
    rag --> p1
    conv --> store
    conv --> gem
    conv --> neo
    conv --> p2
    ingest --> neo
    ingest --> gem
    neo --> cfg
    gem --> cfg
    store --> neo
```

| Path | Responsibility |
| --- | --- |
| `api/src/index.js` | HTTP listen; timeouts disabled (LLM can be slow); close Bolt on shutdown |
| `api/src/app.js` | `/health`, `/v1/care-plan`, `/v1/ingest`, `/v1/conversations` |
| `api/src/rag.js` | Cache → parallel embed + Cypher catalog → vector kNN → LLM ids → ground → describe |
| `api/src/conversation.js` | Start invite; inbound intent → `accepted` / `declined`; RAG on questions |
| `api/src/conversationStore.js` | Neo4j `Conversation`/`Message`; memory store for tests |
| `api/src/ingest.js` | Upsert CSV; hash-skip markdown; chunk >40 chars; invalidate cache |
| `api/src/neo4j.js` | Treatment filter, vector query, `CachedCarePlan` |
| `api/src/gemini.js` | REST `generateContent` + `batchEmbedContents` (batch 16) |
| `api/src/schema.js` | Pet, LLM ids, conversation intake, turn `{ reply, intent }` |
| `api/data/clinica-catalogo.csv` | Allowed menu (stable `id`) |
| `api/data/docs/*.md` | Breed-specific and global guidelines |
| `scripts/harvest-allowlist.mjs` | Prints candidate URLs; does not crawl |

---

## 4. Graph data model

Neo4j is used as **three stores in one**: a small applicability graph, a vector RAG corpus, and a document-ish OLTP store for chats and cache.

```mermaid
erDiagram
    Treatment {
        string id PK
        string nome
        string tipo
        string especie
        string recorrencia
        int intervaloMeses
        int duracaoPadraoMeses
        float idadeMinAnos
        float idadeMaxAnos
        float pesoMinKg
        float pesoMaxKg
        bool somenteNaoCastrado
    }
    Source {
        string url PK
        string titulo
        string editora
        string file
        string raca
        string especie
        string contentHash
    }
    GuidelineChunk {
        string texto
        float[] embedding
    }
    CachedCarePlan {
        string key PK
        string payload
        string breed
        string species
        datetime createdAt
    }
    Conversation {
        string id PK
        string key UK
        string vetFirebaseUid
        string ownerFirebaseUid
        string ownerPhone
        string planStepId
        string status
        string channel
        string tutorJson
        string petJson
        string carePlanJson
        datetime createdAt
        datetime updatedAt
    }
    Message {
        string id PK
        string dedupeKey UK
        string role
        string body
        string channel
        string providerMessageId
        datetime createdAt
    }

    GuidelineChunk ||--o| Source : FROM
    Message }o--|| Conversation : IN
```

```mermaid
flowchart LR
    T["(:Treatment)"]
    C["(:GuidelineChunk)"]
    S["(:Source)"]
    Cache["(:CachedCarePlan)"]
    M["(:Message)"]
    Conv["(:Conversation)"]

    C -->|FROM| S
    M -->|IN| Conv
```

Constraints and indexes created at ingest / first cache / first conversation:

- `treatment_id` unique on `Treatment.id`
- vector index `guideline_index` on `GuidelineChunk.embedding` (768-d, cosine)
- `cached_care_plan_key` unique on `CachedCarePlan.key`
- `conversation_id`, `conversation_key`, `message_id`, `message_dedupe_key` unique
- composite indexes on owner/vet Firebase UID with `updatedAt`

There is **no** relationship between `Treatment` and `GuidelineChunk`. Linking is done in the application: Cypher filters the menu; the vector index retrieves prose; the LLM picks ids; the API joins them.

`Conversation` stores display snapshots for tutor, pet, and plan as JSON, but authorization and inbox lookup use first-class verified Firebase UIDs. Existing anonymous nodes are legacy and never appear in authenticated inboxes.

---

## 5. Care-plan pipeline

`POST /v1/care-plan` is a **retrieve-then-rank-then-ground** pipeline. Server-Timing reports `cache`, `embed`, `vector`, `catalog`, `llm`, `post`, `total`.

```mermaid
sequenceDiagram
    actor Client
    participant API as ExpressRag
    participant Cache as CachedCarePlan
    participant Gemini
    participant Neo as Neo4j

    Client->>API: POST care-plan
    alt no consulta context
        API->>Cache: lookup demographic cache
        Cache-->>API: hit or miss
        opt cache hit
            API-->>Client: cached plan with sources
        end
    else consulta context present
        Note over API: cache bypass
    end

    par retrieval
        API->>Gemini: embed pet query
        Gemini-->>API: 768-d L2 vector
        API->>Neo: filter treatments for pet
        Neo-->>API: eligible catalog
    end

    API->>Neo: vector query guideline chunks
    Neo-->>API: chunks with Source

    API->>Gemini: generate JSON ids temperature 0
    Gemini-->>API: catalog ids

    API->>API: ground ids to Treatment fields
    alt no valid ids
        API->>API: first 8 Cypher treatments
    end
    API->>Cache: save payload when cacheable
    API-->>Client: description plan with sources
```

### Query text (embedding)

Built in `buildPetQuery`:

```text
{species} da raça {breed}, {weight}kg, {age} anos, {sexo}, {castrado}
. Resumo da consulta: …
. Diagnóstico: …
. Prescrição: …
. Exames: …
```

Breed docs are written so chunks start with `Cachorro da raça Labrador` / `Gato da raça Persa`, matching that query shape.

### Three grounding layers

```mermaid
flowchart TB
    subgraph L1 [1. Structured filter]
        Cypher["Cypher: species / age / weight / castration"]
    end
    subgraph L2 [2. Prompt contract]
        Prompt["carePlan.md: copy catalog ids only"]
        Schema["Gemini responseSchema { ids: string[] }"]
    end
    subgraph L3 [3. Application grounding]
        Match["id exact → name normalize → substring"]
        Fields["recorrencia / intervalo / duração from Treatment"]
        Drop["unknown names discarded"]
        Fallback["empty plan → catalogAsPlan slice 8"]
    end

    Cypher --> Prompt
    Prompt --> Schema
    Schema --> Match
    Match --> Fields
    Fields --> Drop
    Drop --> Fallback
```

If the catalog filter returns nothing, the API returns **HTTP 502**. That is intentional: better to fail than to invent a menu.

---

## 6. Ingest pipeline

Knowledge is files on disk, not a crawl. `scripts/harvest-allowlist.mjs` only prints URLs on an allowlist.

```mermaid
flowchart TB
    CSV["clinica-catalogo.csv"]
    MD["docs/*.md"]
    Ingest["runIngest"]
    Idx["CONSTRAINT + VECTOR INDEX"]
    T["MERGE Treatment by id<br/>DELETE ids not in CSV"]
    Hash{"SHA-256 == Source.contentHash<br/>and not force?"}
    Emb["geminiEmbed chunks<br/>RETRIEVAL_DOCUMENT"]
    Chunks["replace GuidelineChunk<br/>FROM Source.url"]
    Inv["invalidate CachedCarePlan<br/>breed+species or ALL"]
    Orphan["delete Source not in keepUrls"]

    CSV --> Ingest
    MD --> Ingest
    Ingest --> Idx --> T
    T --> Hash
    Hash -->|yes| Skip[skip re-embed]
    Hash -->|no| Emb --> Chunks --> Inv
    Skip --> Orphan
    Inv --> Orphan
```

Chunking: split on blank lines, drop parts ≤ 40 characters. Typical file: 4–7 blocks, 80–500 characters.

Cache policy:

- Breed doc (`raca` + `especie` in front-matter) deletes `CachedCarePlan` for that pair.
- Global guideline (WSAVA, AAHA, antirrábica, dermatite) deletes **all** cached plans.

`POST /v1/ingest` with `{ "force": true }` re-embeds everything. Incremental ingest does **not** wipe the graph.

---

## 7. Conversation (care invite)

The care plan is generated first. The invite is a **second product**: the clinic already chose the next-month slice; the model must not enlarge it.

```mermaid
stateDiagram-v2
    [*] --> invited: POST /v1/conversations
    invited --> invited: intent question / other
    invited --> accepted: intent accept
    invited --> declined: intent decline
    accepted --> accepted: further messages keep status
    declined --> declined: further messages keep status
```

```mermaid
sequenceDiagram
    actor Vet
    actor Tutor
    participant Firebase
    participant API as ConversationAPI
    participant Gemini
    participant Neo as Neo4j
    participant Store as ConvStore

    Vet->>API: POST conversations with Firebase token
    API->>Firebase: verify vet and resolve owner phone
    API->>Store: persist conversation
    API-->>Vet: invited with first message

    Tutor->>API: GET conversations ordered by updatedAt
    API->>Firebase: verify owner token
    API->>Store: list by ownerFirebaseUid

    Tutor->>API: POST message with idempotency key
    API->>Store: persist user message
    API->>Gemini: embed inbound text
    API->>Neo: vector search chunks
    API->>Gemini: generate reply with intent
    API->>Store: persist assistant reply
    API-->>Tutor: updated status with message
```

The email/password Firebase identity is the vet; the phone Firebase identity is the tutor. Every thread stores exactly one of each. Channels `whatsapp` / `telegram` remain reserved; adapters are not implemented.

---

## 8. Deployment (current)

```mermaid
flowchart TB
    subgraph host [Single Docker host]
        LB["localhost:3000"]
        API["api replica × 1"]
        Seed["seed once"]
        Neo[("Neo4j volume")]
        Vol["bind mount api/data"]
    end
    Cloud["generativelanguage.googleapis.com"]

    LB --> API
    Seed --> Neo
    API --> Neo
    API --> Cloud
    Vol --> API
    Vol --> Seed
```

| Concern | POC choice |
| --- | --- |
| Auth | None |
| Multi-clinic | Single catalog |
| HA | None; API waits for seed then serves |
| Secrets | `.env` / Compose `env_file` |
| Observability | `console.log` + `Server-Timing` |
| Rate limits / retries | None around Gemini |
| Horizontal API | Not designed; cache and ingest share the same process |

---

## 9. Why this shape does not scale

The POC is the right size to prove GraphRAG **grounding**. These limits show up as soon as traffic, clinics, or corpus grow.

| Bottleneck | Why it hurts |
| --- | --- |
| **LLM on every miss** | Embed + `generateContent` sit on the HTTP thread. Latency, Gemini quota, and 502s couple to user-facing APIs. |
| **One Neo4j for everything** | Vector kNN, catalog MATCH, cache MERGE, and chat append share CPU, memory, and the same Community instance. Chat JSON blobs compete with ANN. |
| **Ingest on the API** | `POST /v1/ingest` embeds files in-process. A large reindex stalls care-plan traffic. |
| **Seed gates startup** | API cannot start until seed succeeds. Redeploys wait on Gemini. |
| **Coarse cache key** | Exact `weight` and `age` → near-zero reuse across similar pets. Global docs wipe the entire cache. |
| **Unfiltered vector search** | `queryNodes` is global; species/breed are not predicates on chunks. Noise grows with corpus size. |
| **No Treatment–chunk edges** | GraphRAG is “graph filter + vector”, not a true neighborhood expansion. Harder to explain “why this vaccine” from the graph alone. |
| **Sequential ingest writes** | One Cypher `CREATE` per chunk; embeddings batched at 16. Fine for ~8 markdown files, not for hundreds. |
| **No tenant isolation** | One CSV, one index, one cache namespace. |
| **Conversation as properties** | Cannot query “all Labrador invites last week” without parsing JSON; no TTL, no archival. |
| **Single replica, pool 10** | Session-per-query; no queue; no backpressure when Gemini slows. |
| **Sync channels** | WhatsApp webhooks need idempotency, retries, and a worker, not a blocking Express handler. |

---

## 10. Proposed scalable architecture

Keep the **grounding contract**. Change **where work runs**, **which store owns which workload**, and **when the LLM is called**.

### 10.1 Target context

```mermaid
C4Context
    title Target system context
    Person(tutor, "Tutor")
    Person(vet, "Clinic staff")
    System_Ext(wa, "WhatsApp / Telegram")
    System(platform, "Care platform", "Catalog-grounded plans + invite chat, multi-clinic")
    System_Ext(vertex, "Vertex AI / Gemini")
    System_Ext(obs, "Logs / traces / metrics")

    Rel(tutor, wa, "Messages")
    Rel(vet, platform, "HTTPS + auth")
    Rel(wa, platform, "Webhooks")
    Rel(platform, vertex, "embed + generate")
    Rel(platform, obs, "OTLP")
```

### 10.2 Target containers

```mermaid
flowchart TB
    subgraph edge [Edge]
        GW["API gateway<br/>auth, quota, WAF"]
    end

    subgraph compute [Stateless services]
        CP["care-plan service"]
        CH["conversation service"]
        CAT["catalog service"]
        AD["channel adapters<br/>WhatsApp / Telegram / HTTP"]
    end

    subgraph async [Async]
        Q["queue / pub-sub"]
        IW["ingest workers"]
        OBJ["object storage<br/>guidelines + CSV versions"]
    end

    subgraph data [Stores by workload]
        G[("Neo4j Aura<br/>Treatment graph + chunk-source")]
        V[("Vector index<br/>filtered ANN")]
        PG[("PostgreSQL<br/>conversations, tutors, pets")]
        R[("Redis<br/>plan cache + idempotency")]
    end

    Vertex["Vertex AI<br/>Gemini + embeddings"]

    GW --> CP
    GW --> CH
    GW --> CAT
    AD --> CH
    CP --> G
    CP --> V
    CP --> R
    CP --> Vertex
    CH --> PG
    CH --> V
    CH --> Vertex
    CH --> R
    CAT --> G
    CAT --> PG
    IW --> OBJ
    IW --> V
    IW --> G
    IW --> Vertex
    Q --> IW
    CP --> Q
```

| Piece | Replaces | Why |
| --- | --- | --- |
| **API gateway** | Naked `:3000` | Auth (clinic API keys / JWT), per-tenant rate limits, request id |
| **care-plan service** | `rag.js` inside the monolith | Horizontally scalable; no ingest; timeout + circuit breaker to Vertex |
| **conversation service** | `conversation.js` + Neo4j JSON | OLTP in Postgres; adapters own webhooks; idempotency on `providerMessageId` |
| **catalog service** | CSV bind-mount | Versioned menu per clinic; stable ids; publish event on change |
| **ingest workers** | `POST /v1/ingest` on the API | Re-embed off the request path; hash skip stays |
| **Neo4j Aura** | Local Community | HA; keep **applicability** graph and `(:Chunk)-[:FROM]->(:Source)` |
| **Dedicated vector index** | Same Neo4j ANN as chat/cache | Vertex AI Vector Search, pgvector, or Neo4j only if isolated from OLTP. Filter by `especie` / `raca` / `tenantId` at query time |
| **PostgreSQL** | `Conversation`/`Message` nodes | Threads, status, indexing, retention |
| **Redis** | `CachedCarePlan` nodes | TTL, bucketed demographic keys, tenant prefix, pub/sub invalidation |
| **Object storage** | Git-only `docs/*.md` as runtime source | Clinics upload; workers pull; SHA-256 still skip re-embed |

### 10.3 Stronger GraphRAG (same invariant)

Today the “graph” half is a `WHERE` on `Treatment`. A scalable version can still **forbid invention** while using edges for retrieval quality:

```mermaid
flowchart LR
    Pet[Pet profile] --> Rules[Eligibility subgraph]
    Rules --> Menu[Candidate Treatment ids]
    Pet --> ANN[Filtered vector search]
    ANN --> Chunks[GuidelineChunk]
    Chunks -->|MENTIONS / SUPPORTS| Menu
    Menu --> Rank[LLM ranks ids only]
    Rank --> Ground[Join Treatment attributes]
    Ground --> Plan[carePlan JSON]
```

Suggested edges (optional, additive):

- `(:GuidelineChunk)-[:MENTIONS]->(:Treatment)` when the paragraph cites the **exact CSV name**.
- `(:Source)-[:APPLIES_TO {especie, raca?}]->(:BreedProfile)` so ANN can be constrained before kNN.
- `(:Clinic)-[:OFFERS]->(:Treatment)` for multi-tenant menus.

The LLM still returns **ids ⊆ eligible set**. Recurrence still comes from `Treatment`.

### 10.4 Cache that actually hits

Replace exact weight/age in the SHA key with **buckets** (for example age bands and weight quartiles used by the catalog itself). Include `catalogVersion` and `embedModel` in the key so ingest invalidates precisely.

Consulta context (`diagnostico`, etc.) should use a **second cache** keyed by normalized diagnosis tokens + eligible treatment set, with a short TTL — not a full bypass forever.

### 10.5 Request path under load

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway
    participant CP as CarePlanSvc
    participant Redis
    participant Cat as CatalogGraph
    participant Vec as VectorIndex
    participant LLM as VertexAI

    Client->>GW: POST care-plan
    GW->>CP: authenticated tenant
    CP->>Redis: get plan cache
    alt cache hit
        CP-->>Client: 200
    else cache miss
        par
            CP->>Cat: eligible treatments
            CP->>LLM: embed query
        end
        CP->>Vec: filtered kNN search
        CP->>LLM: rank eligible ids only
        CP->>CP: ground to Treatment rows
        CP->>Redis: set cache
        CP-->>Client: 200
    end
```

Workers, not the HTTP process, own ingest:

```mermaid
flowchart LR
    Upload[guideline uploaded] --> Topic[ingest topic]
    Topic --> W[worker]
    W --> Hash{hash changed?}
    Hash -->|no| Ack[ack]
    Hash -->|yes| Emb[embed batch]
    Emb --> Vec[upsert vectors]
    Emb --> G[upsert Source/Chunk]
    G --> Inv[invalidate Redis keys]
```

### 10.6 Channels

```mermaid
flowchart LR
    WA[WhatsApp webhook] --> AD[adapter]
    TG[Telegram webhook] --> AD
    HTTP[POST /v1/conversations] --> CH[conversation svc]
    AD -->|idempotent providerMessageId| CH
    CH --> PG[(Postgres)]
    CH --> LLM[Vertex]
    CH --> Vec[guidelines ANN]
```

Adapters translate provider payloads into the existing `{ tutor, pet, carePlan }` / inbound text contract. The engine stays channel-agnostic — same as today’s `channel` enum, but with a queue so webhook timeouts do not wait on Gemini.

---

## 11. Comparison

| Dimension | POC (this repo) | Scalable target |
| --- | --- | --- |
| Process model | One Express + one Neo4j + one-shot seed | Gateway + 3 services + ingest workers |
| Catalog | CSV on disk | Versioned catalog service, per clinic |
| Guidelines | Markdown volume | Object storage + async embed |
| Retrieval | Global cosine k=8 | Filtered ANN + optional MENTIONS edges |
| Planner | Gemini ids + app grounding | Same contract; optional rules pre-rank |
| Cache | Neo4j node, exact demographics | Redis, buckets, catalog version |
| Chat | Neo4j JSON properties | Postgres + idempotent webhooks |
| LLM | Sync REST, no retry | Vertex, retries, circuit breaker, timeouts |
| Multi-tenant | No | `tenantId` on catalog, vectors, cache, chat |
| Startup | Blocked on seed | API healthy with last good index; ingest continues |
| Auth / quota | No | Gateway |
| Observability | Server-Timing | Traces per span: cache, embed, vector, llm, ground |

---

## 12. Migration (do not rewrite first)

The POC already has the hard part: **id-only generation + Treatment grounding**. Move in slices.

1. **Extract catalog reads** behind `findTreatmentsForPet` (already a seam). Serve the same CSV via an in-process module, then a service.
2. **Move conversations to Postgres** using `createNeo4jConversationStore` as the interface (`create` / `get` / `appendMessage` / `updateStatus`).
3. **Put ingest on a worker**; keep `runIngest` as the library. API `POST /v1/ingest` enqueues `{ force }`.
4. **Add Redis** in front of `getCachedCarePlan` / `saveCachedCarePlan` with bucketed keys.
5. **Filter vector search** by `especie` (and `raca` when present on `Source`) before or inside ANN.
6. **Run API replicas** once Neo4j (Aura) and Redis are shared and ingest is off-box.
7. **Channel adapters** last; persist `providerMessageId` unique per channel.

Invariant to preserve at every step: if the model emits an unknown id, the item is dropped; if nothing remains, use the Cypher/catalog eligible set or fail closed — never a free-text treatment name.
