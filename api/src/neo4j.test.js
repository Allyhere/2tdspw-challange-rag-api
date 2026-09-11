import assert from "node:assert/strict";
import { test } from "node:test";

import { carePlanCacheIdentity } from "./neo4j.js";

test("care plan cache identity stores breed and species for ingest wipe", () => {
  const identity = carePlanCacheIdentity({
    breed: "Labrador",
    species: "cachorro",
    sex: "macho",
    weight: 28.5,
    age: 3,
    isCastrated: false,
  });
  assert.equal(identity.breed, "labrador");
  assert.equal(identity.species, "cachorro");
  assert.equal(identity.key.length, 64);
});
