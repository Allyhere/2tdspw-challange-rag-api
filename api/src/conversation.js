import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiEmbed, geminiGenerateJson } from "./gemini.js";
import { searchGuidelineChunks } from "./neo4j.js";
import { llmTurnSchema } from "./schema.js";
import { createNeo4jConversationStore } from "./conversationStore.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const promptTemplate = readFileSync(join(rootDir, "prompts/careInvite.md"), "utf8");

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

function fillPrompt(context) {
  const intake = context.intake;
  return promptTemplate
    .replace("{tutor}", JSON.stringify(intake.tutor, null, 2))
    .replace("{pet}", JSON.stringify(intake.pet, null, 2))
    .replace("{carePlan}", JSON.stringify(intake.carePlan, null, 2))
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

export function createConversations({
  store,
  generateTurn = defaultGenerateTurn,
  retrieveChunks = defaultRetrieveChunks,
} = {}) {
  const conversationStore = store ?? createNeo4jConversationStore();

  async function start(intake) {
    const turn = await generateTurn({
      kind: "invite",
      intake,
      status: "invited",
      history: [],
    });
    const conversation = await conversationStore.create({
      tutor: intake.tutor,
      pet: intake.pet,
      carePlan: intake.carePlan,
      channel: intake.channel ?? "api",
      status: "invited",
    });
    const message = await conversationStore.appendMessage(conversation.id, {
      role: "assistant",
      body: turn.reply,
      channel: conversation.channel,
    });
    return {
      id: conversation.id,
      status: "invited",
      message: toPublicMessage(message),
    };
  }

  async function handleInbound({ conversationId, text, providerMessageId }) {
    const existing = await conversationStore.get(conversationId);
    if (!existing) throw notFound();

    await conversationStore.appendMessage(conversationId, {
      role: "user",
      body: text,
      channel: existing.channel,
      providerMessageId: providerMessageId ?? null,
    });

    const withUser = await conversationStore.get(conversationId);
    const chunks = await retrieveChunks(text);
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
    });

    const status = nextStatus(existing.status, turn.intent);
    if (status !== existing.status) {
      await conversationStore.updateStatus(conversationId, status);
    }

    const message = await conversationStore.appendMessage(conversationId, {
      role: "assistant",
      body: turn.reply,
      channel: existing.channel,
    });
    return {
      id: conversationId,
      status,
      message: toPublicMessage(message),
    };
  }

  async function get(conversationId) {
    const conversation = await conversationStore.get(conversationId);
    return toPublicConversation(conversation);
  }

  return { start, handleInbound, get };
}
