import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { geminiEmbed } from "./gemini.js";
import { getDriver } from "./neo4j.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const docsDir = join(dataDir, "docs");

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(",");
  return lines.filter(Boolean).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = (cols[index] ?? "").trim();
    });
    return row;
  });
}

export function parseFrontMatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: markdown };
  }
  const meta = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: match[2].trim() };
}

export function chunkText(body) {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 40);
}

export function contentHash(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function toNumber(value, fallback = 0) {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function treatmentParams(row) {
  return {
    id: row.id,
    nome: row.nome,
    tipo: row.tipo,
    especie: row.especie,
    recorrencia: row.recorrencia,
    intervaloMeses:
      row.intervaloMeses === "" ? null : toNumber(row.intervaloMeses),
    duracaoPadraoMeses: toNumber(row.duracaoPadraoMeses, 1),
    idadeMinAnos: toNumber(row.idadeMinAnos),
    idadeMaxAnos: toNumber(row.idadeMaxAnos, 20),
    pesoMinKg: toNumber(row.pesoMinKg),
    pesoMaxKg: toNumber(row.pesoMaxKg, 90),
    somenteNaoCastrado: row.somenteNaoCastrado === "true",
  };
}

async function ensureIndexes(session) {
  await session.run(`
    CREATE CONSTRAINT treatment_id IF NOT EXISTS
    FOR (t:Treatment) REQUIRE t.id IS UNIQUE
  `);
  await session.run(`
    CREATE VECTOR INDEX ${config.vector.indexName} IF NOT EXISTS
    FOR (c:GuidelineChunk)
    ON (c.embedding)
    OPTIONS {
      indexConfig: {
        \`vector.dimensions\`: ${config.vector.dimensions},
        \`vector.similarity_function\`: 'cosine'
      }
    }
  `);
  await session.run("CALL db.awaitIndex($name)", {
    name: config.vector.indexName,
  });
}

export async function upsertTreatments(session) {
  const csv = await readFile(join(dataDir, "clinica-catalogo.csv"), "utf8");
  const rows = parseCsv(csv);
  const ids = rows.map((row) => row.id).filter(Boolean);

  for (const row of rows) {
    const params = treatmentParams(row);
    await session.run(
      `
      MERGE (t:Treatment {id: $id})
      SET t.nome = $nome,
          t.tipo = $tipo,
          t.especie = $especie,
          t.recorrencia = $recorrencia,
          t.intervaloMeses = $intervaloMeses,
          t.duracaoPadraoMeses = $duracaoPadraoMeses,
          t.idadeMinAnos = $idadeMinAnos,
          t.idadeMaxAnos = $idadeMaxAnos,
          t.pesoMinKg = $pesoMinKg,
          t.pesoMaxKg = $pesoMaxKg,
          t.somenteNaoCastrado = $somenteNaoCastrado
      `,
      params,
    );
  }

  if (ids.length > 0) {
    await session.run(
      `
      MATCH (t:Treatment)
      WHERE NOT t.id IN $ids
      DETACH DELETE t
      `,
      { ids },
    );
  }

  return ids.length;
}

async function sourceState(session, url) {
  const result = await session.run(
    `
    MATCH (s:Source {url: $url})
    OPTIONAL MATCH (s)<-[:FROM]-(c:GuidelineChunk)
    RETURN s.contentHash AS contentHash, count(c) AS chunks
    `,
    { url },
  );
  const record = result.records[0];
  if (!record) return { contentHash: null, chunks: 0 };
  const chunks = record.get("chunks");
  return {
    contentHash: record.get("contentHash") || null,
    chunks: typeof chunks?.toNumber === "function" ? chunks.toNumber() : Number(chunks),
  };
}

async function replaceChunks(session, url, chunks, vectors) {
  await session.run(
    `
    MATCH (s:Source {url: $url})<-[:FROM]-(c:GuidelineChunk)
    DETACH DELETE c
    `,
    { url },
  );

  for (let i = 0; i < chunks.length; i += 1) {
    await session.run(
      `
      MATCH (s:Source {url: $url})
      CREATE (c:GuidelineChunk {texto: $texto, embedding: $embedding})
      CREATE (c)-[:FROM]->(s)
      `,
      {
        url,
        texto: chunks[i],
        embedding: vectors[i],
      },
    );
  }
}

async function invalidateCache(session, { raca, especie }) {
  const breed = String(raca ?? "").trim().toLowerCase();
  const species = String(especie ?? "").trim();
  if (breed && species) {
    await session.run(
      `
      MATCH (c:CachedCarePlan)
      WHERE toLower(c.breed) = $breed AND c.species = $species
      DETACH DELETE c
      `,
      { breed, species },
    );
    return "breed";
  }
  await session.run("MATCH (c:CachedCarePlan) DETACH DELETE c");
  return "all";
}

async function removeOrphanSources(session, keepUrls) {
  const result = await session.run(
    `
    MATCH (s:Source)
    WHERE NOT s.url IN $keepUrls
    OPTIONAL MATCH (s)<-[:FROM]-(c:GuidelineChunk)
    WITH s, collect(c) AS chunks
    FOREACH (chunk IN chunks | DETACH DELETE chunk)
    DETACH DELETE s
    RETURN count(s) AS removed
    `,
    { keepUrls },
  );
  const removed = result.records[0]?.get("removed");
  return typeof removed?.toNumber === "function" ? removed.toNumber() : Number(removed || 0);
}

export async function ingestGuidelines(session, { force = false } = {}) {
  const files = (await readdir(docsDir)).filter((name) => name.endsWith(".md"));
  const summary = {
    ingested: [],
    skipped: [],
    removed: 0,
    chunksWritten: 0,
  };
  const keepUrls = [];

  for (const file of files) {
    const raw = await readFile(join(docsDir, file), "utf8");
    const hash = contentHash(raw);
    const { meta, body } = parseFrontMatter(raw);
    const url = meta.url || file;
    keepUrls.push(url);
    const chunks = chunkText(body);
    const raca = meta.raca || "";
    const especie = meta.especie || "";

    const existing = await sourceState(session, url);
    const unchanged = !force && existing.contentHash === hash;
    const migrateHash =
      !force && !existing.contentHash && existing.chunks > 0 && chunks.length === existing.chunks;

    await session.run(
      `
      MERGE (s:Source {url: $url})
      SET s.titulo = $titulo,
          s.editora = $editora,
          s.file = $file,
          s.raca = $raca,
          s.especie = $especie
      `,
      {
        url,
        titulo: meta.fonte || file,
        editora: meta.editora || "",
        file,
        raca,
        especie,
      },
    );

    if (unchanged || migrateHash) {
      if (migrateHash) {
        await session.run(
          `MATCH (s:Source {url: $url}) SET s.contentHash = $hash`,
          { url, hash },
        );
      }
      summary.skipped.push(file);
      console.log(`Doc ${file}: skip (hash ok)`);
      continue;
    }

    if (chunks.length === 0) {
      await replaceChunks(session, url, [], []);
      await session.run(
        `MATCH (s:Source {url: $url}) SET s.contentHash = $hash`,
        { url, hash },
      );
      summary.ingested.push(file);
      console.log(`Doc ${file}: 0 chunks`);
      continue;
    }

    const vectors = await geminiEmbed(chunks, "RETRIEVAL_DOCUMENT");
    await replaceChunks(session, url, chunks, vectors);
    await session.run(
      `MATCH (s:Source {url: $url}) SET s.contentHash = $hash`,
      { url, hash },
    );
    await invalidateCache(session, { raca, especie });
    summary.ingested.push(file);
    summary.chunksWritten += chunks.length;
    console.log(`Doc ${file}: ${chunks.length} chunks`);
  }

  summary.removed = await removeOrphanSources(session, keepUrls);
  return summary;
}

export async function runIngest({ force = false } = {}) {
  const session = getDriver().session();
  try {
    await ensureIndexes(session);
    const treatments = await upsertTreatments(session);
    const guidelines = await ingestGuidelines(session, { force });
    console.log(
      `Ingest: ${treatments} tratamentos, ${guidelines.ingested.length} docs novos/alterados, ${guidelines.skipped.length} skip, ${guidelines.removed} fontes removidas`,
    );
    return { treatments, ...guidelines };
  } finally {
    await session.close();
  }
}
