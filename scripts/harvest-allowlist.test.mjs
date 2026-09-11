import assert from "node:assert/strict";
import { test } from "node:test";

import { harvestCandidates, isAllowlisted } from "./harvest-allowlist.mjs";

test("allowlisted harvest URL is kept", () => {
  assert.equal(
    isAllowlisted("https://www.akc.org/dog-breeds/golden-retriever/"),
    true,
  );
});

test("off-list harvest URL is rejected", () => {
  assert.equal(isAllowlisted("https://example.com/labrador"), false);
});

test("harvest candidates omit off-list URLs", () => {
  assert.deepEqual(
    harvestCandidates([
      "https://www.akc.org/dog-breeds/poodle/",
      "https://example.com/not-allowed",
    ]),
    ["https://www.akc.org/dog-breeds/poodle/"],
  );
});
