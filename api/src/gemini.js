import { config } from "./config.js";

const BATCH_SIZE = 16;

function requireKey() {
  if (!config.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY não definida");
  }
}

function endpoint(model, method) {
  return `${config.gemini.baseUrl}/models/${encodeURIComponent(model)}:${method}`;
}

function retryDelayMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (header == null || header === "") return 250;
  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(waitMs)) return 250;
  return Math.min(Math.max(0, waitMs), 2000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postGemini(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.gemini.apiKey,
    },
    body: JSON.stringify(body),
  });
}

async function geminiFetch(url, body) {
  requireKey();
  let response = await postGemini(url, body);
  if (response.status === 429 || response.status === 503) {
    await delay(retryDelayMs(response));
    response = await postGemini(url, body);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload.error?.message || payload.message || `Gemini HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function l2Normalize(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return values;
  return values.map((value) => value / norm);
}

export const IDS_SCHEMA = {
  type: "OBJECT",
  properties: {
    ids: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["ids"],
};

export async function geminiGenerateJson({
  system,
  user,
  responseSchema = IDS_SCHEMA,
  maxOutputTokens = 256,
}) {
  const payload = await geminiFetch(
    endpoint(config.gemini.chatModel, "generateContent"),
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema,
      },
    },
  );

  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini não devolveu texto JSON");
  }
  return text;
}

export async function geminiEmbed(texts, taskType) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const payload = await geminiFetch(
      endpoint(config.gemini.embedModel, "batchEmbedContents"),
      {
        requests: slice.map((text) => ({
          model: `models/${config.gemini.embedModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: config.vector.dimensions,
        })),
      },
    );
    const embeddings = payload.embeddings ?? [];
    if (embeddings.length !== slice.length) {
      throw new Error(
        `Gemini embeddings: esperado ${slice.length}, veio ${embeddings.length}`,
      );
    }
    for (const item of embeddings) {
      const values = item.values;
      if (!Array.isArray(values) || values.length !== config.vector.dimensions) {
        throw new Error(
          `Embedding com ${values?.length ?? 0} dimensões; esperado ${config.vector.dimensions}`,
        );
      }
      vectors.push(l2Normalize(values));
    }
  }
  return vectors;
}

export async function pingGemini() {
  requireKey();
  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.chatModel)}`;
  const response = await fetch(url, {
    headers: { "x-goog-api-key": config.gemini.apiKey },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.error?.message || `Gemini HTTP ${response.status} ao listar o modelo`,
    );
  }
}
