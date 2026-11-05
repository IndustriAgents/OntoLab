// Local server for the built SPA, project API and provider proxy.

import "./env.ts";
import http from "node:http";
import { resolve } from "node:path";
import { listProviders } from "./providers.ts";
import { createApp } from "./app.ts";
import { createLocalAuth } from "./auth.ts";
import { enableLocalConnections } from "./connections/policy.ts";
import { json } from "./http.ts";
import { createLocalStore } from "./store/local.ts";
import { createPostgresStore } from "./store/postgres.ts";
import {
  PORT,
  BASE_PATH,
  STORE_MODE,
  DATABASE_URL,
  DATA_DIR,
  MOCK_LLM,
  WORKER_ENABLED,
  PARSER_URL,
  EMBEDDINGS_BACKEND,
  NLI_BACKEND,
} from "./config.ts";
import { consoleLogger } from "./services/context.ts";
import { startDocumentWorker } from "./documentWorker.ts";
import { startWorker } from "./worker.ts";

if (!["local", "postgres"].includes(STORE_MODE)) throw new Error("STORE_MODE must be local or postgres.");
if (STORE_MODE === "postgres" && !DATABASE_URL) throw new Error("Postgres storage requires DATABASE_URL.");

enableLocalConnections();
const store = STORE_MODE === "postgres" ? createPostgresStore(DATABASE_URL) : createLocalStore(DATA_DIR);
const documentWorker = startDocumentWorker(store, consoleLogger);
const worker = WORKER_ENABLED ? startWorker(store, consoleLogger) : null;
const app = createApp({
  store,
  auth: createLocalAuth(),
  workerEnabled: !!worker,
  ...(process.argv.includes("--local-docs") ? { docsDir: resolve(".data/bundled-docs") } : {}),
});
const server = http.createServer((req, res) => {
  const host = req.headers.host?.toLowerCase();
  // Vite preserves the browser's Host and Origin when proxying the local API.
  if (!host || !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    return json(res, { error: "OntoLab accepts requests from the local workspace only." }, 403);
  }
  app(req, res);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down.`);
  void worker?.stop();
  server.close(() => {
    void Promise.all([documentWorker?.stop(), worker?.stop()])
      .then(() => store.close?.())
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OntoLab server listening on http://localhost:${PORT}${BASE_PATH || ""}`);
  console.log(`Workspace: local single-user · storage: ${STORE_MODE}`);
  const configured = listProviders()
    .filter((p) => p.enabled)
    .map((p) => p.label);
  console.log(configured.length ? `Providers: ${configured.join(", ")}` : "No AI providers configured (set keys in .env).");
  console.log(
    `Parser: ${PARSER_URL ? `Docling sidecar (${PARSER_URL})` : "built-in"} · embeddings: ${EMBEDDINGS_BACKEND} · entailment: ${NLI_BACKEND} · worker: ${worker ? "on" : "off"}`,
  );
  if (MOCK_LLM) console.warn("MOCK_LLM=1 — the offline mock model is available. Do not enable this in production.");
});
