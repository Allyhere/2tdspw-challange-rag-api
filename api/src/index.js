import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDriver } from "./neo4j.js";

const app = createApp();

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
