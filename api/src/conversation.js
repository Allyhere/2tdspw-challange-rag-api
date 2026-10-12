import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiEmbed, geminiGenerateJson } from "./gemini.js";
import { findTreatmentsByNames, searchGuidelineChunks } from "./neo4j.js";
import { llmTurnSchema } from "./schema.js";
import { createNeo4jConversationStore } from "./conversationStore.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const promptTemplate = readFileSync(join(rootDir, "prompts/careInvite.md"), "utf8");
const catalogNomes = readFileSync(join(rootDir, "data/clinica-catalogo.csv"), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split(",")[1])
  .filter(Boolean);

export const TURN_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    intent: {
      type: "STRING",
      enum: ["invite", "accept", "decline", "question", "other"],
    },
  },
  required: ["reply", "intent"],
};

function splitPrompt(template) {
  const marker = "\n---USER---\n";
  const index = template.indexOf(marker);
  if (index === -1) {
    return { system: "", user: template.trim() };
  }
  return {
    system: template.slice(0, index).replace(/^---SYSTEM---\n/, "").trim(),
    user: template.slice(index + marker.length).trim(),
  };
}

function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("A resposta do modelo não contém JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function formatHistory(messages) {
  if (!messages?.length) return "(sem mensagens)";
  return messages
    .map((message) => `${message.role}: ${message.body}`)
    .join("\n");
}

function formatChunks(chunks) {
  if (!chunks?.length) return "(nenhum trecho)";
  return chunks
    .map((chunk) => {
      const title = chunk.titulo ? `${chunk.titulo}: ` : "";
      return `- ${title}${chunk.texto}`;
    })
    .join("\n");
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function planNames(carePlan) {
  return (carePlan ?? []).map((item) => item.planItemName).filter(Boolean);
}

function replyNamesOffPlan(reply, carePlan) {
  const haystack = ` ${normalizeName(reply)} `;
  const allowed = new Set(planNames(carePlan).map(normalizeName));
  return catalogNomes.some((nome) => {
    const name = normalizeName(nome);
    if (!name || allowed.has(name)) return false;
    return haystack.includes(` ${name} `);
  });
}

function treatmentsFromPlan(carePlan) {
  return (carePlan ?? []).map((item) => ({
    nome: item.planItemName,
    recorrencia: item.planRecurrency,
    intervaloMeses: item.planRecurrencyRate ?? null,
    duracaoPadraoMeses: item.planDurationInMonths,
  }));
}

function fillPrompt(context) {
  const intake = context.intake;
  return promptTemplate
    .replace("{tutor}", JSON.stringify(intake.tutor, null, 2))
    .replace("{pet}", JSON.stringify(intake.pet, null, 2))
    .replace("{carePlan}", JSON.stringify(intake.carePlan, null, 2))
    .replace("{treatments}", JSON.stringify(context.treatments ?? [], null, 2))
    .replace("{status}", context.status ?? "invited")
    .replace("{history}", formatHistory(context.history))
    .replace("{inbound}", context.inboundText?.trim() || "(convite inicial)")
    .replace("{chunks}", formatChunks(context.chunks));
}

export async function defaultGenerateTurn(context) {
  const { system, user } = splitPrompt(fillPrompt(context));
  const raw = await geminiGenerateJson({
    system,
    user,
    responseSchema: TURN_SCHEMA,
    maxOutputTokens: 1024,
  });
  return llmTurnSchema.parse(extractJson(raw));
}

export async function defaultRetrieveChunks(text) {
  const [embedding] = await geminiEmbed([text], "RETRIEVAL_QUERY");
  return searchGuidelineChunks(embedding);
}

export async function defaultLoadTreatments(names) {
  return findTreatmentsByNames(names);
}

function toPublicMessage(message) {
  if (!message) return null;
  const publicMessage = {
    id: message.id,
    role: message.role,
    text: message.body,
    createdAt: message.createdAt,
  };
  if (message.providerMessageId) {
    publicMessage.providerMessageId = message.providerMessageId;
  }
  return publicMessage;
}

function toPublicConversation(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    status: conversation.status,
    channel: conversation.channel,
    tutor: conversation.tutor,
    pet: conversation.pet,
    carePlan: conversation.carePlan,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: (conversation.messages ?? []).map(toPublicMessage),
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function notFound() {
  const error = new Error("Conversa não encontrada");
  error.status = 404;
  return error;
}

function nextStatus(current, intent) {
  if (current !== "invited") return current;
  if (intent === "accept") return "accepted";
  if (intent === "decline") return "declined";
  return current;
}

function carePlanFromStep(planStep) {
  return [
    {
      planItemName: planStep.planItemName,
      planRecurrency: planStep.planRecurrency,
      ...(planStep.planRecurrencyRate == null
        ? {}
        : { planRecurrencyRate: planStep.planRecurrencyRate }),
      planDurationInMonths: planStep.planDurationInMonths,
    },
  ];
}

function conversationKey({ vetUid, ownerUid, petId, planStepId }) {
  return createHash("sha256")
    .update([vetUid, ownerUid, petId, planStepId].join("\u001f"))
    .digest("hex");
}

function authorize(conversation, actor, { ownerOnly = false } = {}) {
  if (!actor) throw httpError(401, "Autenticação obrigatória");
  const isOwner =
    actor.role === "owner" && conversation.ownerFirebaseUid === actor.uid;
  const isVet = actor.role === "vet" && conversation.vetFirebaseUid === actor.uid;
  if (!isOwner && (!isVet || ownerOnly)) throw notFound();
}

function encodeCursor(conversation) {
  return Buffer.from(
    JSON.stringify({ updatedAt: conversation.updatedAt, id: conversation.id }),
  ).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed.updatedAt || !parsed.id) throw new Error();
    return parsed;
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

function toPublicSummary(conversation) {
  const messages = conversation.messages ?? [];
  return {
    id: conversation.id,
    status: conversation.status,
    channel: conversation.channel,
    tutor: conversation.tutor,
    pet: conversation.pet,
    planStep: {
      id: conversation.planStepId,
      ...conversation.carePlan[0],
    },
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessage: toPublicMessage(messages.at(-1) ?? null),
  };
}

export function createConversations({
  store,
  generateTurn = defaultGenerateTurn,
  retrieveChunks = defaultRetrieveChunks,
  loadTreatments = defaultLoadTreatments,
} = {}) {
  const conversationStore = store ?? createNeo4jConversationStore();

  async function start(intake, { actor, owner }) {
    if (actor?.role !== "vet") throw httpError(403, "Apenas veterinários podem convidar");
    const carePlan = carePlanFromStep(intake.planStep);
    const key = conversationKey({
      vetUid: actor.uid,
      ownerUid: owner.uid,
      petId: intake.pet.id,
      planStepId: intake.planStep.id,
    });
    const created = await conversationStore.create({
      key,
      vetFirebaseUid: actor.uid,
      ownerFirebaseUid: owner.uid,
      ownerPhone: owner.phone,
      tutor: intake.tutor,
      pet: intake.pet,
      carePlan,
      planStepId: intake.planStep.id,
      channel: intake.channel ?? "api",
      status: "invited",
    });
    const conversation = created.conversation;
    const appended = await conversationStore.appendMessage(conversation.id, {
      role: "assistant",
      body: `Oi ${intake.tutor.name}! O cuidado de ${intake.pet.name} é ${intake.planStep.planItemName}. Você aceita seguir com esta etapa do plano?`,
      channel: conversation.channel,
      dedupeKey: `${conversation.id}:invite`,
    });
    return {
      id: conversation.id,
      status: conversation.status,
      message: toPublicMessage(appended.message),
    };
  }

  async function handleInbound({
    conversationId,
    text,
    providerMessageId,
    idempotencyKey,
    actor,
  }) {
    const existing = await conversationStore.get(conversationId);
    if (!existing) throw notFound();
    authorize(existing, actor, { ownerOnly: true });

    const replyKey = `${conversationId}:out:${idempotencyKey}`;
    const previousReply = existing.messages.find(
      (message) => message.dedupeKey === replyKey,
    );
    if (previousReply) {
      return {
        id: conversationId,
        status: existing.status,
        message: toPublicMessage(previousReply),
      };
    }
    const acquired = await conversationStore.acquireTurn(
      conversationId,
      idempotencyKey,
    );
    if (!acquired) {
      throw httpError(409, "Já existe uma resposta sendo processada");
    }

    try {
      await conversationStore.appendMessage(conversationId, {
        role: "user",
        body: text,
        channel: existing.channel,
        providerMessageId: providerMessageId ?? null,
        dedupeKey: `${conversationId}:in:${idempotencyKey}`,
      });

      const withUser = await conversationStore.get(conversationId);
      let treatments = null;
      try {
        treatments = await loadTreatments(planNames(existing.carePlan));
      } catch (error) {
        console.warn("Tratamentos do plano indisponíveis:", error.message);
      }
      const rows = treatments?.length
        ? treatments
        : treatmentsFromPlan(existing.carePlan);

      let chunks = [];
      try {
        chunks = (await retrieveChunks(text)) ?? [];
      } catch (error) {
        console.warn("Busca de diretriz falhou:", error.message);
        chunks = [];
      }

      const names = planNames(existing.carePlan).join(", ");
      let reply;
      let intent;
      try {
        const turn = await generateTurn({
          kind: "reply",
          intake: {
            tutor: existing.tutor,
            pet: existing.pet,
            carePlan: existing.carePlan,
            channel: existing.channel,
          },
          status: existing.status,
          history: withUser.messages,
          inboundText: text,
          chunks,
          treatments: rows,
        });
        reply = turn.reply;
        intent = turn.intent;
      } catch (error) {
        console.warn("Chat falhou, respondendo com o plano:", error.message);
        reply = `${names}. Este chat não agenda horário. A clínica confirma o dia.`;
        intent = null;
      }

      if (intent === "accept") {
        reply = `${names}. Este chat não agenda horário. A clínica confirma o dia.`;
      } else if (intent && replyNamesOffPlan(reply, existing.carePlan)) {
        reply = `Os cuidados deste plano são ${names}. Qualquer outro a clínica precisa confirmar.`;
      }

      const status = nextStatus(existing.status, intent);
      if (status !== existing.status) {
        await conversationStore.updateStatus(conversationId, status);
      }

      const appended = await conversationStore.appendMessage(conversationId, {
        role: "assistant",
        body: reply,
        channel: existing.channel,
        dedupeKey: replyKey,
      });
      return {
        id: conversationId,
        status,
        message: toPublicMessage(appended.message),
      };
    } finally {
      await conversationStore.releaseTurn(conversationId, idempotencyKey);
    }
  }

  async function get(conversationId, actor) {
    const conversation = await conversationStore.get(conversationId);
    if (conversation) authorize(conversation, actor);
    return toPublicConversation(conversation);
  }

  async function list({ actor, limit, cursor }) {
    if (!actor) throw httpError(401, "Autenticação obrigatória");
    const identityField =
      actor.role === "owner" ? "ownerFirebaseUid" : "vetFirebaseUid";
    const rows = await conversationStore.list({
      identityField,
      uid: actor.uid,
      limit: limit + 1,
      cursor: decodeCursor(cursor),
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map(toPublicSummary),
      nextCursor: hasMore ? encodeCursor(items.at(-1)) : null,
    };
  }

  return { start, handleInbound, get, list };
}
