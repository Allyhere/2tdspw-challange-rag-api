import { randomUUID } from "node:crypto";

import { getDriver } from "./neo4j.js";

function cloneConversation(conversation) {
  return structuredClone(conversation);
}

function nowIso() {
  return new Date().toISOString();
}

export function createMemoryConversationStore() {
  const conversations = new Map();

  return {
    async create({ tutor, pet, carePlan, channel, status }) {
      const createdAt = nowIso();
      const conversation = {
        id: randomUUID(),
        status,
        channel,
        tutor,
        pet,
        carePlan,
        createdAt,
        updatedAt: createdAt,
        messages: [],
      };
      conversations.set(conversation.id, conversation);
      return cloneConversation(conversation);
    },

    async get(id) {
      const found = conversations.get(id);
      return found ? cloneConversation(found) : null;
    },

    async appendMessage(conversationId, { role, body, channel, providerMessageId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      const message = {
        id: randomUUID(),
        role,
        body,
        channel: channel ?? conversation.channel,
        providerMessageId: providerMessageId ?? null,
        createdAt: nowIso(),
      };
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      return structuredClone(message);
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
  conversationConstraintReady = true;
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
    status: props.status,
    channel: props.channel,
    tutor: JSON.parse(props.tutorJson),
    pet: JSON.parse(props.petJson),
    carePlan: JSON.parse(props.carePlanJson),
    createdAt: toIso(props.createdAt),
    updatedAt: toIso(props.updatedAt),
    messages,
  };
}

function messageFromNode(node) {
  const props = node.properties;
  return {
    id: props.id,
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
    async create({ tutor, pet, carePlan, channel, status }) {
      const id = randomUUID();
      return withSession(async (session) => {
        const result = await session.run(
          `
          CREATE (c:Conversation {
            id: $id,
            status: $status,
            channel: $channel,
            tutorJson: $tutorJson,
            petJson: $petJson,
            carePlanJson: $carePlanJson,
            createdAt: datetime(),
            updatedAt: datetime()
          })
          RETURN c
          `,
          {
            id,
            status,
            channel,
            tutorJson: JSON.stringify(tutor),
            petJson: JSON.stringify(pet),
            carePlanJson: JSON.stringify(carePlan),
          },
        );
        return conversationFromNode(result.records[0].get("c"), []);
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

    async appendMessage(conversationId, { role, body, channel, providerMessageId }) {
      const id = randomUUID();
      return withSession(async (session) => {
        const result = await session.run(
          `
          MATCH (c:Conversation {id: $conversationId})
          CREATE (m:Message {
            id: $id,
            role: $role,
            body: $body,
            channel: $channel,
            providerMessageId: $providerMessageId,
            createdAt: datetime()
          })-[:IN]->(c)
          SET c.updatedAt = datetime()
          RETURN m
          `,
          {
            conversationId,
            id,
            role,
            body,
            channel: channel ?? "api",
            providerMessageId: providerMessageId ?? null,
          },
        );
        const record = result.records[0];
        if (!record) return null;
        return messageFromNode(record.get("m"));
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
  };
}
