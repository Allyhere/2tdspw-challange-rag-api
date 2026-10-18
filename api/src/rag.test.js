import assert from "node:assert/strict";
import { test } from "node:test";

import { generateCarePlan } from "./rag.js";

const pet = {
  name: "Thor",
  breed: "Labrador",
  species: "cachorro",
  sex: "macho",
  weight: 28.5,
  age: 3,
  isCastrated: false,
};

const catalog = [
  {
    id: "v10",
    nome: "V10",
    tipo: "vacina",
    recorrencia: "recurrent",
    intervaloMeses: 12,
    duracaoPadraoMeses: 60,
  },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deps(overrides) {
  return {
    readCache: async () => null,
    writeCache: async () => {},
    findTreatments: async () => catalog,
    embed: async () => [[0.1]],
    searchChunks: async () => [],
    generate: async () => ({ ids: ["v10"] }),
    ...overrides,
  };
}

test("embed failure still uses the LLM ids and returns no sources", async () => {
  let generated = false;
  let verified = false;
  const { plan } = await generateCarePlan(
    pet,
    deps({
      embed: async () => {
        throw new Error("sem vetor");
      },
      generate: async () => {
        generated = true;
        return { ids: ["v10"] };
      },
      verify: async () => {
        verified = true;
      },
    }),
  );

  assert.equal(generated, true);
  assert.equal(verified, false);
  assert.equal(plan.sources.length, 0);
  assert.equal(plan.carePlan[0].planItemName, "V10");
});

test("generate starts before vector search finishes", async () => {
  const order = [];
  const { plan, timings } = await generateCarePlan(
    pet,
    deps({
      embed: async () => {
        order.push("embed:start");
        await delay(15);
        order.push("embed:end");
        return [[0.1]];
      },
      searchChunks: async () => {
        order.push("search:start");
        await delay(40);
        order.push("search:end");
        return [{ titulo: "WSAVA", url: "https://example.test", texto: "A V10 protege." }];
      },
      generate: async () => {
        order.push("generate:start");
        return { ids: ["v10"] };
      },
    }),
  );

  assert.ok(order.indexOf("generate:start") < order.indexOf("search:end"));
  assert.equal(plan.carePlan[0].planItemName, "V10");
  assert.equal(plan.sources[0].title, "WSAVA");
  assert.equal(typeof timings.embed, "number");
  assert.equal(typeof timings.vector, "number");
  assert.equal(typeof timings.catalog, "number");
  assert.equal(typeof timings.llm, "number");
  assert.equal(typeof timings.post, "number");
  assert.equal(typeof timings.total, "number");
});
