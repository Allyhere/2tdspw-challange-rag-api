import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OllamaEmbeddings } from "@langchain/ollama";

import { closeDriver, getDriver } from "../src/neo4j.js";
import { config } from "../src/config.js";

const dataDir = dirname(fileURLToPath(import.meta.url));

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

function parseFrontMatter(markdown) {
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

function chunkText(body) {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 40);
}

function toNumber(value, fallback = 0) {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function waitForNeo4j(driver, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch {
      console.log("Aguardando Neo4j...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Neo4j não ficou pronto a tempo");
}

async function waitForOllama(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${config.ollama.baseUrl}/api/tags`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    console.log("Aguardando Ollama...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Ollama não ficou pronto a tempo");
}

async function seedTreatments(session) {
  const csv = await readFile(join(dataDir, "clinica-catalogo.csv"), "utf8");
  const rows = parseCsv(csv);

  for (const row of rows) {
    await session.run(
      `
      CREATE (t:Treatment {
        id: $id,
        nome: $nome,
        tipo: $tipo,
        especie: $especie,
        recorrencia: $recorrencia,
        intervaloMeses: $intervaloMeses,
        duracaoPadraoMeses: $duracaoPadraoMeses,
        idadeMinAnos: $idadeMinAnos,
        idadeMaxAnos: $idadeMaxAnos,
        pesoMinKg: $pesoMinKg,
        pesoMaxKg: $pesoMaxKg,
        somenteNaoCastrado: $somenteNaoCastrado
      })
      `,
      {
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
      },
    );
  }

  console.log(`Catálogo: ${rows.length} tratamentos`);
}

async function seedGuidelines(session) {
  const docsDir = join(dataDir, "docs");
  const files = (await readdir(docsDir)).filter((name) => name.endsWith(".md"));
  const embeddings = new OllamaEmbeddings({
    model: config.ollama.embedModel,
    baseUrl: config.ollama.baseUrl,
  });

  let chunkCount = 0;

  for (const file of files) {
    const raw = await readFile(join(docsDir, file), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const chunks = chunkText(body);

    await session.run(
      `
      MERGE (s:Source {url: $url})
      SET s.titulo = $titulo, s.editora = $editora
      `,
      {
        url: meta.url || file,
        titulo: meta.fonte || file,
        editora: meta.editora || "",
      },
    );

    const vectors = await embeddings.embedDocuments(chunks);

    for (let i = 0; i < chunks.length; i += 1) {
      await session.run(
        `
        MATCH (s:Source {url: $url})
        CREATE (c:GuidelineChunk {texto: $texto, embedding: $embedding})
        CREATE (c)-[:FROM]->(s)
        `,
        {
          url: meta.url || file,
          texto: chunks[i],
          embedding: vectors[i],
        },
      );
      chunkCount += 1;
    }

    console.log(`Doc ${file}: ${chunks.length} chunks`);
  }

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
  console.log(`Embeddings: ${chunkCount} chunks indexados`);
}

async function seed() {
  const driver = getDriver();
  await waitForNeo4j(driver);
  await waitForOllama();

  const session = driver.session();
  try {
    console.log("Limpando grafo...");
    await session.run("MATCH (n) DETACH DELETE n");
    try {
      await session.run(`DROP INDEX ${config.vector.indexName} IF EXISTS`);
    } catch {
      // índice ainda não existe na primeira execução
    }

    await seedTreatments(session);
    await seedGuidelines(session);
    console.log("Seed concluído.");
  } finally {
    await session.close();
    await closeDriver();
  }
}

seed().catch((error) => {
  console.error("Falha no seed:", error);
  process.exit(1);
});
