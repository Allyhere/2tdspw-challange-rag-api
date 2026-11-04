import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const csvPath = join(root, "api/data/clinica-catalogo.csv");
const outPath = join(root, "docs/resultados.md");

const catalogNames = new Set(
  readFileSync(csvPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[1])
    .filter(Boolean),
);

const cases = [
  {
    name: "Labrador",
    pet: "Thor, Labrador, 3 anos, 28,5 kg, não castrado",
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
    pet: "Luna, Persa, 2 anos, 4 kg, castrada",
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
  {
    name: "Cão SRD",
    pet: "Mel, SRD, 4 anos, 12 kg, castrada",
    payload: {
      name: "Mel",
      breed: "SRD",
      species: "cachorro",
      sex: "femea",
      weight: 12,
      age: 4,
      isCastrated: true,
    },
  },
  {
    name: "Gato SRD",
    pet: "Mingau, SRD, 3 anos, 4,5 kg, não castrado",
    payload: {
      name: "Mingau",
      breed: "SRD",
      species: "gato",
      sex: "macho",
      weight: 4.5,
      age: 3,
      isCastrated: false,
    },
  },
  {
    name: "Dermatite",
    pet: "Thor, Labrador, diagnóstico de dermatite atópica",
    payload: {
      name: "Thor",
      breed: "Labrador",
      species: "cachorro",
      sex: "macho",
      weight: 28.5,
      age: 3,
      isCastrated: false,
      diagnostico: "dermatite atópica",
      resumo: "prurido e lesão de pele",
    },
  },
  {
    name: "Comportamento",
    pet: "Thor, Labrador, relato de coceira nas patas",
    payload: {
      name: "Thor",
      breed: "Labrador",
      species: "cachorro",
      sex: "macho",
      weight: 28.5,
      age: 3,
      isCastrated: false,
      comportamento: [
        { data: "2026-10-01", relato: "coceira e prurido nas patas" },
      ],
    },
  },
  {
    name: "Vacina e medicamento",
    pet: "Thor, Labrador, V10 em 2026-08-01 e prednisolona desde 2026-09-01",
    payload: {
      name: "Thor",
      breed: "Labrador",
      species: "cachorro",
      sex: "macho",
      weight: 28.5,
      age: 3,
      isCastrated: false,
      vacinasAplicadas: [{ nome: "V10", data: "2026-08-01" }],
      medicamentos: [{ nome: "prednisolona", desde: "2026-09-01" }],
    },
  },
];

function parseTiming(header) {
  const timings = {};
  for (const part of String(header ?? "").split(",")) {
    const bits = part.trim().split(";").map((bit) => bit.trim());
    const name = bits[0];
    const dur = bits.find((bit) => bit.startsWith("dur="));
    if (name && dur) timings[name] = dur.slice(4);
  }
  return timings;
}

function cell(value) {
  return String(value ?? "—").replaceAll("|", "/");
}

const rows = [];
for (const item of cases) {
  const response = await fetch(`${base}/v1/care-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item.payload),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error(`${item.name}: HTTP ${response.status}`);
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  const checked = spawnSync(process.execPath, ["scripts/assert-catalog.mjs", csvPath], {
    input: raw,
    cwd: root,
    encoding: "utf8",
  });
  if (checked.status !== 0) {
    console.error(checked.stderr || checked.stdout);
    process.exit(checked.status || 1);
  }

  const body = JSON.parse(raw);
  for (const planItem of body.carePlan) {
    if (!catalogNames.has(planItem.planItemName)) {
      console.error(`Item fora do catálogo em ${item.name}: ${planItem.planItemName}`);
      process.exit(1);
    }
  }

  const timing = parseTiming(response.headers.get("server-timing"));
  const sources = (body.sources ?? [])
    .map((source) => source.title)
    .filter(Boolean);
  rows.push({
    name: item.name,
    pet: item.pet,
    items: body.carePlan.map((planItem) => planItem.planItemName).join(", "),
    sources: sources.length ? sources.join(", ") : "nenhuma",
    description: body.carePlanDescription,
    timing,
  });
  console.log(checked.stdout.trim());
}

const measuredAt = new Date().toISOString();
const timingNames = ["cache", "embed", "vector", "catalog", "llm", "post", "total"];
const header = ["Caso", "Pet", "Itens", "Fontes", ...timingNames];
const lines = [
  "# Resultados do plano de cuidados",
  "",
  `Medido em ${measuredAt} contra \`${base}\`. Cada linha é uma resposta real de \`POST /v1/care-plan\`. Itens conferidos com \`api/data/clinica-catalogo.csv\`. Tempos em milissegundos, lidos do header \`Server-Timing\`.`,
  "",
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => {
    const values = [
      row.name,
      row.pet,
      row.items,
      row.sources,
      ...timingNames.map((name) => row.timing[name] ?? "—"),
    ];
    return `| ${values.map(cell).join(" | ")} |`;
  }),
  "",
  "## Descrições",
  "",
  ...rows.flatMap((row) => [`### ${row.name}`, "", row.description, ""]),
  "Para repetir: `node scripts/report-results.mjs`.",
  "",
];

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"));
console.log(`Gravado ${outPath}`);
