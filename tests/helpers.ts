// Boots the real HTTP app on an ephemeral port with a temp-directory store and
// a header-based fake authenticator (`x-test-user: alice`), so tests exercise
// routing, auth, ownership and the services exactly as production does.

import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startDocumentWorker } from "../server/documentWorker.ts";
import { createApp } from "../server/app.ts";
import { createLocalStore } from "../server/store/local.ts";
import { silentLogger } from "../server/services/context.ts";
import { resetStepLimiter } from "../server/services/runs.ts";
import type { Authenticator } from "../server/auth.ts";
import type { ProjectDocument } from "../src/types/project.ts";
import type { Store } from "../server/store/types.ts";

export interface TestApp {
  url: string;
  dataDir: string;
  clock: { now: Date };
  as(user: string | null): Client;
  processDocuments(): Promise<number>;
  close(): Promise<void>;
}

export interface Client {
  get(path: string): Promise<Response>;
  json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  upload(
    path: string,
    name: string,
    bytes: Buffer | string,
    waitForProcessing?: boolean,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function startApp(opts: { store?: Store; distDir?: string } = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), "ontolab-test-"));
  const clock = { now: new Date("2026-10-01T10:00:00Z") };
  const auth: Authenticator = {
    mode: "local",
    authenticate: async (req) => {
      const u = req.headers["x-test-user"];
      return typeof u === "string" && u ? { user: { id: u } } : null;
    },
  };
  resetStepLimiter();
  const store = opts.store ?? createLocalStore(dataDir);
  const documentWorker = startDocumentWorker(store, silentLogger, { autoStart: false, now: () => clock.now });
  const server = http.createServer(createApp({ store, auth, log: silentLogger, now: () => clock.now, distDir: opts.distDir ?? dataDir }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const as = (user: string | null): Client => {
    const headers = (extra: Record<string, string> = {}) => ({ ...(user ? { "x-test-user": user } : {}), ...extra });
    return {
      get: (path) => fetch(url + path, { headers: headers() }),
      async json(method, path, body) {
        const res = await fetch(url + path, {
          method,
          headers: headers(body !== undefined ? { "content-type": "application/json" } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
      },
      async upload(path, name, bytes, waitForProcessing = true) {
        const res = await fetch(url + path, {
          method: "POST",
          headers: headers({ "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }),
          body: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        // Most workflow tests need a ready input; explicitly exercise the separate HTTP stages.
        if (waitForProcessing && res.ok && body.document) {
          await documentWorker?.tick();
          const original = body.document as ProjectDocument;
          const list = await this.json<{ documents: ProjectDocument[] }>("GET", path);
          let doc = list.body.documents.find((d) => d.id === original.id)!;
          if (doc.parseState === "parsed" && doc.charCount && !doc.chunkCount) {
            const settings = { method: "paragraph", maxChars: 12000, overlap: 0.12 };
            const preview = await this.json<{ textHash: string }>("POST", `${path}/${doc.id}/chunk-preview`, settings);
            doc = (
              await this.json<{ document: typeof doc }>("POST", `${path}/${doc.id}/chunk-variant`, {
                settings,
                textHash: preview.body.textHash,
              })
            ).body.document;
          }
          body.document = doc;
        }
        return { status: res.status, body };
      },
    };
  };

  return {
    url,
    dataDir,
    clock,
    as,
    processDocuments: () => documentWorker?.tick() ?? Promise.resolve(0),
    async close() {
      await documentWorker?.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Drive a run with successive advance calls, as the browser does. */
export async function driveRun(c: Client, pid: string, runId: string, maxSteps = 200) {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < maxSteps; i++) {
    const r = await c.json<{ run: Record<string, unknown>; waitMs?: number }>("POST", `/api/projects/${pid}/runs/${runId}/advance`);
    last = r.body.run;
    if (["ready_for_review", "failed", "cancelled", "awaiting_answers"].includes(last.status as string)) return last;
  }
  return last;
}
