import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";
import { closeModelEndpoints, normalizeBaseUrl, openModelEndpoints, parseModels } from "../server/customProviders.ts";
import { callProvider, resolveModel } from "../server/providers.ts";
import { callStructured } from "../server/structured.ts";
import type { ProviderInfo } from "../src/lib/api.ts";
import type { ModelEndpoint } from "../src/lib/modelEndpointsApi.ts";

const KEY = "sk-test-secret-key";
let app: TestApp, server: http.Server, base: string;
const requests: { method: string; url: string; auth?: string; body: Record<string, unknown> }[] = [];
let reply: Record<string, unknown> = {};

beforeAll(async () => {
  process.env.GRAPH_CONNECTIONS_KEY = Buffer.alloc(32, 9).toString("base64");
  app = await startApp();
  await openModelEndpoints(app.dataDir);
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString();
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: text ? JSON.parse(text) : {} });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ data: [{ id: "qwen-large" }, { id: "llama-small" }] }));
      return;
    }
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  closeModelEndpoints();
  await app.close();
  await new Promise((r) => server.close(r));
});
afterEach(() => {
  vi.unstubAllEnvs();
  requests.length = 0;
});

const providers = async () => (await app.as("alice").json<{ providers: ProviderInfo[] }>("GET", "/api/providers")).body.providers;

describe("base URL and model parsing", () => {
  it.each([
    ["https://llm.example.org", "https://llm.example.org/v1"],
    ["https://llm.example.org/", "https://llm.example.org/v1"],
    ["https://llm.example.org/v1/", "https://llm.example.org/v1"],
    ["  https://llm.example.org/v1/chat/completions ", "https://llm.example.org/v1"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["https://host/api/openai/v1", "https://host/api/openai/v1"],
  ])("normalizes %s", (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected));
  it.each(["ftp://host/v1", "not a url", "https://user:pw@host/v1", "https://host/v1?key=1", 5])("rejects %s", (input) =>
    expect(() => normalizeBaseUrl(input)).toThrow(),
  );
  it("splits, trims and deduplicates model ids", () => {
    expect(parseModels("a, b\n a\n\nc/d:e")).toEqual(["a", "b", "c/d:e"]);
    expect(() => parseModels(["has space"])).toThrow();
  });
});

describe("saved OpenAI-compatible endpoints", () => {
  let saved: ModelEndpoint;
  const c = () => app.as("alice");

  it("tests the connection and lists the server's models", async () => {
    const denied = await c().json("POST", "/api/model-endpoints/discover", { baseUrl: base, apiKey: "wrong" });
    expect(denied.status).toBe(422);
    const found = await c().json<{ baseUrl: string; models: string[] }>("POST", "/api/model-endpoints/discover", {
      baseUrl: base,
      apiKey: KEY,
    });
    expect(found.body).toEqual({ baseUrl: `${base}/v1`, models: ["llama-small", "qwen-large"] });
  });

  it("saves an endpoint without ever returning or storing the key in clear text", async () => {
    const invalid = await c().json("POST", "/api/model-endpoints", { label: "Lab", baseUrl: base, models: [] });
    expect(invalid.status).toBe(400);
    const res = await c().json<{ endpoint: ModelEndpoint }>("POST", "/api/model-endpoints", {
      label: "Lab gateway",
      baseUrl: `${base}/v1/`,
      apiKey: KEY,
      models: ["qwen-large", "llama-small"],
    });
    expect(res.status).toBe(200);
    saved = res.body.endpoint;
    expect(saved).toMatchObject({ label: "Lab gateway", baseUrl: `${base}/v1`, hasKey: true, providerId: `openai-compatible:${saved.id}` });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify((await c().json("GET", "/api/model-endpoints")).body)).not.toContain(KEY);
    expect(await readFile(join(app.dataDir, "model-endpoints.json"), "utf8")).not.toContain(KEY);
    expect((await providers()).find((p) => p.id === saved.providerId)).toMatchObject({
      label: "Lab gateway",
      enabled: true,
      models: ["qwen-large", "llama-small"],
    });
  });

  it("only resolves the models the endpoint advertises", () => {
    expect(resolveModel(saved.providerId, undefined).model).toBe("qwen-large");
    expect(() => resolveModel(saved.providerId, "gpt-4o")).toThrow(/Unknown model/);
  });

  it("sends chat to the endpoint with the stored key", async () => {
    reply = { choices: [{ message: { content: "hello" } }] };
    const answer = await callProvider(saved.providerId, {
      model: "qwen-large",
      messages: [{ role: "user", content: "hi" }],
      graphContext: "",
    });
    expect(answer).toBe("hello");
    expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions", auth: `Bearer ${KEY}` });
    expect(requests[0].body).toMatchObject({ model: "qwen-large", max_tokens: 1500 });
    expect(requests[0].body).not.toHaveProperty("max_completion_tokens");
  });

  const structured = () =>
    callStructured({
      provider: saved.providerId,
      model: "qwen-large",
      system: "s",
      lead: "l",
      toolName: "emit",
      toolDesc: "d",
      schema: { type: "object", properties: { n: { type: "number" } } },
    });

  it("reads structured output from a tool call, or from JSON content when the server ignores tool_choice", async () => {
    reply = {
      choices: [{ message: { tool_calls: [{ function: { arguments: '{"n":1}' } }] } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    expect(await structured()).toEqual({ data: { n: 1 }, usage: { input_tokens: 3, output_tokens: 2 } });
    expect(requests[0].body).toMatchObject({ tool_choice: { type: "function", function: { name: "emit" } } });
    expect(requests[0].body).toHaveProperty("max_tokens");
    reply = { choices: [{ message: { content: '```json\n{"n":2}\n```' } }] };
    expect((await structured()).data).toEqual({ n: 2 });
    reply = { choices: [{ message: { content: "I cannot do that." } }] };
    await expect(structured()).rejects.toThrow();
  });

  it("restores endpoints and keys after a restart", async () => {
    await openModelEndpoints(app.dataDir);
    reply = { choices: [{ message: { content: "again" } }] };
    await callProvider(saved.providerId, { model: "qwen-large", messages: [{ role: "user", content: "hi" }], graphContext: "" });
    expect(requests[0].auth).toBe(`Bearer ${KEY}`);
  });

  it("keeps the key on edit, but not when the server address changes", async () => {
    const renamed = await c().json<{ endpoint: ModelEndpoint }>("PUT", `/api/model-endpoints/${saved.id}`, {
      label: "Renamed",
      baseUrl: `${base}/v1`,
      models: ["llama-small"],
    });
    expect(renamed.body.endpoint).toMatchObject({ label: "Renamed", hasKey: true, models: ["llama-small"] });
    const found = await c().json<{ models: string[] }>("POST", "/api/model-endpoints/discover", { baseUrl: base, id: saved.id });
    expect(found.status).toBe(200);
    const moved = await c().json("PUT", `/api/model-endpoints/${saved.id}`, {
      label: "Renamed",
      baseUrl: "https://elsewhere.example.org/v1",
      models: ["llama-small"],
    });
    expect(moved.status).toBe(400);
    const elsewhere = await c().json("POST", "/api/model-endpoints/discover", {
      baseUrl: `http://localhost:${new URL(base).port}`,
      id: saved.id,
    });
    expect(elsewhere.status).toBe(422);
    expect(requests.at(-1)!.auth).toBeUndefined();
  });

  it("removes an endpoint and its provider", async () => {
    expect((await c().json("DELETE", `/api/model-endpoints/${saved.id}`)).status).toBe(200);
    expect((await providers()).some((p) => p.id === saved.providerId)).toBe(false);
    await expect(
      callProvider(saved.providerId, { model: "llama-small", messages: [{ role: "user", content: "hi" }], graphContext: "" }),
    ).rejects.toThrow(/no longer configured/);
    expect((await c().json("DELETE", `/api/model-endpoints/${saved.id}`)).status).toBe(404);
  });
});

describe("environment endpoint", () => {
  it("is absent until a base URL is set", async () => {
    expect((await providers()).some((p) => p.id === "openai-compatible")).toBe(false);
  });
  it("is enabled by OPENAI_COMPAT_* and works without a key", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", base);
    vi.stubEnv("OPENAI_COMPAT_MODELS", "llama-small, qwen-large");
    vi.stubEnv("OPENAI_COMPAT_LABEL", "Campus LLM");
    expect((await providers()).find((p) => p.id === "openai-compatible")).toMatchObject({
      label: "Campus LLM",
      enabled: true,
      models: ["llama-small", "qwen-large"],
    });
    reply = { choices: [{ message: { content: "ok" } }] };
    await callProvider("openai-compatible", { model: "llama-small", messages: [{ role: "user", content: "hi" }], graphContext: "" });
    expect(requests[0]).toMatchObject({ url: "/v1/chat/completions", auth: undefined });
  });
  it("explains a missing model list", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", base);
    expect((await providers()).find((p) => p.id === "openai-compatible")).toMatchObject({ enabled: false, models: [] });
  });
});
