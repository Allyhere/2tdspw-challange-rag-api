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
    phone: z.string().min(1).optional(),
  }),
  pet: conversationPetSchema,
  carePlan: z.array(carePlanItemSchema).min(1),
  channel: z.enum(["api", "whatsapp", "telegram"]).default("api"),
});

export const inboundMessageSchema = z.object({
  text: z.string().min(1),
  providerMessageId: z.string().min(1).optional(),
});

export const llmTurnSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(["invite", "accept", "decline", "question", "other"]),
});
