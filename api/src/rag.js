import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiEmbed, geminiGenerateJson } from "./gemini.js";
import {
  getDriver,
  findTreatmentsForPet,
  getCachedCarePlan,
  saveCachedCarePlan,
  searchGuidelineChunks,
} from "./neo4j.js";
import { llmCarePlanSchema } from "./schema.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const promptTemplate = readFileSync(join(rootDir, "prompts/carePlan.md"), "utf8");

function hasConsultaContext(pet) {
  const resumo = String(pet.resumo ?? "").trim();
  const diagnostico = String(pet.diagnostico ?? "").trim();
  const prescription = Array.isArray(pet.prescription) ? pet.prescription : [];
  const exams = Array.isArray(pet.exams) ? pet.exams : [];
  return Boolean(
    resumo ||
      diagnostico ||
      prescription.length ||
      exams.length ||
      pet.currentTreatments !== undefined,
  );
}

function buildPetQuery(pet) {
  const sexo = pet.sex === "femea" ? "fêmea" : "macho";
  const castrado = pet.isCastrated ? "castrado" : "não castrado";
  let query = `${pet.species} da raça ${pet.breed}, ${pet.weight}kg, ${pet.age} anos, ${sexo}, ${castrado}`;
  const resumo = String(pet.resumo ?? "").trim();
  const diagnostico = String(pet.diagnostico ?? "").trim();
  if (resumo) query += `. Resumo da consulta: ${resumo}`;
  if (diagnostico) query += `. Diagnóstico: ${diagnostico}`;
  if (Array.isArray(pet.prescription) && pet.prescription.length > 0) {
    query += `. Prescrição: ${pet.prescription.join(", ")}`;
  }
  if (Array.isArray(pet.exams) && pet.exams.length > 0) {
    query += `. Exames: ${pet.exams.map((exam) => exam.name).join(", ")}`;
  }
  return query;
}

function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("A resposta do modelo não contém JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function clampDuration(months) {
  return Math.min(60, Math.max(1, Number(months) || 1));
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findCatalogMatch(rawName, catalog) {
  const exact = catalog.find((item) => item.nome === rawName);
  if (exact) return exact;

  const needle = normalizeName(rawName);
  if (!needle) return null;

  const exactNorm = catalog.find((item) => normalizeName(item.nome) === needle);
  if (exactNorm) return exactNorm;

  const scored = catalog
    .map((item) => {
      const name = normalizeName(item.nome);
      if (!name) return null;
      if (needle.includes(name) || name.includes(needle)) {
        return { item, score: name.length };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.item ?? null;
}

function toPlanItem(match) {
  const recurrency =
    match.recorrencia === "recurrent" || match.recorrencia === "recurrent"
      ? "recurrent"
      : "single";
  return {
    planItemName: match.nome,
    planRecurrency: recurrency,
    ...(recurrency === "recurrent"
      ? {
          planRecurrencyRate:
            Number(match.intervaloMeses) || Number(match.intervaloMeses) || 12,
        }
      : {}),
    planDurationInMonths: clampDuration(
      match.duracaoPadraoMeses ?? match.duracaoPadraoMeses,
    ),
  };
}

function catalogAsPlan(catalog) {
  return catalog.slice(0, 8).map((item) => toPlanItem(item));
}

function planFromIds(ids, catalog) {
  const kept = [];
  const seen = new Set();
  for (const raw of ids) {
    const byId = catalog.find((item) => item.id === raw);
    const match = byId || findCatalogMatch(raw, catalog);
    if (!match || seen.has(match.id || match.nome)) continue;
    seen.add(match.id || match.nome);
    kept.push(toPlanItem(match));
  }
  return kept;
}

function petNoun(pet) {
  const female = pet.sex === "femea";
  if (pet.species === "gato") return female ? "gata" : "gato";
  return female ? "cadela" : "cão";
}

function frequencyLabel(item) {
  if (item.planRecurrency !== "recurrent") return "";
  const months = Number(item.planRecurrencyRate) || 12;
  if (months === 1) return "todo mês";
  if (months === 12) return "1×/ano";
  return `a cada ${months} meses`;
}

function consultaNote(pet) {
  const diagnostico = String(pet.diagnostico ?? "").trim();
  const resumo = String(pet.resumo ?? "").trim();
  if (diagnostico) return ` Diagnóstico da consulta: ${diagnostico}.`;
  if (resumo) return ` Quadro da consulta: ${resumo}.`;
  return "";
}

function fallbackDescription(pet, carePlan) {
  const female = pet.sex === "femea";
  const article = female ? "uma" : "um";
  const status = pet.isCastrated
    ? female
      ? "castrada"
      : "castrado"
    : female
      ? "não castrada"
      : "não castrado";
  const bio = `${pet.name} é ${article} ${petNoun(pet)} ${String(pet.breed).toLowerCase()} de ${pet.age} anos, ${pet.weight} kg e ${status}.`;

  if (pet.currentTreatments !== undefined) {
    if (pet.currentTreatments.length === 0) {
      return `${bio}${consultaNote(pet)} Não há tratamentos no plano atual.`;
    }
    return `${bio}${consultaNote(pet)} O plano atual inclui ${pet.currentTreatments.join(", ")}.`;
  }

  const priorities = carePlan
    .map((item) => {
      const freq = frequencyLabel(item);
      return freq ? `${item.planItemName} ${freq}` : item.planItemName;
    })
    .join(", ");
  return `${bio}${consultaNote(pet)} O plano prioriza ${priorities}.`;
}

function splitPrompt(template) {
  const marker = "\n---USER---\n";
  const index = template.indexOf(marker);
  if (index === -1) {
    return { system: "", user: template.trim() };
  }
  return {
    system: template.slice(0, index).replace(/^---SYSTEM---\n/, "").trim(),
    user: template.slice(index + marker.length).trim(),
  };
}

function uniqueSources(chunks) {
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    if (!chunk.titulo || seen.has(chunk.url || chunk.titulo)) continue;
    seen.add(chunk.url || chunk.titulo);
    sources.push({
      title: chunk.titulo,
      ...(chunk.url ? { url: chunk.url } : {}),
      ...(chunk.editora ? { publisher: chunk.editora } : {}),
    });
  }
  return sources;
}

async function invokeModel(pet, catalog) {
  const catalogText = catalog
    .map(
      (item) =>
        `- ${item.id}: ${item.nome} (${item.tipo}, ${item.recorrencia}${
          item.intervaloMeses ? ` a cada ${item.intervaloMeses} meses` : ""
        })`,
    )
    .join("\n");

  const filled = promptTemplate
    .replace("{pet}", JSON.stringify(pet, null, 2))
    .replace("{catalog}", catalogText || "(catálogo vazio)");
  const { system, user } = splitPrompt(filled);

  const raw = await geminiGenerateJson({ system, user });
  console.log("LLM raw:", raw.slice(0, 800));
  const parsed = extractJson(raw);
  return llmCarePlanSchema.parse(parsed);
}

function roundMs(value) {
  return Math.round(value);
}

function emptyTimings() {
  return {
    cache: 0,
    embed: 0,
    vector: 0,
    catalog: 0,
    llm: 0,
    post: 0,
    total: 0,
    cacheStatus: "miss",
  };
}

export function formatServerTiming(timings) {
  const metrics = [
    ["cache", timings.cache, timings.cacheStatus],
    ["embed", timings.embed],
    ["vector", timings.vector],
    ["catalog", timings.catalog],
    ["llm", timings.llm],
    ["post", timings.post],
    ["total", timings.total],
  ];
  return metrics
    .map(([name, dur, desc]) =>
      desc ? `${name};dur=${dur};desc="${desc}"` : `${name};dur=${dur}`,
    )
    .join(", ");
}

export async function generateCarePlan(pet) {
  const totalStart = performance.now();
  const timings = emptyTimings();
  const skipCache = hasConsultaContext(pet);

  const cacheStart = performance.now();
  const cached = skipCache ? null : await getCachedCarePlan(pet);
  timings.cache = roundMs(performance.now() - cacheStart);
  if (cached?.carePlan) {
    timings.cacheStatus = "hit";
    timings.total = roundMs(performance.now() - totalStart);
    console.log("Cache hit plano de cuidados");
    return {
      plan: {
        carePlanDescription: fallbackDescription(pet, cached.carePlan),
        carePlan: cached.carePlan,
        sources: cached.sources ?? [],
      },
      timings,
    };
  }
  if (skipCache) {
    timings.cacheStatus = "bypass";
  }

  const query = buildPetQuery(pet);
  const embedStart = performance.now();
  const catalogStart = performance.now();
  const [[embedding], catalog] = await Promise.all([
    geminiEmbed([query], "RETRIEVAL_QUERY"),
    findTreatmentsForPet(pet),
  ]);
  timings.embed = roundMs(performance.now() - embedStart);
  timings.catalog = roundMs(performance.now() - catalogStart);
  if (catalog.length === 0) {
    const error = new Error("Nenhum item do catálogo se aplica a este pet");
    error.status = 502;
    throw error;
  }

  const vectorStart = performance.now();
  const chunks = await searchGuidelineChunks(embedding);
  timings.vector = roundMs(performance.now() - vectorStart);

  let ids = [];
  const llmStart = performance.now();
  try {
    const generated = await invokeModel(pet, catalog);
    ids = generated.ids ?? [];
  } catch (error) {
    console.warn("LLM falhou, usando só o catálogo:", error.message);
  }
  timings.llm = roundMs(performance.now() - llmStart);

  let carePlan = planFromIds(ids, catalog);
  if (carePlan.length === 0) {
    console.warn(
      "Modelo não copiou ids do catálogo:",
      ids,
      "— usando itens do Cypher",
    );
    carePlan = catalogAsPlan(catalog);
  }

  const postStart = performance.now();
  try {
    await getDriver().verifyConnectivity();
  } catch (error) {
    console.warn("Neo4j reconnect:", error.message);
  }
  const plan = {
    carePlanDescription: fallbackDescription(pet, carePlan),
    carePlan,
    sources: uniqueSources(chunks),
  };
  if (!skipCache) {
    await saveCachedCarePlan(pet, {
      carePlan: plan.carePlan,
      sources: plan.sources,
    });
  }
  timings.post = roundMs(performance.now() - postStart);
  timings.total = roundMs(performance.now() - totalStart);
  return { plan, timings };
}
