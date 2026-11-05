import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isLocalHostname, providerGroups } from "../src/lib/providerGroups.ts";
import { isLocalCliConnection } from "../server/cli/localAccess.ts";
import { startApp, type TestApp } from "./helpers.ts";
import type { ProviderInfo } from "../src/lib/api.ts";
import { request } from "node:http";

const providers: ProviderInfo[] = [
  { id: "gemini", label: "Gemini", enabled: true, models: ["test"] },
  { id: "claude-cli", label: "Claude Code", kind: "cli", enabled: true, models: ["sonnet"] },
  { id: "codex-cli", label: "Codex", kind: "cli", enabled: false, models: ["default"] },
];

describe("local CLI visibility", () => {
  it.each(["localhost", "localhost.", "ontolab.localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "recognizes loopback host %s",
    (host) => expect(isLocalHostname(host)).toBe(true),
  );
  it.each([
    "ontolab.example.com",
    "localhost.example.com",
    "evil-localhost",
    "127.0.0.1.example.com",
    "192.168.1.5",
    "127.999.0.1",
    "",
    "::",
  ])("does not treat %s as a local session", (host) => expect(isLocalHostname(host)).toBe(false));
  it("separates API and CLI providers locally and removes the entire CLI group remotely", () => {
    const local = providerGroups(providers, "localhost");
    expect(local.map((group) => group.label)).toEqual(["APIs", "Local CLIs"]);
    expect(local[0].providers.map((provider) => provider.id)).toEqual(["gemini"]);
    expect(local[1].providers.map((provider) => provider.id)).toEqual(["claude-cli", "codex-cli"]);
    expect(providerGroups(providers, "ontolab.example.com")).toEqual([local[0]]);
    expect(providerGroups([providers[0]], "localhost")).toHaveLength(1);
  });
  it("requires both a loopback host and an actual loopback backend peer", () => {
    expect(isLocalCliConnection("localhost:5173", "::1")).toBe(true);
    expect(isLocalCliConnection("[::1]:5173", "::1")).toBe(true);
    expect(isLocalCliConnection("127.0.0.1:3000", "::ffff:127.0.0.1")).toBe(true);
    expect(isLocalCliConnection("ontolab.example.com", "127.0.0.1")).toBe(false);
    expect(isLocalCliConnection("localhost:3000", "192.168.1.20")).toBe(false);
    expect(isLocalCliConnection(undefined, "127.0.0.1")).toBe(false);
    expect(isLocalCliConnection("[invalid", "127.0.0.1")).toBe(false);
  });
});

describe("provider discovery over HTTP", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => vi.unstubAllEnvs());
  async function discover(host?: string, extraHeaders = {}) {
    // Fetch normalizes Host to its URL; use HTTP directly to exercise virtual-host routing.
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request(`${app.url}/api/providers`, { headers: { ...(host ? { host } : {}), ...extraHeaders } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    expect(response.status).toBe(200);
    return (JSON.parse(response.body) as { providers: ProviderInfo[] }).providers;
  }
  it("shows CLI providers to a local session when local CLI execution is enabled", async () => {
    vi.stubEnv("LOCAL_CLI_ENABLED", "1");
    vi.stubEnv("ONTOLAB_AGY_BIN", "/nonexistent/ontolab-agy");
    expect((await discover()).filter((provider) => provider.kind === "cli")).toHaveLength(3);
  });
  it("hides CLIs from public hosts even if a forwarded header claims localhost", async () => {
    vi.stubEnv("LOCAL_CLI_ENABLED", "1");
    const advertised = await discover("ontolab.example.com", { "x-forwarded-host": "localhost:5173", "x-forwarded-for": "127.0.0.1" });
    expect(advertised.some((provider) => provider.id === "gemini")).toBe(true);
    expect(advertised.some((provider) => provider.kind === "cli")).toBe(false);
  });
  it("omits the CLI group when the local runtime disables CLI execution", async () => {
    vi.stubEnv("LOCAL_CLI_ENABLED", "0");
    expect((await discover()).some((provider) => provider.kind === "cli")).toBe(false);
  });
});
