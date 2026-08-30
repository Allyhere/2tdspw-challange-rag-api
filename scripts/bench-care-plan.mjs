import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const historyPath = join(rootDir, "scripts/bench-history.json");

const BASE = process.env.RAG_API_URL || "http://localhost:3000";
const label = process.argv.includes("--label")
  ? process.argv[process.argv.indexOf("--label") + 1]
  : "run";
const MISS_RUNS = process.argv.includes("--runs")
  ? Number(process.argv[process.argv.indexOf("--runs") + 1])
  : 3;
const REQUEST_TIMEOUT_MS = 40 * 60 * 1000;

const CASES = [
  {
    name: "Labrador",
    payload: {
      name: "Thor",
      breed: "Labrador",
      species: "cachorro",
      sex: "macho",
      weight: 28.5,
      age: 3,
      isCastrated: false,
    },
  },
  {
    name: "Persa",
    payload: {
      name: "Luna",
      breed: "Persa",
      species: "gato",
      sex: "femea",
      weight: 4,
      age: 2,
      isCastrated: true,
    },
  },
];

function parseServerTiming(header) {
  const timings = {};
  if (!header) return timings;
  for (const part of header.split(",")) {
    const bits = part.trim().split(";");
    const name = bits[0]?.trim();
    if (!name) continue;
    const durBit = bits.find((bit) => bit.trim().startsWith("dur="));
    const descBit = bits.find((bit) => bit.trim().startsWith("desc="));
    const dur = durBit ? Number(durBit.trim().slice(4)) : undefined;
    const desc = descBit
      ? descBit.trim().slice(5).replace(/^"|"$/g, "")
      : undefined;
    timings[name] = { dur, desc };
  }
  return timings;
}

function requestCarePlan(payload) {
  const url = new URL("/v1/care-plan", BASE);
  const body = JSON.stringify(payload);
  const wallStart = performance.now();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const wallMs = Math.round(performance.now() - wallStart);
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { message: text };
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${parsed.message || text.slice(0, 200)}`,
              ),
            );
            return;
          }
          resolve({
            wallMs,
            serverTiming: parseServerTiming(res.headers["server-timing"]),
            itemCount: Array.isArray(parsed.carePlan)
              ? parsed.carePlan.length
              : 0,
            sourceCount: Array.isArray(parsed.sources)
              ? parsed.sources.length
              : 0,
          });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 60000} minutes`),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function flushCache() {
  const auth = Buffer.from("neo4j:password").toString("base64");
  const response = await fetch("http://localhost:7474/db/neo4j/tx/commit", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      statements: [
        { statement: "MATCH (c:CachedCarePlan) DETACH DELETE c" },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Falha ao limpar cache Neo4j: HTTP ${response.status} ${text.slice(0, 200)}`,
    );
  }
}

function stageDur(row, name) {
  const value = row.serverTiming?.[name]?.dur;
  return Number.isFinite(value) ? value : null;
}

function printTable(rows) {
  const headers = [
    "label",
    "case",
    "kind",
    "run",
    "wallMs",
    "cache",
    "embed",
    "vector",
    "catalog",
    "llm",
    "post",
    "total",
  ];
  const lines = [headers.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.label,
        row.case,
        row.kind,
        row.run,
        row.wallMs,
        stageDur(row, "cache") ?? "",
        stageDur(row, "embed") ?? "",
        stageDur(row, "vector") ?? "",
        stageDur(row, "catalog") ?? "",
        stageDur(row, "llm") ?? "",
        stageDur(row, "post") ?? "",
        stageDur(row, "total") ?? "",
      ].join("\t"),
    );
  }
  console.log(lines.join("\n"));
}

function mean(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarize(rows) {
  const misses = rows.filter((row) => row.kind === "miss");
  const hits = rows.filter((row) => row.kind === "hit");
  return {
    missMeanWallMs: mean(misses.map((row) => row.wallMs)),
    missMeanLlmMs: mean(
      misses.map((row) => stageDur(row, "llm")).filter((value) => value != null),
    ),
    missMeanEmbedMs: mean(
      misses
        .map((row) => stageDur(row, "embed"))
        .filter((value) => value != null),
    ),
    hitMeanWallMs: mean(hits.map((row) => row.wallMs)),
  };
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(historyPath, "utf8"));
  } catch {
    return [];
  }
}

const health = await fetch(`${BASE}/health`);
if (!health.ok) {
  throw new Error(`API fora do ar em ${BASE}`);
}
console.log(`API ok em ${BASE}. Label=${label} runs=${MISS_RUNS}`);

console.log("Warmup (descartado)...");
await requestCarePlan(CASES[0].payload);

const rows = [];
for (const testCase of CASES) {
  for (let run = 1; run <= MISS_RUNS; run += 1) {
    await flushCache();
    console.log(`Miss ${testCase.name} #${run}...`);
    const result = await requestCarePlan(testCase.payload);
    rows.push({
      label,
      case: testCase.name,
      kind: "miss",
      run,
      at: new Date().toISOString(),
      ...result,
    });
    console.log(
      `  wall=${result.wallMs}ms llm=${stageDur(result, "llm") ?? "?"}ms cache=${result.serverTiming.cache?.desc ?? "?"}`,
    );
  }
}

console.log(`Hit ${CASES[1].name}...`);
const hit = await requestCarePlan(CASES[1].payload);
rows.push({
  label,
  case: CASES[1].name,
  kind: "hit",
  run: 1,
  at: new Date().toISOString(),
  ...hit,
});
console.log(
  `  wall=${hit.wallMs}ms cache=${hit.serverTiming.cache?.desc ?? "?"}`,
);

console.log("\n=== runs ===");
printTable(rows);

const summary = summarize(rows);
console.log("\n=== summary ===");
console.log(
  JSON.stringify({ label, ...summary }, null, 2),
);

const history = loadHistory();
history.push({ label, at: new Date().toISOString(), summary, rows });
writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
console.log(`\nHistórico gravado em ${historyPath}`);

const previous = history.filter((entry) => entry.label !== label).at(-1);
if (previous?.summary && summary.missMeanWallMs != null && previous.summary.missMeanWallMs != null) {
  const delta = summary.missMeanWallMs - previous.summary.missMeanWallMs;
  const pct = Math.round((delta / previous.summary.missMeanWallMs) * 100);
  console.log("\n=== vs previous ===");
  console.log(
    `${previous.label} miss mean ${previous.summary.missMeanWallMs}ms → ${label} ${summary.missMeanWallMs}ms (${pct}% / ${delta}ms)`,
  );
  if (previous.summary.missMeanLlmMs != null && summary.missMeanLlmMs != null) {
    const llmDelta = summary.missMeanLlmMs - previous.summary.missMeanLlmMs;
    console.log(
      `${previous.label} llm mean ${previous.summary.missMeanLlmMs}ms → ${label} ${summary.missMeanLlmMs}ms (${llmDelta}ms)`,
    );
  }
}
