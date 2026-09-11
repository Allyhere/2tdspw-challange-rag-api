import { pingGemini } from "../src/gemini.js";
import { runIngest } from "../src/ingest.js";
import { closeDriver, getDriver } from "../src/neo4j.js";

async function waitForNeo4j(driver, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch {
      console.log("Aguardando Neo4j...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Neo4j não ficou pronto a tempo");
}

async function waitForGemini(attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await pingGemini();
      return;
    } catch (error) {
      if (i === attempts - 1) {
        throw new Error(`Gemini não respondeu: ${error.message}`);
      }
      console.log("Aguardando Gemini...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function seed() {
  const driver = getDriver();
  await waitForNeo4j(driver);
  await waitForGemini();
  const force = process.env.FORCE_INGEST === "true";
  try {
    await runIngest({ force });
    console.log("Seed concluído.");
  } finally {
    await closeDriver();
  }
}

seed().catch((error) => {
  console.error("Falha no seed:", error);
  process.exit(1);
});
