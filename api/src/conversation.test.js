import assert from "node:assert/strict";
import { test } from "node:test";

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
    planRecurrency: "recurrent",
    planRecurrencyRate: 12,
    planDurationInMonths: 60,
  },
  channel: "api",
};

const VET = { uid: "vet-1", role: "vet", email: "vet@example.com" };
const OWNER = { uid: "owner-1", role: "owner", phone: "+5511999999999" };
const OWNER_RECORD = { uid: OWNER.uid, phone: OWNER.phone, name: "Ana" };

function createEngine({ generateTurn, retrieveChunks } = {}) {
  return createConversations({
    store: createMemoryConversationStore(),
    generateTurn:
      generateTurn ??
      (async ({ inboundText, chunks }) => {
        if (/não|nao/i.test(inboundText)) {
          return { reply: "Tudo bem, Ana. Quando quiser a gente retoma.", intent: "decline" };
        }
        if (/o que|v10/i.test(inboundText)) {
          const hint = chunks?.[0]?.texto ?? "";
          return { reply: hint || "A V10 é uma vacina do plano do Thor.", intent: "question" };
        }
        if (/sim|pode/i.test(inboundText)) {
          return { reply: "Ótimo, Ana. Vamos seguir com o plano do Thor.", intent: "accept" };
        }
        return { reply: "Pode confirmar se seguimos com os cuidados?", intent: "other" };
      }),
    retrieveChunks: retrieveChunks ?? (async () => []),
    loadTreatments: async () => [],
  });
}

test("start persists an invitation that names tutor, pet and procedures", async () => {
  const conversations = createEngine();
  const result = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });

  assert.equal(result.status, "invited");
  assert.match(result.message.text, /Ana/);
  assert.match(result.message.text, /Thor/);
  assert.match(result.message.text, /V10/);
  assert.equal(result.message.role, "assistant");

  const saved = await conversations.get(result.id, OWNER);
  assert.equal(saved.status, "invited");
  assert.equal(saved.tutor.name, "Ana");
  assert.equal(saved.pet.name, "Thor");
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].text, result.message.text);
});

test("tutor saying they can proceed marks the conversation accepted", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "Pode sim",
    idempotencyKey: "request-accept",
    actor: OWNER,
  });

  assert.equal(result.status, "accepted");
  assert.match(result.message.text, /V10/);
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.status, "accepted");
  assert.equal(saved.messages.length, 3);
  assert.equal(saved.messages[1].role, "user");
  assert.equal(saved.messages[1].text, "Pode sim");
});

test("tutor postponing marks the conversation declined", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "agora não",
    idempotencyKey: "request-decline",
    actor: OWNER,
  });

  assert.equal(result.status, "declined");
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.status, "declined");
});

test("a procedure question retrieves guidelines and stays invited", async () => {
  let retrievedFor;
  const conversations = createEngine({
    retrieveChunks: async (text) => {
      retrievedFor = text;
      return [{ texto: "A V10 protege contra cinomose.", titulo: "WSAVA" }];
    },
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "O que é a V10?",
    idempotencyKey: "request-question",
    actor: OWNER,
  });

  assert.equal(retrievedFor, "O que é a V10?");
  assert.equal(result.status, "invited");
  assert.match(result.message.text, /cinomose/);
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.status, "invited");
});

test("inbound providerMessageId is stored on the user message", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  await conversations.handleInbound({
    conversationId: started.id,
    text: "Pode sim",
    idempotencyKey: "request-provider",
    providerMessageId: "SM123",
    actor: OWNER,
  });

  const saved = await conversations.get(started.id, OWNER);
  const userMessage = saved.messages.find((message) => message.role === "user");
  assert.equal(userMessage.providerMessageId, "SM123");
});

test("unknown conversation is not found", async () => {
  const conversations = createEngine();
  await assert.rejects(
    () =>
      conversations.handleInbound({
        conversationId: "missing",
        text: "oi",
        idempotencyKey: "request-missing",
        actor: OWNER,
      }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(await conversations.get("missing", OWNER), null);
});

test("start is idempotent for vet, owner, pet and plan step", async () => {
  const conversations = createEngine();
  const context = { actor: VET, owner: OWNER_RECORD };
  const first = await conversations.start(INTAKE, context);
  const second = await conversations.start(INTAKE, context);

  assert.equal(second.id, first.id);
  const saved = await conversations.get(first.id, OWNER);
  assert.equal(saved.messages.length, 1);
});

test("duplicate inbound key returns the same reply without another turn", async () => {
  let calls = 0;
  const conversations = createEngine({
    generateTurn: async () => {
      calls += 1;
      return { reply: "A V10 é uma vacina.", intent: "question" };
    },
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const request = {
    conversationId: started.id,
    text: "O que é V10?",
    idempotencyKey: "same-request",
    actor: OWNER,
  };
  const first = await conversations.handleInbound(request);
  const second = await conversations.handleInbound(request);

  assert.equal(second.message.id, first.message.id);
  assert.equal(calls, 1);
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.messages.length, 3);
});

test("owner and vet can list their conversation newest first", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });

  const ownerInbox = await conversations.list({
    actor: OWNER,
    limit: 20,
  });
  const vetInbox = await conversations.list({ actor: VET, limit: 20 });

  assert.equal(ownerInbox.items[0].id, started.id);
  assert.equal(vetInbox.items[0].id, started.id);
  assert.match(ownerInbox.items[0].lastMessage.text, /V10/);
});

test("a different owner cannot read or write the thread", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const stranger = { uid: "owner-2", role: "owner", phone: "+5511888888888" };

  await assert.rejects(
    () => conversations.get(started.id, stranger),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () =>
      conversations.handleInbound({
        conversationId: started.id,
        text: "oi",
        idempotencyKey: "stranger-request",
        actor: stranger,
      }),
    (error) => error.status === 404,
  );
});
