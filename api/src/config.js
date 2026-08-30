export const config = {
  port: Number(process.env.PORT || 3000),
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    user: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    embedModel: process.env.EMBED_MODEL || "embeddinggemma",
    chatModel: process.env.NLP_MODEL || "llama3.2:3b",
    numPredict: Number(process.env.OLLAMA_NUM_PREDICT || 64),
    numCtx: Number(process.env.OLLAMA_NUM_CTX || 2048),
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || "24h",
  },
  vector: {
    indexName: "guideline_index",
    nodeLabel: "GuidelineChunk",
    textNodeProperty: "texto",
    embeddingNodeProperty: "embedding",
    dimensions: 768,
    k: 4,
  },
};
