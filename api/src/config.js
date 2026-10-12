function trimEnv(value, fallback = "") {
  const text = String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return text || fallback;
}

export function normalizeNeo4jUri(raw) {
  const uri = trimEnv(raw, "bolt://localhost:7687");
  try {
    const parsed = new URL(uri);
    const host = parsed.hostname.toLowerCase();
    const isAura =
      host.endsWith(".databases.neo4j.io") || host.endsWith(".neo4j.io");
    if (isAura) {
      // Aura only serves the database on the routing URI. bolt+s authenticates
      // and then reports the database as missing.
      if (parsed.protocol === "bolt+ssc:" || parsed.protocol === "neo4j+ssc:") {
        parsed.protocol = "neo4j+ssc:";
      } else {
        parsed.protocol = "neo4j+s:";
      }
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return uri;
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  corsOrigins: trimEnv(
    process.env.CORS_ORIGINS,
    "http://localhost:5173,http://127.0.0.1:5173",
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  firebase: {
    projectId: trimEnv(process.env.FIREBASE_PROJECT_ID),
    clientEmail: trimEnv(process.env.FIREBASE_CLIENT_EMAIL),
    privateKey: trimEnv(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n"),
  },
  limits: {
    json: trimEnv(process.env.JSON_BODY_LIMIT, "32kb"),
    rateWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    rateMax: Number(process.env.RATE_LIMIT_MAX || 30),
    geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 20_000),
  },
  neo4j: {
    uri: normalizeNeo4jUri(process.env.NEO4J_URI),
    user: trimEnv(
      process.env.NEO4J_USER || process.env.NEO4J_USERNAME,
      "neo4j",
    ),
    password: trimEnv(process.env.NEO4J_PASSWORD, "password"),
  },
  gemini: {
    apiKey: trimEnv(process.env.GEMINI_API_KEY),
    baseUrl: trimEnv(
      process.env.GEMINI_BASE_URL,
      "https://generativelanguage.googleapis.com/v1beta",
    ),
    chatModel: trimEnv(process.env.NLP_MODEL, "gemini-3.5-flash-lite"),
    embedModel: trimEnv(process.env.EMBED_MODEL, "gemini-embedding-001"),
  },
  vector: {
    indexName: "guideline_index",
    nodeLabel: "GuidelineChunk",
    textNodeProperty: "texto",
    embeddingNodeProperty: "embedding",
    dimensions: Number(process.env.EMBED_DIMENSIONS || 768),
    k: Number(process.env.VECTOR_K || 8),
  },
};
