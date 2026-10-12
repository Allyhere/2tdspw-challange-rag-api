import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  carePlanResponseSchema,
  conversationIntakeSchema,
  conversationListResponseSchema,
  conversationListSchema,
  conversationResponseSchema,
  conversationStartResponseSchema,
  errorResponseSchema,
  inboundMessageSchema,
  petInputSchema,
} from "./schema.js";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Firebase ID token",
  description:
    "Token retornado por Firebase Authentication. Vets usam login por e-mail; tutores usam login por telefone.",
});

const errorResponse = registry.register("ErrorResponse", errorResponseSchema);
const petInput = registry.register("PetInput", petInputSchema);
const carePlanResponse = registry.register(
  "CarePlanResponse",
  carePlanResponseSchema,
);
const conversationIntake = registry.register(
  "ConversationIntake",
  conversationIntakeSchema,
);
const conversationStart = registry.register(
  "ConversationStartResponse",
  conversationStartResponseSchema,
);
const conversationList = registry.register(
  "ConversationListResponse",
  conversationListResponseSchema,
);
const conversation = registry.register(
  "Conversation",
  conversationResponseSchema,
);
const inboundMessage = registry.register(
  "InboundMessage",
  inboundMessageSchema,
);
const conversationId = registry.registerParameter(
  "ConversationId",
  z.string().min(1).openapi({
    param: { name: "id", in: "path" },
    example: "3a5e52d2-c62b-47af-9f8d-a12d92f31893",
  }),
);

const healthResponse = registry.register(
  "HealthResponse",
  z.object({
    ok: z.literal(true),
    provider: z.literal("gemini"),
    chatModel: z.string(),
    embedModel: z.string(),
  }),
);

const ingestRequest = registry.register(
  "IngestRequest",
  z.object({ force: z.boolean().optional() }),
);

const ingestResponse = registry.register(
  "IngestResponse",
  z
    .object({
      treatments: z.number().int(),
      ingested: z.array(z.string()),
      skipped: z.array(z.string()),
      removed: z.number().int(),
      chunksWritten: z.number().int(),
    })
    .passthrough(),
);

function jsonResponse(description, schema) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

function jsonRequest(schema) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

const standardAuthErrors = {
  401: jsonResponse("Token Firebase ausente, inválido ou expirado.", errorResponse),
  403: jsonResponse("Papel ou origem não permitidos.", errorResponse),
  429: {
    ...jsonResponse("Limite por Firebase UID e IP excedido.", errorResponse),
    headers: {
      "Retry-After": {
        description: "Segundos até uma nova tentativa.",
        schema: { type: "integer" },
      },
    },
  },
};

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Operação"],
  summary: "Verificar saúde da API",
  responses: {
    200: jsonResponse("API disponível e modelos configurados.", healthResponse),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/care-plan",
  tags: ["Plano de cuidados"],
  summary: "Gerar plano de cuidados grounded no catálogo",
  request: { body: jsonRequest(petInput) },
  responses: {
    200: jsonResponse("Plano gerado somente com itens do catálogo.", carePlanResponse),
    400: jsonResponse("Pet inválido.", errorResponse),
    502: jsonResponse("Falha no retrieval ou no Gemini.", errorResponse),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/ingest",
  tags: ["Operação"],
  summary: "Reindexar catálogo e documentos",
  description:
    "Body vazio executa ingest incremental. force=true reindexa documentos mesmo sem alteração.",
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: ingestRequest } },
    },
  },
  responses: {
    200: jsonResponse("Resumo da ingestão.", ingestResponse),
    400: jsonResponse("Payload inválido.", errorResponse),
    502: jsonResponse("Falha na ingestão.", errorResponse),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/conversations",
  tags: ["Conversas"],
  summary: "Convidar tutor para uma etapa do plano",
  description:
    "Somente vets autenticados. O telefone E.164 deve pertencer a um tutor Firebase já cadastrado. A operação é idempotente por vet, tutor, pet e etapa.",
  security: [{ [bearerAuth.name]: [] }],
  request: { body: jsonRequest(conversationIntake) },
  responses: {
    200: jsonResponse("Conversa criada ou convite idempotente existente.", conversationStart),
    400: jsonResponse("Payload inválido.", errorResponse),
    ...standardAuthErrors,
    404: jsonResponse("Telefone sem tutor Firebase cadastrado.", errorResponse),
    502: jsonResponse("Falha ao criar a conversa.", errorResponse),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/conversations",
  tags: ["Conversas"],
  summary: "Listar caixa de entrada",
  description:
    "Retorna apenas conversas do Firebase UID autenticado, em updatedAt decrescente. O cursor é opaco.",
  security: [{ [bearerAuth.name]: [] }],
  request: { query: conversationListSchema },
  responses: {
    200: jsonResponse("Página de conversas com última mensagem.", conversationList),
    400: jsonResponse("Cursor ou limite inválido.", errorResponse),
    ...standardAuthErrors,
    502: jsonResponse("Falha ao listar conversas.", errorResponse),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/conversations/{id}",
  tags: ["Conversas"],
  summary: "Ler uma thread",
  description:
    "Somente o vet ou tutor vinculados. Um UID sem acesso recebe 404 para não revelar a existência da conversa.",
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ id: conversationId }) },
  responses: {
    200: jsonResponse("Snapshot e mensagens em ordem cronológica.", conversation),
    ...standardAuthErrors,
    404: jsonResponse("Conversa ausente ou invisível ao usuário.", errorResponse),
    502: jsonResponse("Falha ao ler conversa.", errorResponse),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/conversations/{id}/messages",
  tags: ["Conversas"],
  summary: "Enviar pergunta do tutor e obter resposta grounded",
  description:
    "Somente o tutor vinculado. Reutilize idempotencyKey apenas no retry da mesma ação.",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: conversationId }),
    body: jsonRequest(inboundMessage),
  },
  responses: {
    200: jsonResponse("Status atualizado e resposta do agente.", conversationStart),
    400: jsonResponse("Mensagem inválida.", errorResponse),
    ...standardAuthErrors,
    404: jsonResponse("Conversa ausente ou invisível ao tutor.", errorResponse),
    409: jsonResponse("Outro turno já está em processamento.", errorResponse),
    502: jsonResponse("Falha ao gerar resposta.", errorResponse),
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Veti GraphRAG API",
    version: "1.0.0",
    description:
      "Planos de cuidados grounded no catálogo e conversas autenticadas entre veterinário, tutor e agente.",
  },
  servers: [
    {
      url: "https://veti-rag-api.livelystone-4391080e.chilecentral.azurecontainerapps.io",
      description: "Azure Container Apps",
    },
    { url: "http://localhost:3000", description: "Desenvolvimento local" },
  ],
  tags: [
    { name: "Plano de cuidados" },
    { name: "Conversas" },
    { name: "Operação" },
  ],
});
