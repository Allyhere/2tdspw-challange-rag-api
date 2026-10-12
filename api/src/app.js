import cors from "cors";
import express from "express";
import { apiReference } from "@scalar/express-api-reference";
import { z } from "zod";

import { config } from "./config.js";
import {
  createAuthMiddleware,
  createFirebaseIdentityService,
} from "./auth.js";
import { createConversations } from "./conversation.js";
import { createRateLimiter } from "./rateLimit.js";
import { runIngest as defaultRunIngest } from "./ingest.js";
import { formatServerTiming, generateCarePlan } from "./rag.js";
import { openApiDocument } from "./openapi.js";
import {
  conversationIntakeSchema,
  conversationListSchema,
  inboundMessageSchema,
  petInputSchema,
} from "./schema.js";

export const ingestRequestSchema = z.object({
  force: z.boolean().optional(),
});

export function createApp({
  runIngest = defaultRunIngest,
  conversations = createConversations(),
  identityService = createFirebaseIdentityService(),
  rateLimiter = createRateLimiter(),
} = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origem não permitida"));
      },
    }),
  );
  app.use(express.json({ limit: config.limits.json }));
  const authenticate = createAuthMiddleware(identityService);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      provider: "gemini",
      chatModel: config.gemini.chatModel,
      embedModel: config.gemini.embedModel,
    });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });

  app.use(
    "/docs",
    apiReference({
      content: openApiDocument,
    }),
  );

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

  app.post("/v1/conversations", authenticate, rateLimiter, async (req, res) => {
    const parsed = conversationIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Payload inválido",
        issues: parsed.error.flatten(),
      });
    }

    try {
      if (req.actor.role !== "vet") {
        return res.status(403).json({ message: "Apenas veterinários podem convidar" });
      }
      const owner = await identityService.resolveOwnerByPhone(
        parsed.data.tutor.phone,
      );
      const result = await conversations.start(parsed.data, {
        actor: req.actor,
        owner,
      });
      return res.json(result);
    } catch (error) {
      const status = error.status || 502;
      if (status >= 500) console.error("Erro ao iniciar conversa:", error);
      return res.status(status).json({
        message: error.message || "Falha ao iniciar a conversa",
      });
    }
  });

  app.get("/v1/conversations", authenticate, rateLimiter, async (req, res) => {
    const parsed = conversationListSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Parâmetros inválidos",
        issues: parsed.error.flatten(),
      });
    }
    try {
      return res.json(
        await conversations.list({ actor: req.actor, ...parsed.data }),
      );
    } catch (error) {
      return res.status(error.status || 502).json({
        message: error.message || "Falha ao listar conversas",
      });
    }
  });

  app.get("/v1/conversations/:id", authenticate, rateLimiter, async (req, res) => {
    try {
      const found = await conversations.get(req.params.id, req.actor);
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

  app.post(
    "/v1/conversations/:id/messages",
    authenticate,
    rateLimiter,
    async (req, res) => {
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
        idempotencyKey: parsed.data.idempotencyKey,
        providerMessageId: parsed.data.providerMessageId,
        actor: req.actor,
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
    },
  );

  app.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") {
      return res.status(413).json({ message: "Payload muito grande" });
    }
    if (error.message === "Origem não permitida") {
      return res.status(403).json({ message: error.message });
    }
    console.error("Erro HTTP:", error);
    return res.status(500).json({ message: "Erro interno" });
  });

  return app;
}
