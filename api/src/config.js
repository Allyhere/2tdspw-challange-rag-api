export const config = {
  port: Number(process.env.PORT || 3000),
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    user: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta",
    chatModel: process.env.NLP_MODEL || "gemini-3.5-flash-lite",
    embedModel: process.env.EMBED_MODEL || "gemini-embedding-001",
  },
  vector: {
    indexName: "guideline_index",
    nodeLabel: "GuidelineChunk",
    textNodeProperty: "texto",
    embeddingNodeProperty: "embedding",
    dimensions: Number(process.env.EMBED_DIMENSIONS || 768),
    k: 4,
  },
};
