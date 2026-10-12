import assert from "node:assert/strict";
import { test } from "node:test";

import { actorFromClaims } from "./auth.js";

test("phone Firebase identity becomes an owner", () => {
  assert.deepEqual(
    actorFromClaims({
      uid: "owner-1",
      phone_number: "+5511999999999",
      firebase: { sign_in_provider: "phone" },
    }),
    {
      uid: "owner-1",
      role: "owner",
      phone: "+5511999999999",
    },
  );
});

test("password Firebase identity becomes a vet", () => {
  assert.deepEqual(
    actorFromClaims({
      uid: "vet-1",
      email: "vet@example.com",
      firebase: { sign_in_provider: "password" },
    }),
    {
      uid: "vet-1",
      role: "vet",
      email: "vet@example.com",
    },
  );
});

test("unsupported Firebase provider is rejected", () => {
  assert.throws(
    () =>
      actorFromClaims({
        uid: "anonymous-1",
        firebase: { sign_in_provider: "anonymous" },
      }),
    (error) => error.status === 403,
  );
});
