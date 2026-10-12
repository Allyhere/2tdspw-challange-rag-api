import assert from "node:assert/strict";
import { test } from "node:test";

import { createChatWebhookWorker } from "./chatWebhook.js";
import { createConversations } from "./conversation.js";
import { createMemoryConversationStore } from "./conversationStore.js";

const INTAKE = {
  tutor: { name: "Ana", phone: "+5511999999999" },
  pet: {
    id: "pet-1",
    name: "Thor",
    breed: "Labrador",
    species: "cachorro",
  },
  planStep: {
    id: "step-1",
    planItemName: "V10",
    planRecurrency: "single",
    planDurationInMonths: 1,
  },
};

const VET = { uid: "vet-1", role: "vet", email: "vet@example.com" };
const OWNER = { uid: "owner-1", role: "owner", phone: "+5511999999999" };

test("the worker posts the stored tutor message and retries the same body", async () => {
  const store = createMemoryConversationStore();
  const conversations = createConversations({
    store,
    notifyTutorMessages: true,
    generateTurn: async () => ({ reply: "A V10 é uma vacina.", intent: "question" }),
    retrieveChunks: async () => [],
    loadTreatments: async () => [],
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: { uid: OWNER.uid, phone: OWNER.phone, name: "Ana" },
  });
  const calls = [];
  let clock = Date.now() + 60_000;
  const worker = createChatWebhookWorker({
    store,
    url: "https://nest.example/chat",
    secret: "nest-secret",
    now: () => new Date(clock),
    fetchImpl: async (url, init) => {
      calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
      if (calls.length === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    },
  });

  const pending = conversations.handleInbound({
    conversationId: started.id,
    text: "O que é a V10?",
    idempotencyKey: "webhook-retry",
    actor: OWNER,
  });
  const result = await pending;
  assert.equal(calls.length, 0);
  assert.equal(result.message.role, "assistant");

  await worker.tick();
  assert.equal(calls.length, 1);
  await worker.tick();
  assert.equal(calls.length, 1);

  clock += 1000;
  await worker.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, calls[0].url);
  assert.deepEqual(calls[1].init.body, calls[0].init.body);
  assert.equal(calls[0].init.headers["x-chat-webhook-secret"], "nest-secret");
  assert.equal(calls[0].init.body.text, "O que é a V10?");
  assert.equal(calls[0].init.body.tutorName, "Ana");
  assert.equal(calls[0].init.body.petName, "Thor");
  assert.equal(calls[0].init.body.vetFirebaseUid, VET.uid);
  assert.equal(calls[0].init.body.conversationId, started.id);

  await worker.tick();
  assert.equal(calls.length, 2);
});
