import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDesktopServer } from "../server/desktop/server.ts";

let root: string;
let app: Awaited<ReturnType<typeof startDesktopServer>>;

beforeEach(async () => {
  vi.stubEnv("LOCAL_CLI_ENABLED", "1");
  root = await mkdtemp(join(tmpdir(), "ontolab-desktop-test-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.html"), "<!doctype html><title>OntoLab desktop</title>");
  await mkdir(join(root, "dist", "docs", "guides", "ask"), { recursive: true });
  await writeFile(join(root, "dist", "docs", "guides", "ask", "index.html"), "<!doctype html><title>Ask documentation</title>");
  await writeFile(join(root, "dist", "docs", "search.wasm"), new Uint8Array([0, 97, 115, 109]));
  app = await startDesktopServer({ dataDir: join(root, "workspace"), distDir: join(root, "dist") });
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function request(path: string, init: RequestInit = {}) {
  return fetch(`${app.origin}${path}`, { ...init, headers: { cookie: app.cookie, ...init.headers } });
}

describe("private desktop workspace", () => {
  it("serves bundled documentation and search assets inside the private desktop session", async () => {
    expect((await fetch(`${app.origin}/docs/guides/ask/`)).status).toBe(401);
    const docs = await request("/docs/guides/ask/");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("Ask documentation");
    expect(docs.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(docs.headers.get("content-security-policy")).not.toContain("script-src 'self' 'unsafe-inline'");
    const search = await request("/docs/search.wasm");
    expect(search.status).toBe(200);
    expect(search.headers.get("content-type")).toBe("application/wasm");
    expect((await request("/docs/missing/")).status).toBe(404);
  });

  it("protects both the UI and API with a per-launch desktop session", async () => {
    expect((await fetch(app.origin)).status).toBe(401);
    expect((await fetch(`${app.origin}/api/projects`)).status).toBe(401);
    expect((await request("/api/projects", { headers: { cookie: `${app.cookie}wrong` } })).status).toBe(401);
    const home = await request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("OntoLab desktop");
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await request("/api/config").then((res) => res.json())).auth.mode).toBe("local");
  });

  it("rejects cross-origin and forged-host access even with a valid cookie", async () => {
    expect((await request("/api/projects", { headers: { origin: "https://unrelated.example" } })).status).toBe(403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${app.origin}/api/projects`, { headers: { host: "unrelated.example", cookie: app.cookie } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(forgedHostStatus).toBe(403);
    expect((await request("/api/projects", { headers: { origin: app.origin } })).status).toBe(200);
  });

  it("persists projects across restarts and invalidates the previous session", async () => {
    const created = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Desktop research" }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()).project;
    const oldSecret = app.cookie.slice(app.cookie.indexOf("=") + 1);
    await app.close();
    app = await startDesktopServer({ dataDir: join(root, "workspace"), distDir: join(root, "dist") });
    const projects = (await request("/api/projects").then((res) => res.json())).projects;
    expect(projects.map((value: { id: string }) => value.id)).toContain(project.id);
    expect((await request("/api/projects", { headers: { cookie: `ontolab-desktop-${app.port}=${oldSecret}` } })).status).toBe(401);
  });

  it("advertises local CLI providers with the existing compatibility checks", async () => {
    const providers = (await request("/api/providers").then((res) => res.json())).providers;
    for (const id of ["claude-cli", "codex-cli", "agy-cli"]) {
      expect(providers.find((provider: { id: string }) => provider.id === id)).toMatchObject({ id, kind: "cli" });
    }
    expect((await request("/api/config").then((res) => res.json())).features.worker).toBe(true);
  });
});
