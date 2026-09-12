import cors from "cors";
import express from "express";
import { z } from "zod";

import { config } from "./config.js";
import { createConversations } from "./conversation.js";
import { runIngest as defaultRunIngest } from "./ingest.js";
import { formatServerTiming, generateCarePlan } from "./rag.js";
import {
  conversationIntakeSchema,
  inboundMessageSchema,
  petInputSchema,
} from "./schema.js";

export const ingestRequestSchema = z.object({
  force: z.boolean().optional(),
});

export function createApp({
  runIngest = defaultRunIngest,
  conversations = createConversations(),
} = {}) {
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

  app.post("/v1/ingest", async (req, res) => {
    const parsed = ingestRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        message: "Payload inválido",
        issues: parsed.error.flatten(),
      });
    }

    try {
      const summary = await runIngest({ force: parsed.data.force === true });
      return res.json(summary);
    } catch (error) {
      console.error("Erro na ingestão:", error);
      const status = error.status || 502;
      return res.status(status).json({
        message: error.message || "Falha ao ingerir documentos",
      });
    }
  });

  app.post("/v1/conversations", async (req, res) => {
    const parsed = conversationIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Payload inválido",
        issues: parsed.error.flatten(),
      });
    }

    try {
      const result = await conversations.start(parsed.data);
      return res.json(result);
    } catch (error) {
      console.error("Erro ao iniciar conversa:", error);
      const status = error.status || 502;
      return res.status(status).json({
        message: error.message || "Falha ao iniciar a conversa",
      });
    }
  });

  app.get("/v1/conversations/:id", async (req, res) => {
    try {
      const found = await conversations.get(req.params.id);
      if (!found) {
        return res.status(404).json({ message: "Conversa não encontrada" });
      }
      return res.json(found);
    } catch (error) {
      console.error("Erro ao ler conversa:", error);
      const status = error.status || 502;
      return res.status(status).json({
        message: error.message || "Falha ao ler a conversa",
      });
    }
  });

  app.post("/v1/conversations/:id/messages", async (req, res) => {
    const parsed = inboundMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Payload inválido",
        issues: parsed.error.flatten(),
      });
    }

    try {
      const result = await conversations.handleInbound({
        conversationId: req.params.id,
        text: parsed.data.text,
        providerMessageId: parsed.data.providerMessageId,
      });
      return res.json(result);
    } catch (error) {
      const status = error.status || 502;
      if (status >= 500) {
        console.error("Erro na mensagem da conversa:", error);
      }
      return res.status(status).json({
        message: error.message || "Falha ao processar a mensagem",
      });
    }
  });

  return app;
}
