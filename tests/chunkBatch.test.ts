import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type Client, type TestApp } from "./helpers.ts";
import type { ProjectDocument } from "../src/types/project.ts";
import type { ChunkExperiment, ChunkSettings } from "../src/types/research.ts";
import { hasMatchingChunks, previewChunkBatch, saveChunkBatch, type ChunkBatchItem } from "../src/lib/chunkBatch.ts";

let app: TestApp, client: Client, pid: string;
const settings: ChunkSettings = {
  unit: "tokens",
  method: "paragraph",
  maxChars: 12000,
  overlap: 0.1,
  tokens: {
    embedding: { profile: "hash:384", maxTokens: 32 },
    generation: {
      provider: "gemini",
      model: "gemini-3.8-flash",
      maxTokens: 80,
      contextTokens: 32768,
      outputTokens: 4096,
      promptReserveTokens: 4096,
    },
  },
};
beforeEach(async () => {
  app = await startApp();
  client = app.as("alice");
  pid = (await client.json<{ project: { id: string } }>("POST", "/api/projects", { name: "Batch chunking" })).body.project.id;
});
afterEach(async () => {
  await app.close();
});
async function upload(name: string) {
  const response = await client.upload(
    `/api/projects/${pid}/documents`,
    name,
    `${name}: ` + "A controller reports its measured speed and temperature. ".repeat(45),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.document).toBeDefined();
  return response.body.document as ProjectDocument;
}
const actions = () => ({
  previewChunks: async (_pid: string, did: string, settings: ChunkSettings) => {
    const r = await client.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${did}/chunk-preview`, settings);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body;
  },
  saveChunkVariant: async (_pid: string, did: string, settings: ChunkSettings, textHash: string) => {
    const r = await client.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${did}/chunk-variant`, {
      settings,
      textHash,
    });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.document;
  },
});

describe("chunking all selected documents", () => {
  it("previews and saves every file with shared budgets while retaining original configurations and avoiding generation", async () => {
    const inputs = [await upload("first.txt"), await upload("second.txt")];
    const progress: ChunkBatchItem[][] = [];
    const prepared = await previewChunkBatch(pid, inputs, settings, actions(), [], (items) => progress.push(items));
    expect(
      prepared.map((item) => item.phase),
      JSON.stringify(prepared.map((item) => ({ name: item.document.name, error: item.error }))),
    ).toEqual(["ready", "ready"]);
    expect(prepared.every((item) => item.preview!.chunks.length > 1)).toBe(true);
    expect(progress.some((items) => items.some((item) => item.phase === "preparing"))).toBe(true);
    const saved = await saveChunkBatch(pid, prepared, actions());
    expect(saved.map((item) => item.phase)).toEqual(["saved", "saved"]);
    for (const [index, item] of saved.entries()) {
      expect(item.saved!.variantOf).toBe(inputs[index].id);
      expect(item.saved!.preprocessing!.settings).toEqual(settings);
      expect(hasMatchingChunks(item.saved!, settings)).toBe(true);
    }
    const all = (await client.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents;
    expect(all).toHaveLength(4);
    for (const original of inputs) expect(all.find((doc) => doc.id === original.id)).toEqual(original);
    expect((await client.json<{ runs: unknown[] }>("GET", `/api/projects/${pid}/runs`)).body.runs).toEqual([]);
  });
  it("continues after a preview failure and retries only the failed file", async () => {
    const inputs = [await upload("first.txt"), await upload("second.txt")];
    const api = actions();
    let fail = true;
    const preview = vi.fn(async (...args: Parameters<typeof api.previewChunks>) => {
      if (args[1] === inputs[0].id && fail) {
        fail = false;
        throw new Error("Tokenizer unavailable");
      }
      return api.previewChunks(...args);
    });
    const first = await previewChunkBatch(pid, inputs, settings, { ...api, previewChunks: preview });
    expect(first.map((item) => item.phase)).toEqual(["error", "ready"]);
    expect(first[0].error).toContain("Tokenizer unavailable");
    preview.mockClear();
    const retried = await previewChunkBatch(pid, inputs, settings, { ...api, previewChunks: preview }, first);
    expect(retried.map((item) => item.phase)).toEqual(["ready", "ready"]);
    expect(preview.mock.calls.map((call) => call[1])).toEqual([inputs[0].id]);
  });
  it("keeps successful saves when retrying storage failures and creates no duplicate variants", async () => {
    const inputs = [await upload("first.txt"), await upload("second.txt")];
    const api = actions();
    let fail = true;
    const prepared = await previewChunkBatch(pid, inputs, settings, api);
    const save = vi.fn(async (...args: Parameters<typeof api.saveChunkVariant>) => {
      if (args[1] === inputs[1].id && fail) {
        fail = false;
        throw new Error("Storage unavailable");
      }
      return api.saveChunkVariant(...args);
    });
    const first = await saveChunkBatch(pid, prepared, { ...api, saveChunkVariant: save });
    expect(first.map((item) => item.phase)).toEqual(["saved", "error"]);
    save.mockClear();
    const retried = await saveChunkBatch(pid, first, { ...api, saveChunkVariant: save });
    expect(retried.map((item) => item.phase)).toEqual(["saved", "saved"]);
    expect(save.mock.calls.map((call) => call[1])).toEqual([inputs[1].id]);
    expect((await client.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents).toHaveLength(4);
  });
  it("reports unreadable inputs per file while preparing the remaining documents", async () => {
    const valid = await upload("valid.txt");
    const preview = vi.fn(actions().previewChunks);
    const inputs = [{ ...valid, id: "pending", parseState: "pending" as const }, { ...valid, id: "empty", charCount: 0 }, valid];
    const result = await previewChunkBatch(pid, inputs, settings, { ...actions(), previewChunks: preview });
    expect(result.map((item) => item.phase)).toEqual(["error", "error", "ready"]);
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
