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
  assert.equal(saved.agentEnabled, true);
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
  assert.equal(ownerInbox.items[0].agentEnabled, true);
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

test("the first vet message disables the agent without calling the model", async () => {
  let calls = 0;
  const conversations = createEngine({
    generateTurn: async () => {
      calls += 1;
      return { reply: "não deveria", intent: "question" };
    },
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const result = await conversations.handleVetMessage({
    conversationId: started.id,
    text: "Olá, aqui é a clínica.",
    idempotencyKey: "vet-takeover",
    actor: VET,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "invited");
  assert.equal(result.message.role, "vet");
  assert.equal(result.message.text, "Olá, aqui é a clínica.");
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.agentEnabled, false);
  assert.equal(saved.messages.filter((message) => message.role === "vet").length, 1);
  assert.equal(
    saved.messages.some((message) => message.role === "assistant" && message.text === "não deveria"),
    false,
  );

  const inbox = await conversations.list({ actor: VET, limit: 20 });
  assert.equal(inbox.items[0].agentEnabled, false);
});

test("later vet messages stay with the agent disabled", async () => {
  let calls = 0;
  const conversations = createEngine({
    generateTurn: async () => {
      calls += 1;
      return { reply: "não deveria", intent: "other" };
    },
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  await conversations.handleVetMessage({
    conversationId: started.id,
    text: "Primeira",
    idempotencyKey: "vet-first-msg",
    actor: VET,
  });
  const second = await conversations.handleVetMessage({
    conversationId: started.id,
    text: "Segunda",
    idempotencyKey: "vet-second-msg",
    actor: VET,
  });

  assert.equal(calls, 0);
  assert.equal(second.message.role, "vet");
  assert.equal(second.message.text, "Segunda");
  const saved = await conversations.get(started.id, VET);
  assert.equal(saved.agentEnabled, false);
  assert.equal(saved.messages.filter((message) => message.role === "vet").length, 2);
});

test("a tutor message after takeover is stored and does not call the model", async () => {
  let calls = 0;
  const conversations = createEngine({
    generateTurn: async () => {
      calls += 1;
      return { reply: "não deveria", intent: "accept" };
    },
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  await conversations.handleVetMessage({
    conversationId: started.id,
    text: "Pode deixar comigo.",
    idempotencyKey: "vet-handoff",
    actor: VET,
  });
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "Thor comeu pouco",
    idempotencyKey: "tutor-after-vet",
    actor: OWNER,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "invited");
  assert.equal(result.message.role, "user");
  assert.equal(result.message.text, "Thor comeu pouco");
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.agentEnabled, false);
  assert.equal(saved.messages.at(-1).role, "user");
});

test("reusing a vet idempotency key returns the original message", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const request = {
    conversationId: started.id,
    text: "Olá",
    idempotencyKey: "vet-same-key",
    actor: VET,
  };
  const first = await conversations.handleVetMessage(request);
  const second = await conversations.handleVetMessage({
    ...request,
    text: "Outro texto",
  });

  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.text, "Olá");
  const saved = await conversations.get(started.id, VET);
  assert.equal(saved.messages.filter((message) => message.role === "vet").length, 1);
});

test("a vet cannot post a tutor message and a tutor cannot post a vet message", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });

  await assert.rejects(
    () =>
      conversations.handleInbound({
        conversationId: started.id,
        text: "oi",
        idempotencyKey: "vet-on-tutor-route",
        actor: VET,
      }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () =>
      conversations.handleVetMessage({
        conversationId: started.id,
        text: "oi",
        idempotencyKey: "tutor-on-vet-route",
        actor: OWNER,
      }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () =>
      conversations.handleVetMessage({
        conversationId: "missing",
        text: "oi",
        idempotencyKey: "vet-missing",
        actor: VET,
      }),
    (error) => error.status === 404,
  );
});

test("a vet message that lands during a tutor turn skips the assistant reply", async () => {
  const store = createMemoryConversationStore();
  const originalAppend = store.appendMessage.bind(store);
  store.appendMessage = async (conversationId, input) => {
    const result = await originalAppend(conversationId, input);
    if (input.role === "user") {
      await originalAppend(conversationId, {
        role: "vet",
        body: "Eu assumo daqui.",
        channel: "api",
        dedupeKey: `${conversationId}:vet:mid-turn-key`,
        disableAgent: true,
      });
    }
    return result;
  };
  let calls = 0;
  const conversations = createConversations({
    store,
    generateTurn: async () => {
      calls += 1;
      return { reply: "não deveria", intent: "question" };
    },
    retrieveChunks: async () => [],
    loadTreatments: async () => [],
  });
  const started = await conversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "O que é a V10?",
    idempotencyKey: "mid-turn",
    actor: OWNER,
  });

  assert.equal(calls, 0);
  assert.equal(result.message.role, "user");
  const saved = await conversations.get(started.id, OWNER);
  assert.equal(saved.agentEnabled, false);
  assert.equal(saved.messages.some((message) => message.text === "não deveria"), false);
  assert.equal(saved.messages.some((message) => message.role === "vet"), true);
});

test("a new tutor message is queued for Nest once and vet messages are not", async () => {
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
    owner: OWNER_RECORD,
  });
  await conversations.handleVetMessage({
    conversationId: started.id,
    text: "Sem aviso",
    idempotencyKey: "vet-no-webhook",
    actor: VET,
  });
  assert.equal((await store.listDueWebhooks(new Date().toISOString())).length, 0);
  await conversations.handleInbound({
    conversationId: started.id,
    text: "Thor comeu pouco",
    idempotencyKey: "tutor-while-vet",
    actor: OWNER,
  });
  const silenced = await store.listDueWebhooks(new Date().toISOString());
  const savedSilenced = await conversations.get(started.id, OWNER);
  const silencedUser = savedSilenced.messages.find((message) => message.role === "user");
  assert.equal(silenced.length, 1);
  assert.equal(silenced[0].body.messageId, silencedUser.id);
  assert.equal(silenced[0].body.text, "Thor comeu pouco");

  const storeWithAgent = createMemoryConversationStore();
  const agentConversations = createConversations({
    store: storeWithAgent,
    notifyTutorMessages: true,
    generateTurn: async () => ({ reply: "A V10 é uma vacina.", intent: "question" }),
    retrieveChunks: async () => [],
    loadTreatments: async () => [],
  });
  const invited = await agentConversations.start(INTAKE, {
    actor: VET,
    owner: OWNER_RECORD,
  });
  const request = {
    conversationId: invited.id,
    text: "O que é a V10?",
    idempotencyKey: "webhook-once",
    actor: OWNER,
  };
  const first = await agentConversations.handleInbound(request);
  await agentConversations.handleInbound(request);
  const jobs = await storeWithAgent.listDueWebhooks(new Date().toISOString());
  const saved = await agentConversations.get(invited.id, OWNER);
  const userMessage = saved.messages.find((message) => message.role === "user");

  assert.equal(jobs.length, 1);
  assert.equal(first.message.role, "assistant");
  assert.deepEqual(jobs[0].body, {
    vetFirebaseUid: VET.uid,
    conversationId: invited.id,
    tutorName: "Ana",
    petName: "Thor",
    text: "O que é a V10?",
    messageId: userMessage.id,
  });
});

