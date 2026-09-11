import cors from "cors";
import express from "express";

import { config } from "./config.js";
import { closeDriver } from "./neo4j.js";
import { formatServerTiming, generateCarePlan } from "./rag.js";
import { petInputSchema } from "./schema.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "gemini",
    chatModel: config.gemini.chatModel,
    embedModel: config.gemini.embedModel,
  });
});

app.post("/v1/care-plan", async (req, res) => {
  console.log("POST /v1/care-plan", req.body?.name, req.body?.breed);
  const parsed = petInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Payload inválido",
      issues: parsed.error.flatten(),
    });
  }

  try {
    const { plan, timings } = await generateCarePlan(parsed.data);
    res.set("Server-Timing", formatServerTiming(timings));
    return res.json(plan);
  } catch (error) {
    console.error("Erro no plano de cuidados:", error);
    const status = error.status || 502;
    return res.status(status).json({
      message: error.message || "Falha ao gerar o plano de cuidados",
    });
  }
});

const server = app.listen(config.port, () => {
  console.log(`API RAG em http://localhost:${config.port}`);
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

async function shutdown() {
  server.close();
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
