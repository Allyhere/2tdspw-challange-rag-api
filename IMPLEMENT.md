# Integração de conversas autenticadas

API implantada:

`https://veti-rag-api.livelystone-4391080e.chilecentral.azurecontainerapps.io`

Este documento cobre somente a integração dos consumidores. A API identifica o veterinário e o tutor pelo Firebase ID token do mesmo projeto. O telefone serve para localizar um tutor já cadastrado; autorização posterior usa o UID imutável.

## Soluções avaliadas

### 1. API síncrona + Neo4j

É a solução implementada. Mantém catálogo, RAG e conversa no mesmo serviço, sem recurso adicional. O vet cria um convite idempotente para uma etapa; o tutor consulta a caixa por `updatedAt` e envia a pergunta; a resposta do agente volta na mesma chamada.

Para 300 usuários/dia, esta é a menor arquitetura adequada. O cliente deve apresentar a mensagem enviada de forma otimista e indicar que o agente está respondendo. Escala a zero pode causar cold start, portanto 1 segundo é objetivo de feedback visual do cliente, não garantia para a resposta completa do modelo.

### 2. Azure Queue Storage + worker

O endpoint gravaria a mensagem e retornaria `202`; um worker geraria a resposta e o cliente consultaria o status. Esta opção oferece retry e poison queue, mas introduz entrega assíncrona e não fornece atualização push sozinha. Azure Queue Storage é pay-as-you-go e barato, porém não tem gratuidade permanente garantida. Um worker em Container Apps pode escalar a zero.

Adote quando houver throttling sustentado do Gemini, necessidade de concluir respostas após o encerramento da requisição ou backlog observável. Use chave idempotente de negócio, visibility timeout maior que o processamento, limite de tentativas e poison queue.

### 3. Firestore em tempo real + API para RAG

Conversa e mensagens ficam no Firestore; listeners entregam alterações aos dois clientes, e esta API continua responsável por autorização, grounding e geração. É a melhor escolha para entrega push próxima de 1 segundo. A cota gratuita padrão inclui 50 mil reads e 20 mil writes por dia, suficiente para 300 usuários se os listeners forem paginados.

O custo é manter dois datastores, regras Firestore, índices e recuperação de turnos incompletos. Migre para esta opção se atualização push for requisito obrigatório, e não apenas mensagem otimista seguida da resposta HTTP.

## Contrato implementado

Todas as rotas abaixo exigem:

```http
Authorization: Bearer <Firebase ID token>
```

### Criar convite como veterinário

```http
POST /v1/conversations
Content-Type: application/json
```

```json
{
  "tutor": {
    "name": "Ana",
    "phone": "+5511999999999"
  },
  "pet": {
    "id": "pet-123",
    "name": "Thor",
    "breed": "Labrador",
    "species": "cachorro"
  },
  "planStep": {
    "id": "appointment-456",
    "planItemName": "V10",
    "planRecurrency": "recurrent",
    "planRecurrencyRate": 12,
    "planDurationInMonths": 60,
    "scheduledAt": "2026-11-10T14:00:00-03:00"
  },
  "channel": "api"
}
```

`pet.id` e `planStep.id` são ids estáveis do backend principal. Repetir vet, tutor, pet e etapa devolve a mesma conversa sem outro convite. Telefone deve ser E.164 e existir no Firebase.

### Listar a caixa autenticada

```http
GET /v1/conversations?limit=20&cursor=<opaque>
```

```json
{
  "items": [
    {
      "id": "conversation-id",
      "status": "invited",
      "channel": "api",
      "tutor": { "name": "Ana", "phone": "+5511999999999" },
      "pet": {
        "id": "pet-123",
        "name": "Thor",
        "breed": "Labrador",
        "species": "cachorro"
      },
      "planStep": {
        "id": "appointment-456",
        "planItemName": "V10",
        "planRecurrency": "recurrent",
        "planRecurrencyRate": 12,
        "planDurationInMonths": 60
      },
      "createdAt": "2026-10-12T18:00:00.000Z",
      "updatedAt": "2026-10-12T18:05:00.000Z",
      "agentEnabled": true,
      "lastMessage": {
        "id": "message-id",
        "role": "assistant",
        "text": "…",
        "createdAt": "2026-10-12T18:05:00.000Z"
      }
    }
  ],
  "nextCursor": null
}
```

O cursor é opaco. Não derive nem altere seu conteúdo.

### Ler a thread

```http
GET /v1/conversations/{conversationId}
```

Somente o tutor e o vet vinculados recebem a conversa. Outros UIDs recebem `404`, evitando revelar a existência do id.

### Enviar pergunta como tutor

```http
POST /v1/conversations/{conversationId}/messages
Content-Type: application/json
```

```json
{
  "text": "O que é a V10?",
  "idempotencyKey": "web-018f4f1a-5e18-7b28-a9d0"
}
```

Use uma chave nova por ação do usuário e reutilize-a apenas em retry da mesma ação. `409` indica que já existe outro turno sendo gerado; `429` inclui `Retry-After`. Enquanto `agentEnabled` é `true`, a resposta inclui a mensagem do agente. Depois que o vet assume, a mesma rota grava `role: "user"` e não chama o modelo. Token de vet recebe `403`.

### Veterinário assume a conversa

```http
POST /v1/conversations/{conversationId}/vet-messages
Content-Type: application/json
```

```json
{
  "text": "Olá, aqui é a clínica.",
  "idempotencyKey": "vet-018f4f1a-5e18-7b28-a9d0"
}
```

Somente o vet vinculado. A mensagem é gravada com `role: "vet"`. A primeira desliga o agente (`agentEnabled: false`) sem alterar `invited`, `accepted` ou `declined`. Não há chamada ao modelo nem mensagem do agente. Repetir a mesma `idempotencyKey` devolve a mensagem original. Token de tutor recebe `403`. Conversa desconhecida recebe `404`.

## Ordem de rollout

1. Configurar `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` e `CORS_ORIGINS` no Container App.
2. Publicar esta API e validar `/health`.
3. Implementar e publicar o cliente do veterinário.
4. Criar um convite de teste para um telefone Firebase já cadastrado.
5. Implementar e publicar o cliente do tutor.
6. Validar isolamento entre dois tutores, retry idempotente, aceite, recusa e pergunta sobre a etapa.

## Prompt 1 — aplicativo do veterinário

```text
Implemente a integração de convite de plano em:
/Users/camilo/code/Allyhere/2tdspw-challenge-ccgl-challenge-mobile

Contexto:
- É Expo/React Native com TanStack Query.
- O vet autentica no Firebase por e-mail/senha.
- A base RAG já vem de EXPO_PUBLIC_RAG_API_URL. Em produção ela é https://veti-rag-api.livelystone-4391080e.chilecentral.azurecontainerapps.io.
- O cliente atual de src/services/api/client.ts só anexa Firebase token à API principal. Para esta integração, crie um cliente RAG autenticado que também envie `Authorization: Bearer ${await user.getIdToken()}`.
- Não altere a geração de plano existente.

Objetivo:
Na tela em que o vet confirma ou aciona uma etapa já atribuída do plano, permitir “Convidar tutor”. Envie POST /v1/conversations com:
- tutor.name e tutor.phone; normalize o telefone para E.164 antes de enviar;
- pet.id, name, breed e species;
- planStep.id estável e os campos exatos planItemName, planRecurrency, planRecurrencyRate quando existir, planDurationInMonths e scheduledAt quando existir;
- channel "api".

Requisitos:
1. Nunca envie vet UID ou owner UID no body; a API deriva ambos do Firebase.
2. Não invente recorrência ou duração. Se a tela tiver apenas uma appointment expandida sem esses campos, preserve esses dados no estado de navegação a partir do CarePlanItem que originou a atribuição ou carregue-os do backend principal. Bloqueie o convite com uma mensagem clara se os dados exatos não existirem.
3. A operação já é idempotente por vet+tutor+pet+planStep. Desabilite o botão durante a mutation e trate retries como o mesmo convite.
4. Trate 404 como “o tutor precisa se cadastrar com este telefone”, 401 como sessão expirada, 403 como papel inválido, 429 respeitando Retry-After e falhas de rede com retry explícito.
5. Mostre confirmação contendo o texto retornado em message.text. Não abra WhatsApp.
6. Invalide queries relacionadas ao pet/plano após sucesso, sem guardar Firebase tokens.
7. Reuse padrões de src/services/ai/ai.service.ts, src/services/ai/useCarePlan.ts e TanStack Query. Mantenha os tipos e schemas próximos do cliente de conversas.
8. Adicione testes para body, bearer token, telefone E.164, sucesso idempotente e estados 404/429. Execute typecheck/lint disponíveis.

Contrato de sucesso:
{ "id": string, "status": "invited" | "accepted" | "declined", "message": { "id": string, "role": "assistant", "text": string, "createdAt": string } }

Não modifique o repositório da API. Entregue um resumo dos arquivos alterados e dos comandos de verificação.
```

## Prompt 2 — aplicativo do tutor

```text
Implemente a caixa de mensagens e perguntas em:
/Users/camilo/code/Allyhere/2tdspw-challange-front-user

Contexto:
- É React/Vite/TypeScript com Firebase Phone Auth, TanStack Query e react-aria-components.
- A base principal VITE_API_URL continua atendendo /owner. Não a substitua.
- Adicione VITE_RAG_API_URL com default https://veti-rag-api.livelystone-4391080e.chilecentral.azurecontainerapps.io.
- Toda chamada de conversa deve enviar `Authorization: Bearer ${await currentUser.getIdToken()}`.
- ConversationPage e ChatPreview usam clinicMessages estático hoje; remova essa dependência.

Objetivo:
1. Consultar GET /v1/conversations?limit=20, ordenado pela API por updatedAt decrescente.
2. Mostrar o lastMessage no ChatPreview e uma caixa de entrada paginada quando houver mais de uma conversa.
3. Abrir GET /v1/conversations/{id}, mapear assistant para clinic, user para tutor, text para body e createdAt para sentAt.
4. Adicionar composer acessível em ConversationPage e enviar POST /v1/conversations/{id}/messages com text e uma idempotencyKey gerada uma vez por clique.

Requisitos:
- Crie helpers GET/POST para a API RAG sem mudar os helpers da API principal. Valide respostas com Zod.
- Use query keys contendo Firebase uid e conversation id. Nunca use telefone informado pelo cliente para filtrar: a API usa o UID do token.
- Faça update otimista da mensagem do tutor em menos de 1 segundo e mostre estado “A clínica está respondendo” até chegar a resposta HTTP. Em erro, marque a mensagem como falha e ofereça retry reutilizando a mesma idempotencyKey.
- Em 409, refaça a thread após um pequeno backoff. Em 429, respeite Retry-After. Em 401, peça nova autenticação.
- Não faça polling de 1 segundo. A implementação Neo4j síncrona atual não oferece push; refetch no foco da janela, ao abrir a rota, após mutation e opcionalmente em intervalo moderado enquanto a página estiver visível.
- Não persista queries de conversa no cache IndexedDB de sete dias. Continue persistindo somente owner-profile e treatment-plan, a menos que seja adicionada criptografia específica.
- Use Form, TextField/Input e Button de react-aria-components; mantenha foco, aria-live para envio/resposta e comportamento de teclado acessível.
- Limite o texto no cliente a 2.000 caracteres, desabilite envio vazio/duplicado e preserve mensagens anteriores durante mutation.
- Atualize ChatPreview e ConversationPage para loading, vazio, offline, erro e retry.
- Adicione testes de schema/mapeamento, paginação, envio otimista, retry idempotente, isolamento das query keys e estados 401/409/429. Rode lint e o script de acessibilidade existente.

Respostas relevantes:
- GET lista: { items: ConversationSummary[], nextCursor: string | null }
- POST mensagem: { id: string, status: "invited" | "accepted" | "declined", message: PublicMessage }
- PublicMessage: { id, role: "assistant" | "user" | "vet", text, createdAt, providerMessageId? }
- Conversation e cada item da caixa incluem agentEnabled: boolean

Não modifique o repositório da API. Entregue um resumo dos arquivos alterados e dos comandos de verificação.
```
