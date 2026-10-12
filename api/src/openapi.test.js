import assert from "node:assert/strict";
import { test } from "node:test";

import { openApiDocument } from "./openapi.js";

test("OpenAPI document exposes every public HTTP operation", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.deepEqual(Object.keys(openApiDocument.paths).sort(), [
    "/health",
    "/v1/care-plan",
    "/v1/conversations",
    "/v1/conversations/{id}",
    "/v1/conversations/{id}/messages",
    "/v1/ingest",
  ]);
});

test("conversation operations document Firebase bearer authentication", () => {
  const paths = openApiDocument.paths;
  const operations = [
    paths["/v1/conversations"].get,
    paths["/v1/conversations"].post,
    paths["/v1/conversations/{id}"].get,
    paths["/v1/conversations/{id}/messages"].post,
  ];

  for (const operation of operations) {
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["429"]);
  }
  assert.equal(
    openApiDocument.components.securitySchemes.bearerAuth.bearerFormat,
    "Firebase ID token",
  );
});

test("generated schemas retain conversation validation constraints", () => {
  const schemas = openApiDocument.components.schemas;
  assert.equal(schemas.InboundMessage.properties.text.maxLength, 2000);
  assert.equal(schemas.InboundMessage.properties.idempotencyKey.minLength, 8);
  assert.match(
    schemas.ConversationIntake.properties.tutor.properties.phone.pattern,
    /\\\+/,
  );
  assert.ok(schemas.ConversationIntake.required.includes("planStep"));
});
