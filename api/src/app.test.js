import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.js";
import { createRateLimiter } from "./rateLimit.js";

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
      headers: headers("vet-token", true),
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
      headers: headers("vet-token", true),
      body: JSON.stringify({ force: "yes" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, "Payload inválido");
  });
});

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
};

function fakeIdentityService() {
  return {
    async authenticateRequest(req) {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (token === "vet-token") {
        return { uid: "vet-1", role: "vet", email: "vet@example.com" };
      }
      if (token === "owner-token") {
        return { uid: "owner-1", role: "owner", phone: "+5511999999999" };
      }
      if (token === "other-token") {
        return { uid: "owner-2", role: "owner", phone: "+5511888888888" };
      }
      const error = new Error("Token Firebase obrigatório");
      error.status = 401;
      throw error;
    },
    async resolveOwnerByPhone() {
      return { uid: "owner-1", phone: "+5511999999999", name: "Ana" };
    },
  };
}

function headers(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function fakeConversations() {
  const convos = new Map();
  return {
    async start(intake, { actor, owner }) {
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
        vetFirebaseUid: actor.uid,
        ownerFirebaseUid: owner.uid,
        tutor: intake.tutor,
        pet: intake.pet,
        planStep: intake.planStep,
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [message],
      });
      return { id, status: "invited", message };
    },
    async handleInbound({ conversationId, text, providerMessageId, actor }) {
      const found = convos.get(conversationId);
      if (!found || found.ownerFirebaseUid !== actor.uid) {
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
    async get(id, actor) {
      const found = convos.get(id);
      if (!found) return null;
      if (![found.ownerFirebaseUid, found.vetFirebaseUid].includes(actor.uid)) {
        const error = new Error("Conversa não encontrada");
        error.status = 404;
        throw error;
      }
      return found;
    },
    async list({ actor }) {
      const items = [...convos.values()].filter((conversation) =>
        [conversation.ownerFirebaseUid, conversation.vetFirebaseUid].includes(
          actor.uid,
        ),
      );
      return { items, nextCursor: null };
    },
  };
}

test("POST /v1/conversations starts with an invitation", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({ text: "Pode sim", idempotencyKey: "accept-request" }),
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({ text: "agora não", idempotencyKey: "decline-request" }),
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({
        text: "O que é a V10?",
        idempotencyKey: "question-request",
      }),
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({ text: "Pode sim", idempotencyKey: "thread-request" }),
    });
    const response = await fetch(`${base}/v1/conversations/conv-1`, {
      headers: headers("owner-token"),
    });
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
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/missing`, {
      headers: headers("owner-token"),
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.message, "Conversa não encontrada");
  });
});

test("POST /v1/conversations/:id/messages returns 404 when missing", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/missing/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({ text: "oi", idempotencyKey: "missing-request" }),
    });
    assert.equal(response.status, 404);
  });
});

test("POST /v1/conversations/:id/messages rejects an invalid payload", async () => {
  const app = createApp({
    runIngest: async () => SUMMARY,
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations/conv-1/messages`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(response.status, 400);
  });
});

test("conversation routes require a Firebase bearer token", async () => {
  const app = createApp({
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`);
    assert.equal(response.status, 401);
  });
});

test("an owner cannot create a veterinary invitation", async () => {
  const app = createApp({
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("owner-token", true),
      body: JSON.stringify(INTAKE),
    });
    assert.equal(response.status, 403);
  });
});

test("owner inbox is scoped to the authenticated Firebase uid", async () => {
  const app = createApp({
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    const ownerResponse = await fetch(`${base}/v1/conversations`, {
      headers: headers("owner-token"),
    });
    const strangerResponse = await fetch(`${base}/v1/conversations`, {
      headers: headers("other-token"),
    });

    assert.equal((await ownerResponse.json()).items.length, 1);
    assert.equal((await strangerResponse.json()).items.length, 0);
  });
});

test("unregistered owner phone returns 404", async () => {
  const identityService = fakeIdentityService();
  identityService.resolveOwnerByPhone = async () => {
    const error = new Error("Tutor não cadastrado no Firebase");
    error.status = 404;
    throw error;
  };
  const app = createApp({
    conversations: fakeConversations(),
    identityService,
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/v1/conversations`, {
      method: "POST",
      headers: headers("vet-token", true),
      body: JSON.stringify(INTAKE),
    });
    assert.equal(response.status, 404);
  });
});

test("conversation rate limit returns retry-after", async () => {
  const app = createApp({
    conversations: fakeConversations(),
    identityService: fakeIdentityService(),
    rateLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
  });

  await withServer(app, async (base) => {
    await fetch(`${base}/v1/conversations`, {
      headers: headers("owner-token"),
    });
    const response = await fetch(`${base}/v1/conversations`, {
      headers: headers("owner-token"),
    });
    assert.equal(response.status, 429);
    assert.ok(response.headers.get("retry-after"));
  });
});
