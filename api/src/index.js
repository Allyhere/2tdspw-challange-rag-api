import { config } from "./config.js";
import { createApp } from "./app.js";
import { createChatWebhookWorker } from "./chatWebhook.js";
import { createConversations } from "./conversation.js";
import { createNeo4jConversationStore } from "./conversationStore.js";
import { closeDriver, getDriver } from "./neo4j.js";

const store = createNeo4jConversationStore();
const conversations = createConversations({
  store,
  notifyTutorMessages: Boolean(config.nest.webhookUrl),
});
const chatWebhookWorker = createChatWebhookWorker({
  store,
  url: config.nest.webhookUrl,
  secret: config.nest.webhookSecret,
});
chatWebhookWorker.start();

const app = createApp({ conversations });

const server = app.listen(config.port, () => {
  console.log(`API RAG em http://localhost:${config.port}`);
  getDriver()
    .verifyConnectivity()
    .then(() => console.log("Neo4j connected"))
    .catch((error) => {
      console.error(
        "Neo4j not reachable at boot:",
        error.message,
        "— If Aura Free, resume the instance and wait until the hostname resolves. NEO4J_URI must be the Connect URI (neo4j+s://….databases.neo4j.io).",
      );
    });
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

async function shutdown() {
  chatWebhookWorker.stop();
  server.close();
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
