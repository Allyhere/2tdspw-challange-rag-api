import { randomUUID } from "node:crypto";

import neo4j from "neo4j-driver";

import { getDriver } from "./neo4j.js";

function cloneConversation(conversation) {
  return structuredClone(conversation);
}

function nowIso() {
  return new Date().toISOString();
}

export function createMemoryConversationStore() {
  const conversations = new Map();
  const conversationKeys = new Map();
  const webhooks = [];

  return {
    async create({
      key,
      vetFirebaseUid,
      ownerFirebaseUid,
      ownerPhone,
      tutor,
      pet,
      carePlan,
      planStepId,
      channel,
      status,
    }) {
      const existingId = conversationKeys.get(key);
      if (existingId) {
        return {
          conversation: cloneConversation(conversations.get(existingId)),
          created: false,
        };
      }
      const createdAt = nowIso();
      const conversation = {
        id: randomUUID(),
        key,
        vetFirebaseUid,
        ownerFirebaseUid,
        ownerPhone,
        planStepId,
        status,
        channel,
        tutor,
        pet,
        carePlan,
        agentEnabled: true,
        createdAt,
        updatedAt: createdAt,
        messages: [],
        pendingTurnKey: null,
      };
      conversations.set(conversation.id, conversation);
      conversationKeys.set(key, conversation.id);
      return { conversation: cloneConversation(conversation), created: true };
    },

    async get(id) {
      const found = conversations.get(id);
      return found ? cloneConversation(found) : null;
    },

    async list({ identityField, uid, limit, cursor }) {
      return [...conversations.values()]
        .filter((conversation) => conversation[identityField] === uid)
        .filter((conversation) => {
          if (!cursor) return true;
          return (
            conversation.updatedAt < cursor.updatedAt ||
            (conversation.updatedAt === cursor.updatedAt &&
              conversation.id < cursor.id)
          );
        })
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, limit)
        .map((conversation) => cloneConversation(conversation));
    },

    async appendMessage(
      conversationId,
      {
        role,
        body,
        channel,
        providerMessageId,
        dedupeKey,
        disableAgent = false,
        webhook = null,
      },
    ) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      const found = conversation.messages.find(
        (message) => message.dedupeKey === dedupeKey,
      );
      if (found) {
        return { message: structuredClone(found), created: false };
      }
      const message = {
        id: randomUUID(),
        dedupeKey,
        role,
        body,
        channel: channel ?? conversation.channel,
        providerMessageId: providerMessageId ?? null,
        createdAt: nowIso(),
      };
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      if (disableAgent) conversation.agentEnabled = false;
      if (webhook) {
        webhooks.push({
          id: randomUUID(),
          messageId: message.id,
          conversationId,
          body: {
            vetFirebaseUid: webhook.vetFirebaseUid,
            conversationId,
            tutorName: webhook.tutorName,
            petName: webhook.petName,
            text: webhook.text,
            messageId: message.id,
          },
          status: "pending",
          attempts: 0,
          nextAttemptAt: nowIso(),
        });
      }
      return { message: structuredClone(message), created: true };
    },

    async listDueWebhooks(now, limit = 20) {
      return webhooks
        .filter(
          (job) => job.status === "pending" && job.nextAttemptAt <= now,
        )
        .slice(0, limit)
        .map((job) => structuredClone(job));
    },

    async markWebhookDelivered(id) {
      const job = webhooks.find((item) => item.id === id);
      if (!job) return false;
      job.status = "delivered";
      return true;
    },

    async deferWebhook(id, nextAttemptAt, attempts) {
      const job = webhooks.find((item) => item.id === id);
      if (!job) return false;
      job.status = "pending";
      job.nextAttemptAt = nextAttemptAt;
      job.attempts = attempts;
      return true;
    },

    async acquireTurn(conversationId, turnKey) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.pendingTurnKey) return false;
      conversation.pendingTurnKey = turnKey;
      return true;
    },

    async releaseTurn(conversationId, turnKey) {
      const conversation = conversations.get(conversationId);
      if (conversation?.pendingTurnKey === turnKey) {
        conversation.pendingTurnKey = null;
      }
    },

    async updateStatus(conversationId, status) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      conversation.status = status;
      conversation.updatedAt = nowIso();
      return cloneConversation(conversation);
    },
  };
}

let conversationConstraintReady = false;

async function ensureConversationConstraint(session) {
  if (conversationConstraintReady) return;
  await session.run(`
    CREATE CONSTRAINT conversation_id IF NOT EXISTS
    FOR (c:Conversation) REQUIRE c.id IS UNIQUE
  `);
  await session.run(`
    CREATE CONSTRAINT message_id IF NOT EXISTS
    FOR (m:Message) REQUIRE m.id IS UNIQUE
  `);
  await session.run(`
    CREATE CONSTRAINT conversation_key IF NOT EXISTS
    FOR (c:Conversation) REQUIRE c.key IS UNIQUE
  `);
  await session.run(`
    CREATE CONSTRAINT message_dedupe_key IF NOT EXISTS
    FOR (m:Message) REQUIRE m.dedupeKey IS UNIQUE
  `);
  await session.run(`
    CREATE INDEX conversation_owner_updated IF NOT EXISTS
    FOR (c:Conversation) ON (c.ownerFirebaseUid, c.updatedAt)
  `);
  await session.run(`
    CREATE INDEX conversation_vet_updated IF NOT EXISTS
    FOR (c:Conversation) ON (c.vetFirebaseUid, c.updatedAt)
  `);
  await session.run(`
    CREATE CONSTRAINT chat_webhook_message IF NOT EXISTS
    FOR (w:ChatWebhook) REQUIRE w.messageId IS UNIQUE
  `);
  await session.run(`
    CREATE INDEX chat_webhook_due IF NOT EXISTS
    FOR (w:ChatWebhook) ON (w.status, w.nextAttemptAt)
  `);
  conversationConstraintReady = true;
}

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function conversationFromNode(node, messages = []) {
  const props = node.properties;
  return {
    id: props.id,
    key: props.key,
    vetFirebaseUid: props.vetFirebaseUid,
    ownerFirebaseUid: props.ownerFirebaseUid,
    ownerPhone: props.ownerPhone,
    planStepId: props.planStepId,
    status: props.status,
    channel: props.channel,
    tutor: JSON.parse(props.tutorJson),
    pet: JSON.parse(props.petJson),
    carePlan: JSON.parse(props.carePlanJson),
    agentEnabled: props.agentEnabled !== false,
    createdAt: toIso(props.createdAt),
    updatedAt: toIso(props.updatedAt),
    messages,
    pendingTurnKey: props.pendingTurnKey || null,
  };
}

function messageFromNode(node) {
  const props = node.properties;
  return {
    id: props.id,
    dedupeKey: props.dedupeKey,
    role: props.role,
    body: props.body,
    channel: props.channel,
    providerMessageId: props.providerMessageId || null,
    createdAt: toIso(props.createdAt),
  };
}

export function createNeo4jConversationStore({ getSession } = {}) {
  const sessionFn =
    getSession ??
    (async () => {
      const driver = getDriver();
      return driver.session();
    });

  async function withSession(run) {
    const session = await sessionFn();
    try {
      await ensureConversationConstraint(session);
      return await run(session);
    } finally {
      await session.close();
    }
  }

  return {
    async create({
      key,
      vetFirebaseUid,
      ownerFirebaseUid,
      ownerPhone,
      tutor,
      pet,
      carePlan,
      planStepId,
      channel,
      status,
    }) {
      const id = randomUUID();
      const createToken = randomUUID();
      return withSession(async (session) => {
        const result = await session.run(
          `
          MERGE (c:Conversation {key: $key})
          ON CREATE SET
            c.id = $id,
            c.vetFirebaseUid = $vetFirebaseUid,
            c.ownerFirebaseUid = $ownerFirebaseUid,
            c.ownerPhone = $ownerPhone,
            c.planStepId = $planStepId,
            c.status = $status,
            c.channel = $channel,
            c.tutorJson = $tutorJson,
            c.petJson = $petJson,
            c.carePlanJson = $carePlanJson,
            c.agentEnabled = true,
            c.createdAt = datetime(),
            c.updatedAt = datetime(),
            c.createToken = $createToken
          WITH c, c.createToken = $createToken AS created
          REMOVE c.createToken
          RETURN c, created
          `,
          {
            id,
            key,
            vetFirebaseUid,
            ownerFirebaseUid,
            ownerPhone,
            planStepId,
            status,
            channel,
            createToken,
            tutorJson: JSON.stringify(tutor),
            petJson: JSON.stringify(pet),
            carePlanJson: JSON.stringify(carePlan),
          },
        );
        const record = result.records[0];
        return {
          conversation: conversationFromNode(record.get("c"), []),
          created: record.get("created"),
        };
      });
    },

    async get(id) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (c:Conversation {id: $id})
          OPTIONAL MATCH (m:Message)-[:IN]->(c)
          WITH c, m
          ORDER BY m.createdAt, m.id
          RETURN c, collect(m) AS messages
          `,
          { id },
        );
        const record = result.records[0];
        if (!record) return null;
        const nodes = record.get("messages").filter(Boolean);
        const messages = nodes
          .filter((node) => node?.properties?.id)
          .map(messageFromNode);
        return conversationFromNode(record.get("c"), messages);
      });
    },

    async list({ identityField, uid, limit, cursor }) {
      if (!["ownerFirebaseUid", "vetFirebaseUid"].includes(identityField)) {
        throw new Error("Campo de identidade inválido");
      }
      return withSession(async (session) => {
        const cursorFilter = cursor
          ? `AND (
              c.updatedAt < datetime($cursorUpdatedAt)
              OR (c.updatedAt = datetime($cursorUpdatedAt) AND c.id < $cursorId)
            )`
          : "";
        const result = await session.run(
          `
          MATCH (c:Conversation)
          WHERE c.${identityField} = $uid
          ${cursorFilter}
          OPTIONAL MATCH (m:Message)-[:IN]->(c)
          WITH c, m
          ORDER BY m.createdAt DESC, m.id DESC
          WITH c, collect(m)[0] AS lastMessage
          RETURN c, lastMessage
          ORDER BY c.updatedAt DESC, c.id DESC
          LIMIT $limit
          `,
          {
            uid,
            limit: neo4j.int(limit),
            cursorUpdatedAt: cursor?.updatedAt ?? null,
            cursorId: cursor?.id ?? null,
          },
        );
        return result.records.map((record) => {
          const message = record.get("lastMessage");
          return conversationFromNode(
            record.get("c"),
            message?.properties?.id ? [messageFromNode(message)] : [],
          );
        });
      });
    },

    async appendMessage(
      conversationId,
      {
        role,
        body,
        channel,
        providerMessageId,
        dedupeKey,
        disableAgent = false,
        webhook = null,
      },
    ) {
      const id = randomUUID();
      const createToken = randomUUID();
      const webhookId = randomUUID();
      const webhookBody = webhook
        ? {
            vetFirebaseUid: webhook.vetFirebaseUid,
            conversationId,
            tutorName: webhook.tutorName,
            petName: webhook.petName,
            text: webhook.text,
            messageId: id,
          }
        : null;
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (c:Conversation {id: $conversationId})
          MERGE (m:Message {dedupeKey: $dedupeKey})
          ON CREATE SET
            m.id = $id,
            m.role = $role,
            m.body = $body,
            m.channel = $channel,
            m.providerMessageId = $providerMessageId,
            m.createdAt = datetime(),
            m.createToken = $createToken
          MERGE (m)-[:IN]->(c)
          WITH c, m, m.createToken = $createToken AS created
          FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
            SET c.updatedAt = m.createdAt
          )
          FOREACH (_ IN CASE WHEN created AND $disableAgent THEN [1] ELSE [] END |
            SET c.agentEnabled = false
          )
          FOREACH (_ IN CASE WHEN created AND $hasWebhook THEN [1] ELSE [] END |
            MERGE (w:ChatWebhook {messageId: m.id})
            ON CREATE SET
              w.id = $webhookId,
              w.conversationId = c.id,
              w.bodyJson = $webhookBody,
              w.status = 'pending',
              w.attempts = 0,
              w.nextAttemptAt = datetime()
          )
          REMOVE m.createToken
          RETURN m, created
          `,
          {
            conversationId,
            id,
            dedupeKey,
            createToken,
            role,
            body,
            channel: channel ?? "api",
            providerMessageId: providerMessageId ?? null,
            disableAgent,
            hasWebhook: Boolean(webhookBody),
            webhookId,
            webhookBody: webhookBody ? JSON.stringify(webhookBody) : null,
          },
        );
        const record = result.records[0];
        if (!record) return null;
        return {
          message: messageFromNode(record.get("m")),
          created: record.get("created"),
        };
      });
    },

    async acquireTurn(conversationId, turnKey) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (c:Conversation {id: $conversationId})
          WHERE c.pendingTurnKey IS NULL
          SET c.pendingTurnKey = $turnKey
          RETURN c.id AS id
          `,
          { conversationId, turnKey },
        );
        return result.records.length === 1;
      });
    },

    async releaseTurn(conversationId, turnKey) {
      return withSession(async (session) => {
        await session.run(
          `
          MATCH (c:Conversation {id: $conversationId})
          WHERE c.pendingTurnKey = $turnKey
          REMOVE c.pendingTurnKey
          `,
          { conversationId, turnKey },
        );
      });
    },

    async updateStatus(conversationId, status) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (c:Conversation {id: $id})
          SET c.status = $status, c.updatedAt = datetime()
          WITH c
          OPTIONAL MATCH (m:Message)-[:IN]->(c)
          WITH c, m
          ORDER BY m.createdAt, m.id
          RETURN c, collect(m) AS messages
          `,
          { id: conversationId, status },
        );
        const record = result.records[0];
        if (!record) return null;
        const nodes = record.get("messages").filter(Boolean);
        const messages = nodes
          .filter((node) => node?.properties?.id)
          .map(messageFromNode);
        return conversationFromNode(record.get("c"), messages);
      });
    },

    async listDueWebhooks(now, limit = 20) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (w:ChatWebhook)
          WHERE w.status = 'pending' AND w.nextAttemptAt <= datetime($now)
          RETURN w
          ORDER BY w.nextAttemptAt, w.id
          LIMIT $limit
          `,
          { now, limit: neo4j.int(limit) },
        );
        return result.records.map((record) => {
          const props = record.get("w").properties;
          return {
            id: props.id,
            messageId: props.messageId,
            conversationId: props.conversationId,
            body: JSON.parse(props.bodyJson),
            status: props.status,
            attempts: toNumber(props.attempts),
            nextAttemptAt: toIso(props.nextAttemptAt),
          };
        });
      });
    },

    async markWebhookDelivered(id) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (w:ChatWebhook {id: $id})
          SET w.status = 'delivered', w.deliveredAt = datetime()
          RETURN w.id AS id
          `,
          { id },
        );
        return result.records.length === 1;
      });
    },

    async deferWebhook(id, nextAttemptAt, attempts) {
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (w:ChatWebhook {id: $id})
          SET w.status = 'pending',
              w.nextAttemptAt = datetime($nextAttemptAt),
              w.attempts = $attempts
          RETURN w.id AS id
          `,
          { id, nextAttemptAt, attempts: neo4j.int(attempts) },
        );
        return result.records.length === 1;
      });
    },
  };
}
