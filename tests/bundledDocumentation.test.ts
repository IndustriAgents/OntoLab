import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { createLocalStore } from "../server/store/local.ts";
import { silentLogger } from "../server/services/context.ts";
import { documentationForPath, DOCUMENTATION_URL } from "../src/lib/documentation.ts";
let directory: string, server: http.Server, origin: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ontolab-docs-"));
  const docs = join(directory, "docs");
  await mkdir(join(docs, "guides/ask"), { recursive: true });
  await mkdir(join(docs, "pagefind"));
  await writeFile(join(directory, "index.html"), "APP_SHELL");
  await writeFile(join(docs, "index.html"), "DOCS_HOME");
  await writeFile(join(docs, "guides/ask/index.html"), "ASK_GUIDE");
  await writeFile(join(docs, "404.html"), "DOCS_NOT_FOUND");
  await writeFile(join(docs, "pagefind/pagefind.wasm"), "WASM");
  await writeFile(join(directory, "private.txt"), "NOT_PUBLIC");
  await symlink(join(directory, "private.txt"), join(docs, "escape.txt"));
  server = http.createServer(
    createApp({
      store: createLocalStore(join(directory, "data")),
      auth: { mode: "local", authenticate: async () => null },
      log: silentLogger,
      distDir: directory,
      basePath: "/ontolab",
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
describe("bundled documentation", () => {
  it("serves documentation without returning the SPA for directories or unknown articles", async () => {
    expect(await (await fetch(origin + "/ontolab/docs/")).text()).toBe("DOCS_HOME");
    expect(await (await fetch(origin + "/ontolab/docs/guides/ask/")).text()).toBe("ASK_GUIDE");
    const missing = await fetch(origin + "/ontolab/docs/guides/missing/");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("DOCS_NOT_FOUND");
    expect((await fetch(origin + "/ontolab/docs/pagefind/missing.js")).status).toBe(404);
    const head = await fetch(origin + "/ontolab/docs/guides/ask/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  it("preserves the mount and return path on canonical redirects, and serves WASM locally", async () => {
    const r = await fetch(origin + "/ontolab/docs?returnTo=%2Fontolab%2Fp%2Fproject", { redirect: "manual" });
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/ontolab/docs/?returnTo=%2Fontolab%2Fp%2Fproject");
    const guide = await fetch(origin + "/ontolab/docs/guides/ask?x=1", { redirect: "manual" });
    expect(guide.headers.get("location")).toBe("/ontolab/docs/guides/ask/?x=1");
    expect((await fetch(origin + "/ontolab/docs/pagefind/pagefind.wasm")).headers.get("content-type")).toBe("application/wasm");
  });
  it("rejects traversal and symlink escape without weakening API authentication", async () => {
    for (const path of ["escape.txt", "%2e%2e%2fprivate.txt", "%5c..%5cprivate.txt"])
      expect((await fetch(origin + "/ontolab/docs/" + path)).status).toBe(403);
    expect((await fetch(origin + "/ontolab/docs/%ZZ")).status).toBe(400);
    expect((await fetch(origin + "/ontolab/docs/", { method: "POST" })).status).toBe(405);
    expect((await fetch(origin + "/ontolab/api/projects")).status).toBe(401);
  });
  it("links contextual help to bundled articles and preserves workspace queries", () => {
    expect(DOCUMENTATION_URL).toBe("/docs/");
    const url = new URL(documentationForPath("/p/id/graph", "?tab=updates"), origin);
    expect(url.pathname).toBe("/docs/guides/extract-abox/");
    expect(url.searchParams.get("returnTo")).toBe("/p/id/graph?tab=updates");
    expect(documentationForPath("/settings", "?section=connections")).toContain("guides/graph-connections/");
    expect(documentationForPath("/p/id", "", "#requirements")).toContain("concepts/requirements/");
  });
});
