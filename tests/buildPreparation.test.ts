import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type Client, type TestApp } from "./helpers.ts";
import type { ProjectDocument, RunView } from "../src/types/project.ts";
import type { ChunkExperiment, ChunkSettings } from "../src/types/research.ts";
import { documentsNeedingModel, prepareChunksForModel, savedGenerationModel } from "../src/lib/buildPreparation.ts";

let app: TestApp;
let client: Client;
let pid: string;
const settings: ChunkSettings = {
  unit: "tokens",
  method: "section",
  maxChars: 12000,
  overlap: 0.1,
  tokens: {
    embedding: { profile: "hash:384", maxTokens: 32 },
    generation: {
      provider: "gemini",
      model: "gemini-3.8-flash",
      maxTokens: 200,
      contextTokens: 32768,
      outputTokens: 4096,
      promptReserveTokens: 4096,
    },
  },
};
const codex = { provider: "codex-cli", model: "default" };
beforeEach(async () => {
  app = await startApp();
  client = app.as("alice");
  pid = (
    await client.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Model preparation",
      settings: { models: { embeddings: "hash" } },
    })
  ).body.project.id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});
const actions = () => ({
  previewChunks: async (_pid: string, did: string, input: ChunkSettings) => {
    const response = await client.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${did}/chunk-preview`, input);
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
    return response.body;
  },
  saveChunkVariant: async (_pid: string, did: string, input: ChunkSettings, textHash: string) => {
    const response = await client.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${did}/chunk-variant`, {
      settings: input,
      textHash,
    });
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
    return response.body.document;
  },
});
async function document(name: string) {
  const uploaded = (await client.upload(`/api/projects/${pid}/documents`, name, "A Sensor measures pressure in a Device. ".repeat(20))).body
    .document as ProjectDocument;
  const preview = await actions().previewChunks(pid, uploaded.id, settings);
  return actions().saveChunkVariant(pid, uploaded.id, preview.settings, preview.textHash);
}
describe("switching a build to a new generation model", () => {
  it("prepares every affected document, keeps budgets and source history, and makes the build estimate valid", async () => {
    const inputs = await Promise.all([document("first.txt"), document("second.txt")]);
    expect(savedGenerationModel(inputs)).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    expect(documentsNeedingModel(inputs, codex)).toHaveLength(2);
    const prepared = await prepareChunksForModel(pid, inputs, codex, actions());
    expect(documentsNeedingModel(prepared, codex)).toEqual([]);
    expect(savedGenerationModel(prepared)).toEqual(codex);
    prepared.forEach((item, index) => {
      expect(item.id).not.toBe(inputs[index].id);
      expect(item.variantOf).toBe(inputs[index].variantOf ?? inputs[index].id);
      expect(item.preprocessing?.settings).toEqual({
        ...settings,
        tokens: { ...settings.tokens!, generation: { ...settings.tokens!.generation, ...codex } },
      });
    });
    const all = (await client.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents;
    inputs.forEach((input) => expect(all.find((item) => item.id === input.id)).toEqual(input));
    vi.stubEnv("LOCAL_CLI_ENABLED", "1");
    vi.stubEnv("ONTOLAB_CODEX_BIN", "/usr/bin/true");
    const body = { kind: "induction", mode: "automatic", ...codex, documentIds: prepared.map((item) => item.id) };
    expect((await client.json("POST", `/api/projects/${pid}/runs/estimate`, body)).status).toBe(200);
    const created = await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, body);
    expect(created.status).toBe(201);
    expect(created.body.run.options?.tokenization?.generation).toMatchObject(codex);
    expect(created.body.run.documentIds).toEqual(prepared.map((item) => item.id));
  });
  it("reuses matching configurations and reports a failed document without changing the original inputs", async () => {
    const inputs = await Promise.all([document("first.txt"), document("second.txt")]);
    const api = actions();
    let saves = 0;
    await expect(
      prepareChunksForModel(pid, inputs, codex, {
        ...api,
        saveChunkVariant: async (...args) => {
          if (++saves === 2) throw new Error("Storage unavailable");
          return api.saveChunkVariant(...args);
        },
      }),
    ).rejects.toThrow(`${inputs[1].name}: Storage unavailable`);
    expect(savedGenerationModel(inputs)).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    const prepared = await prepareChunksForModel(pid, inputs, codex, api);
    const preview = vi.fn(api.previewChunks);
    expect(await prepareChunksForModel(pid, prepared, codex, { ...api, previewChunks: preview })).toEqual(prepared);
    expect(preview).not.toHaveBeenCalled();
  });
  it("does not infer a common model from mixed models or inactive legacy token settings", () => {
    const make = (id: string, config: ChunkSettings) => ({ id, preprocessing: { settings: config } }) as ProjectDocument;
    const first = make("first", settings);
    const second = make("second", {
      ...settings,
      tokens: { ...settings.tokens!, generation: { ...settings.tokens!.generation, ...codex } },
    });
    expect(savedGenerationModel([first, second])).toBeUndefined();
    const legacy = make("legacy", { ...settings, unit: "characters" });
    expect(savedGenerationModel([legacy])).toBeUndefined();
    expect(documentsNeedingModel([legacy, first, second], codex).map((item) => item.id)).toEqual(["first"]);
  });
});
