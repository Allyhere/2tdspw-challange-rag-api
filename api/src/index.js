import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDriver, getDriver } from "./neo4j.js";

const app = createApp();

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
  server.close();
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
