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
      // Aura is TLS-only. Routing (neo4j://) discovery fails on many PaaS
      // networks; bolt+s talks to the instance directly.
      parsed.protocol = parsed.protocol.includes("ssc") ? "bolt+ssc:" : "bolt+s:";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return uri;
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
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
