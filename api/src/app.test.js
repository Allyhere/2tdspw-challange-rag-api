import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.js";

const SUMMARY = {
  treatments: 15,
  ingested: ["labrador-cuidados.md"],
  skipped: ["persa-cuidados.md"],
  removed: 0,
  chunksWritten: 6,
};

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("POST /v1/ingest returns the ingest summary", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/ingest`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SUMMARY);
  });
});

test("POST /v1/ingest with force true asks ingest to reindex", async () => {
  const app = createApp({
    runIngest: async ({ force }) => {
      if (!force) {
        throw new Error("expected force");
      }
      return SUMMARY;
    },
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SUMMARY);
  });
});

test("POST /v1/ingest rejects an invalid payload", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: "yes" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, "Payload inválido");
  });
});

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
  ],
};

function fakeConversations() {
  const convos = new Map();
  return {
    async start(intake) {
      const id = "conv-1";
      const message = {
        id: "msg-1",
        role: "assistant",
        text: `Oi ${intake.tutor.name}!`,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      convos.set(id, {
        id,
        status: "invited",
        tutor: intake.tutor,
        pet: intake.pet,
        carePlan: intake.carePlan,
        messages: [message],
      });
      return { id, status: "invited", message };
    },
    async handleInbound({ conversationId, text, providerMessageId }) {
      const found = convos.get(conversationId);
      if (!found) {
        const error = new Error("Conversa não encontrada");
        error.status = 404;
        throw error;
      }
      found.messages.push({
        id: "msg-user",
        role: "user",
        text,
        createdAt: "2026-01-01T00:00:01.000Z",
        ...(providerMessageId ? { providerMessageId } : {}),
      });
      let status = found.status;
      let reply = "Entendi.";
      if (/não|nao/i.test(text)) {
        status = "declined";
        reply = "Tudo bem, fica para depois.";
      } else if (/o que|v10/i.test(text)) {
        reply = "A V10 é uma vacina.";
      } else if (/sim|pode/i.test(text)) {
        status = "accepted";
        reply = "Ótimo, vamos seguir.";
      }
      found.status = status;
      const message = {
        id: "msg-assistant",
        role: "assistant",
        text: reply,
        createdAt: "2026-01-01T00:00:02.000Z",
      };
      found.messages.push(message);
      return { id: conversationId, status, message };
    },
    async get(id) {
      return convos.get(id) ?? null;
    },
  };
}

test("POST /v1/conversations starts with an invitation", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INTAKE),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "conv-1");
    assert.equal(body.status, "invited");
    assert.match(body.message.text, /Ana/);
  });
});

test("POST /v1/conversations rejects an invalid payload", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tutor: { name: "Ana" } }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, "Payload inválido");
  });
});

test("POST /v1/conversations/:id/messages records accept", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Pode sim" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "accepted");
  });
});

test("POST /v1/conversations/:id/messages records decline", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "agora não" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "declined");
  });
});

test("POST /v1/conversations/:id/messages keeps status on a procedure question", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "O que é a V10?" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "invited");
    assert.match(body.message.text, /V10/);
  });
});

test("GET /v1/conversations/:id returns messages in order", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INTAKE),
    });
    await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Pode sim" }),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].role, "assistant");
    assert.equal(body.messages[1].role, "user");
    assert.equal(body.messages[1].text, "Pode sim");
    assert.equal(body.messages[2].role, "assistant");
  });
});

test("GET /v1/conversations/:id returns 404 when missing", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/missing`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.message, "Conversa não encontrada");
  });
});

test("POST /v1/conversations/:id/messages returns 404 when missing", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/missing/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    assert.equal(response.status, 404);
  });
});

test("POST /v1/conversations/:id/messages rejects an invalid payload", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(response.status, 400);
  });
});
