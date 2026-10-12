import { z } from "zod";

const examEntrySchema = z.object({
  name: z.string().min(1),
  date: z.string().min(1),
});

export const petInputSchema = z.object({
  name: z.string().min(1),
  breed: z.string().min(1),
  species: z.enum(["cachorro", "gato"]),
  sex: z.enum(["macho", "femea"]).or(z.literal("")),
  weight: z.number().positive(),
  age: z.number().min(0),
  isCastrated: z.boolean(),
  resumo: z.string().optional(),
  diagnostico: z.string().optional(),
  prescription: z.array(z.string()).optional(),
  exams: z.array(examEntrySchema).optional(),
  currentTreatments: z.array(z.string()).optional(),
});

function idFromUnknown(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return (
    value.id ??
    value.planItemName ??
    value.planItemName ??
    value.nome ??
    value.name ??
    ""
  );
}

export const llmCarePlanSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return { ids: [] };
  const obj = value;
  if (Array.isArray(obj.ids) || Array.isArray(obj.carePlanIds)) {
    return { ids: (obj.ids ?? obj.carePlanIds).map(String) };
  }
  const items = obj.carePlan ?? obj.itens ?? obj.items;
  if (Array.isArray(items)) {
    return { ids: items.map(idFromUnknown).filter(Boolean) };
  }
  return { ids: [] };
}, z.object({
  ids: z.array(z.string()).default([]),
}));

export const carePlanItemSchema = z.object({
  planItemName: z.string().min(1),
  planRecurrency: z.enum(["single", "recurrent"]),
  planRecurrencyRate: z.number().optional(),
  planDurationInMonths: z.number(),
});

export const carePlanResponseSchema = z.object({
  carePlanDescription: z.string().min(1),
  carePlan: z.array(carePlanItemSchema).min(1),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string().optional(),
      publisher: z.string().optional(),
    }),
  ),
});

export const conversationPetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  breed: z.string().min(1),
  species: z.enum(["cachorro", "gato"]),
  sex: z.enum(["macho", "femea"]).or(z.literal("")).optional(),
  weight: z.number().positive().optional(),
  age: z.number().min(0).optional(),
});

export const conversationIntakeSchema = z.object({
  tutor: z.object({
    name: z.string().min(1),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use telefone no formato E.164"),
  }),
  pet: conversationPetSchema,
  planStep: carePlanItemSchema.extend({
    id: z.string().min(1),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
  }),
  channel: z.enum(["api", "whatsapp", "telegram"]).default("api"),
});

export const inboundMessageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().min(8).max(128),
  providerMessageId: z.string().min(1).optional(),
});

export const conversationListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export const conversationStatusSchema = z.enum([
  "invited",
  "accepted",
  "declined",
]);

export const publicMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["assistant", "user"]),
  text: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  providerMessageId: z.string().optional(),
});

export const conversationStartResponseSchema = z.object({
  id: z.string(),
  status: conversationStatusSchema,
  message: publicMessageSchema,
});

export const conversationResponseSchema = z.object({
  id: z.string(),
  status: conversationStatusSchema,
  channel: z.enum(["api", "whatsapp", "telegram"]),
  tutor: conversationIntakeSchema.shape.tutor,
  pet: conversationPetSchema,
  carePlan: z.array(carePlanItemSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  messages: z.array(publicMessageSchema),
});

export const conversationSummarySchema = z.object({
  id: z.string(),
  status: conversationStatusSchema,
  channel: z.enum(["api", "whatsapp", "telegram"]),
  tutor: conversationIntakeSchema.shape.tutor,
  pet: conversationPetSchema,
  planStep: carePlanItemSchema.extend({ id: z.string() }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  lastMessage: publicMessageSchema.nullable(),
});

export const conversationListResponseSchema = z.object({
  items: z.array(conversationSummarySchema),
  nextCursor: z.string().nullable(),
});

export const errorResponseSchema = z.object({
  message: z.string(),
  issues: z.unknown().optional(),
});

export const llmTurnSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(["invite", "accept", "decline", "question", "other"]),
});
