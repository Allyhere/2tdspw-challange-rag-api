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
