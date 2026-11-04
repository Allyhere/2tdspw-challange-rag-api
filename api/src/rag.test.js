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

const cachedPlan = [
  {
    planItemName: "V10",
    planRecurrency: "recurrent",
    planRecurrencyRate: 12,
    planDurationInMonths: 60,
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
    describe: async () => null,
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
      generate: async (_pet, _catalog, chunks) => {
        generated = true;
        assert.deepEqual(chunks, []);
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

test("ranking starts after the guideline search and receives the chunk text", async () => {
  const order = [];
  let received = "";
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
        return [
          {
            titulo: "WSAVA",
            url: "https://example.test",
            texto: "A V10 protege o Labrador.",
          },
        ];
      },
      generate: async (_pet, _catalog, chunks) => {
        order.push("generate:start");
        received = chunks.map((chunk) => chunk.texto).join("\n");
        return { ids: ["v10"] };
      },
    }),
  );

  assert.ok(order.indexOf("search:end") < order.indexOf("generate:start"));
  assert.match(received, /V10 protege o Labrador/);
  assert.equal(plan.carePlan[0].planItemName, "V10");
  assert.equal(plan.sources[0].title, "WSAVA");
  assert.equal(typeof timings.embed, "number");
  assert.equal(typeof timings.vector, "number");
  assert.equal(typeof timings.catalog, "number");
  assert.equal(typeof timings.llm, "number");
  assert.equal(typeof timings.post, "number");
  assert.equal(typeof timings.total, "number");
});

test("clinical series bypasses the demographic cache", async () => {
  const cases = [
    { consultas: [{ data: "2026-01-01", diagnostico: "otite" }] },
    { medicamentos: [{ nome: "prednisolona", desde: "2026-01-01" }] },
    { vacinasAplicadas: [{ nome: "V10", data: "2026-01-01" }] },
    { comportamento: [{ relato: "coceira nas patas", data: "2026-03-01" }] },
  ];

  for (const extra of cases) {
    let read = false;
    let wrote = false;
    const { timings } = await generateCarePlan(
      { ...pet, ...extra },
      deps({
        readCache: async () => {
          read = true;
          return null;
        },
        writeCache: async () => {
          wrote = true;
        },
      }),
    );
    assert.equal(read, false);
    assert.equal(wrote, false);
    assert.equal(timings.cacheStatus, "bypass");
  }
});

test("behavior and history are part of the embedding query", async () => {
  let query = "";
  await generateCarePlan(
    {
      ...pet,
      consultas: [{ data: "2026-02-01", resumo: "tosse", diagnostico: "traqueíte" }],
      medicamentos: [{ nome: "prednisolona" }],
      vacinasAplicadas: [{ nome: "V10", data: "2025-11-01" }],
      comportamento: [{ relato: "coceira nas patas" }],
    },
    deps({
      embed: async (text) => {
        query = text;
        return [[0.1]];
      },
    }),
  );

  assert.match(query, /traqueíte/);
  assert.match(query, /prednisolona/);
  assert.match(query, /V10 em 2025-11-01/);
  assert.match(query, /coceira nas patas/);
});

test("model description is returned when it stays inside the plan", async () => {
  let saved;
  const { plan } = await generateCarePlan(
    pet,
    deps({
      describe: async () => "Thor segue com V10 uma vez por ano.",
      writeCache: async (_pet, payload) => {
        saved = payload;
      },
    }),
  );

  assert.equal(plan.carePlanDescription, "Thor segue com V10 uma vez por ano.");
  assert.equal(saved.carePlanDescription, plan.carePlanDescription);
});

test("description that names a catalog item outside the plan falls back", async () => {
  const { plan } = await generateCarePlan(
    pet,
    deps({
      describe: async () => "Inclua Hemograma além da rotina.",
    }),
  );

  assert.match(plan.carePlanDescription, /Thor/);
  assert.match(plan.carePlanDescription, /V10/);
  assert.doesNotMatch(plan.carePlanDescription, /Hemograma/);
});

test("description failure still returns the grounded plan", async () => {
  const { plan } = await generateCarePlan(
    pet,
    deps({
      describe: async () => {
        throw new Error("gemini fora");
      },
    }),
  );

  assert.equal(plan.carePlan[0].planItemName, "V10");
  assert.match(plan.carePlanDescription, /V10/);
});

test("cache hit reuses the stored description", async () => {
  const { plan } = await generateCarePlan(
    pet,
    deps({
      readCache: async () => ({
        carePlan: cachedPlan,
        carePlanDescription: "Plano em cache para Thor.",
        sources: [],
      }),
    }),
  );

  assert.equal(plan.carePlanDescription, "Plano em cache para Thor.");
});

test("cache hit without a description uses the template", async () => {
  const { plan } = await generateCarePlan(
    pet,
    deps({
      readCache: async () => ({
        carePlan: cachedPlan,
        sources: [],
      }),
    }),
  );

  assert.match(plan.carePlanDescription, /Thor/);
  assert.match(plan.carePlanDescription, /V10/);
});
