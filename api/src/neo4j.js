import { createHash } from "node:crypto";

import neo4j from "neo4j-driver";

import { config } from "./config.js";

function toJsNumber(value) {
  if (value == null) return null;
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value);
}

let driver;

export function getDriver() {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
      {
        maxConnectionLifetime: 60 * 60 * 1000,
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 2 * 60 * 1000,
        connectionTimeout: 30 * 1000,
      },
    );
  }
  return driver;
}

export async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}

export async function findTreatmentsForPet(pet) {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (t:Treatment)
      WHERE (t.especie = $species OR t.especie = 'ambos')
        AND $age >= t.idadeMinAnos AND $age <= t.idadeMaxAnos
        AND $weight >= t.pesoMinKg AND $weight <= t.pesoMaxKg
        AND (t.somenteNaoCastrado = false OR $isCastrated = false)
      RETURN t
      ORDER BY t.tipo, t.nome
      `,
      {
        species: pet.species,
        age: pet.age,
        weight: pet.weight,
        isCastrated: pet.isCastrated,
      },
    );

    return result.records.map((record) => {
      const t = record.get("t").properties;
      return {
        id: t.id,
        nome: t.nome,
        tipo: t.tipo,
        especie: t.especie,
        recorrencia: t.recorrencia,
        intervaloMeses: toJsNumber(t.intervaloMeses),
        duracaoPadraoMeses: toJsNumber(t.duracaoPadraoMeses),
        somenteNaoCastrado: t.somenteNaoCastrado,
      };
    });
  } finally {
    await session.close();
  }
}

export async function searchGuidelineChunks(embedding, k = config.vector.k) {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      CALL db.index.vector.queryNodes($indexName, $k, $embedding)
      YIELD node, score
      OPTIONAL MATCH (node)-[:FROM]->(s:Source)
      RETURN node.texto AS texto,
             s.titulo AS titulo,
             s.url AS url,
             s.editora AS editora,
             score
      `,
      {
        indexName: config.vector.indexName,
        k: neo4j.int(k),
        embedding,
      },
    );

    return result.records.map((record) => ({
      texto: record.get("texto"),
      titulo: record.get("titulo"),
      url: record.get("url"),
      editora: record.get("editora"),
      score: record.get("score"),
    }));
  } finally {
    await session.close();
  }
}

function carePlanCacheKey(pet) {
  const canonical = [
    String(pet.breed).trim().toLowerCase(),
    pet.species,
    pet.sex || "",
    Number(pet.weight),
    Number(pet.age),
    pet.isCastrated ? "1" : "0",
    config.gemini.embedModel,
    config.gemini.chatModel,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

let cacheConstraintReady = false;

async function ensureCarePlanCacheConstraint(session) {
  if (cacheConstraintReady) return;
  await session.run(`
    CREATE CONSTRAINT cached_care_plan_key IF NOT EXISTS
    FOR (c:CachedCarePlan) REQUIRE c.key IS UNIQUE
  `);
  cacheConstraintReady = true;
}

export async function getCachedCarePlan(pet) {
  const session = getDriver().session();
  try {
    await ensureCarePlanCacheConstraint(session);
    const result = await session.run(
      `
      MATCH (c:CachedCarePlan {key: $key})
      RETURN c.payload AS payload
      `,
      { key: carePlanCacheKey(pet) },
    );
    const raw = result.records[0]?.get("payload");
    if (!raw) return null;
    return JSON.parse(raw);
  } finally {
    await session.close();
  }
}

export async function saveCachedCarePlan(pet, plan) {
  const session = getDriver().session();
  try {
    await ensureCarePlanCacheConstraint(session);
    await session.run(
      `
      MERGE (c:CachedCarePlan {key: $key})
      ON CREATE SET c.payload = $payload, c.createdAt = datetime()
      `,
      {
        key: carePlanCacheKey(pet),
        payload: JSON.stringify(plan),
      },
    );
  } finally {
    await session.close();
  }
}
