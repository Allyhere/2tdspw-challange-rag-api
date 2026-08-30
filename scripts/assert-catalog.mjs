import { readFileSync } from "node:fs";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Uso: assert-catalog.mjs <clinica-catalogo.csv>");
  process.exit(1);
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const names = new Set(
  readFileSync(csvPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[1])
    .filter(Boolean),
);

if (!body.carePlanDescription) {
  throw new Error("Falta carePlanDescription");
}
if (!Array.isArray(body.carePlan) || body.carePlan.length === 0) {
  throw new Error("carePlan vazio");
}
if (!Array.isArray(body.sources)) {
  throw new Error("Falta sources");
}

for (const item of body.carePlan) {
  if (!names.has(item.planItemName)) {
    throw new Error(`Item fora do catálogo: ${item.planItemName}`);
  }
  const duration = Number(item.planDurationInMonths);
  if (duration < 1 || duration > 60) {
    throw new Error(`Duração inválida em ${item.planItemName}: ${duration}`);
  }
  if (item.planRecurrency === "recurrent" && !item.planRecurrencyRate) {
    throw new Error(`Falta planRecurrencyRate em ${item.planItemName}`);
  }
}

console.log(
  `assert ok: ${body.carePlan.length} itens do catálogo, ${body.sources.length} fontes`,
);
