import assert from "node:assert/strict";
import { test } from "node:test";

import { createConversations } from "./conversation.js";
import { createMemoryConversationStore } from "./conversationStore.js";

const INTAKE = {
  tutor: { name: "Ana" },
  pet: { name: "Thor", breed: "Labrador", species: "cachorro" },
  carePlan: [
    {
      planItemName: "V10",
      planRecurrency: "recurrent",
      planRecurrencyRate: 12,
      planDurationInMonths: 60,
    },
    {
      planItemName: "Antirrábica",
      planRecurrency: "recurrent",
      planRecurrencyRate: 12,
      planDurationInMonths: 60,
    },
    {
      planItemName: "Exame de fezes",
      planRecurrency: "recurrent",
      planRecurrencyRate: 6,
      planDurationInMonths: 12,
    },
  ],
  channel: "api",
};

function invitationFromIntake(intake) {
  const names = intake.carePlan.map((item) => item.planItemName).join(", ");
  return `Oi ${intake.tutor.name}! O ${intake.pet.name} precisa de ${names} no próximo mês. Pode confirmar?`;
}

function createEngine({ generateTurn, retrieveChunks } = {}) {
  return createConversations({
    store: createMemoryConversationStore(),
    generateTurn:
      generateTurn ??
      (async ({ kind, intake, inboundText, chunks }) => {
        if (kind === "invite") {
          return { reply: invitationFromIntake(intake), intent: "invite" };
        }
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
  });
}

test("start persists an invitation that names tutor, pet and procedures", async () => {
  const conversations = createEngine();
  const result = await conversations.start(INTAKE);

  assert.equal(result.status, "invited");
  assert.match(result.message.text, /Ana/);
  assert.match(result.message.text, /Thor/);
  assert.match(result.message.text, /V10/);
  assert.match(result.message.text, /Antirrábica/);
  assert.match(result.message.text, /Exame de fezes/);
  assert.equal(result.message.role, "assistant");

  const saved = await conversations.get(result.id);
  assert.equal(saved.status, "invited");
  assert.equal(saved.tutor.name, "Ana");
  assert.equal(saved.pet.name, "Thor");
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].text, result.message.text);
});

test("tutor saying they can proceed marks the conversation accepted", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE);
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "Pode sim",
  });

  assert.equal(result.status, "accepted");
  assert.match(result.message.text, /Thor/);
  const saved = await conversations.get(started.id);
  assert.equal(saved.status, "accepted");
  assert.equal(saved.messages.length, 3);
  assert.equal(saved.messages[1].role, "user");
  assert.equal(saved.messages[1].text, "Pode sim");
});

test("tutor postponing marks the conversation declined", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE);
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "agora não",
  });

  assert.equal(result.status, "declined");
  const saved = await conversations.get(started.id);
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
  const started = await conversations.start(INTAKE);
  const result = await conversations.handleInbound({
    conversationId: started.id,
    text: "O que é a V10?",
  });

  assert.equal(retrievedFor, "O que é a V10?");
  assert.equal(result.status, "invited");
  assert.match(result.message.text, /cinomose/);
  const saved = await conversations.get(started.id);
  assert.equal(saved.status, "invited");
});

test("inbound providerMessageId is stored on the user message", async () => {
  const conversations = createEngine();
  const started = await conversations.start(INTAKE);
  await conversations.handleInbound({
    conversationId: started.id,
    text: "Pode sim",
    providerMessageId: "SM123",
  });

  const saved = await conversations.get(started.id);
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
      }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(await conversations.get("missing"), null);
});
