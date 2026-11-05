import { acquireProfileLock } from "../mcp/profileLock.ts";
// A private, single-user transport around the existing HTTP application.
// The browser entry point in server/index.ts has its own loopback transport.
import http from "node:http";
import { dirname } from "node:path";
import { createLocalAgent } from "../mcp/local.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createApp } from "../app.ts";
import { createLocalAuth } from "../auth.ts";
import { createLocalStore } from "../store/local.ts";
import { startDocumentWorker } from "../documentWorker.ts";
import { startWorker } from "../worker.ts";
import { consoleLogger } from "../services/context.ts";
import { json } from "../http.ts";

export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export async function startDesktopServer(options: {
  dataDir: string;
  distDir: string;
  secret?: string;
  agentLaunch?: { command: string; args: string[] };
  onOpen?: (destination: string) => void;
}) {
  const secret = options.secret ?? randomBytes(32).toString("hex");
  if (secret.length < 32) throw new Error("Desktop sessions require a random secret of at least 32 characters.");
  const releaseProfile = await acquireProfileLock(dirname(options.dataDir));
  const store = createLocalStore(options.dataDir);
  const documentWorker = startDocumentWorker(store, consoleLogger);
  const worker = startWorker(store, consoleLogger);
  const shutdownController = new AbortController();
  const handler = createApp({
    shutdownSignal: shutdownController.signal,
    store,
    auth: createLocalAuth(),
    distDir: options.distDir,
    workerEnabled: !!worker,
    basePath: "",
  });
  const agent = await createLocalAgent({
    profileDir: dirname(options.dataDir),
    store,
    launch: options.agentLaunch,
    onOpen: options.onOpen,
  });
  let port = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-security-policy", DESKTOP_CONTENT_SECURITY_POLICY);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    const origin = `http://127.0.0.1:${port}`;
    // Exact Host and Origin checks also exclude DNS rebinding and cross-site calls.
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
      json(res, { error: "This workspace is only accessible from the desktop app." }, 403);
      return;
    }
    if (req.url?.startsWith("/api/local-agent/")) {
      void agent.handle(req, res, false);
      return;
    }
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`ontolab-desktop-${port}=`));
    const supplied = Buffer.from(cookie?.slice(cookie.indexOf("=") + 1) ?? "");
    const expected = Buffer.from(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(res, { error: "A desktop session is required." }, 401);
      return;
    }
    if (req.url?.startsWith("/api/local-mcp")) {
      void agent.handle(req, res, true);
      return;
    }
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  await agent.ready(`http://127.0.0.1:${port}`);
  let closing: Promise<void> | undefined;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    cookie: `ontolab-desktop-${port}=${secret}`,
    close(): Promise<void> {
      closing ??= (async () => {
        shutdownController.abort();
        const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        server.closeIdleConnections();
        await Promise.all([documentWorker?.stop(), worker?.stop(), closed]);
        await agent.close();
        await store.close?.();
        await releaseProfile();
      })();
      return closing;
    },
  };
}
