import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, driveRun, type Client, type TestApp } from "./helpers.ts";
import type { ChunkSettings, ChunkExperiment, TokenChunkSettings, RunResearch } from "../src/types/research.ts";
import type { ProjectDocument, RunView, DocumentText } from "../src/types/project.ts";
import { chunkSettingsKey } from "../src/lib/research.ts";
import { chunkEmbeddingText } from "../server/services/vectorIndex.ts";
import * as tokenChunking from "../server/services/tokenChunking.ts";
let app: TestApp;
let c: Client;
let pid: string;
let doc: ProjectDocument;
const body = (ids: string[]) => ({ kind: "induction", documentIds: ids, provider: "mock", model: "mock-1", mode: "automatic" });
const tokens: TokenChunkSettings = {
  embedding: { profile: "hash:384", maxTokens: 32 },
  generation: { provider: "mock", model: "mock-1", maxTokens: 200, contextTokens: 32768, outputTokens: 4096, promptReserveTokens: 4096 },
};
const settings: ChunkSettings = { method: "section", maxChars: 12000, overlap: 0.1, unit: "tokens", tokens };
beforeEach(async () => {
  app = await startApp();
  c = app.as("alice");
  pid = (
    await c.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Tokens",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  doc = (
    await c.upload(
      `/api/projects/${pid}/documents`,
      "notes.md",
      "# Motors\n\n" + "Motor A drives Pump B. ".repeat(40) + "\n\n## Last section\n\nFinal fact: sensor C measures pressure. 😀",
      false,
    )
  ).body.document as ProjectDocument;
  await app.processDocuments();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});
async function save(s: ChunkSettings = settings) {
  const p = await c.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, s);
  expect(p.status).toBe(200);
  const saved = await c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, {
    settings: s,
    textHash: p.body.textHash,
  });
  expect(saved.status).toBe(200);
  return { preview: p.body, document: saved.body.document };
}
describe("model-aware chunking", () => {
  it.each([
    ["codex-cli", "default"],
    ["claude-cli", "sonnet"],
    ["agy-cli", "default"],
  ])("previews and saves chunks for %s without calling a generation model", async (provider, model) => {
    const { preview, document } = await save({
      ...settings,
      tokens: { ...tokens, generation: { ...tokens.generation, provider, model } },
    });
    expect(preview.tokenization?.fullCoverage).toBe(true);
    expect(document.preprocessing?.settings.tokens?.generation).toMatchObject({ provider, model });
    expect((await c.json<{ runs: RunView[] }>("GET", `/api/projects/${pid}/runs`)).body.runs).toEqual([]);
  });
  it("caches unsaved previews when switching back to a previously computed configuration", async () => {
    const engine = vi.spyOn(tokenChunking, "buildTokenChunks");
    const endpoint = `/api/projects/${pid}/documents/${doc.id}/chunk-preview`;
    const results = await Promise.all(Array.from({ length: 3 }, () => c.json<ChunkExperiment>("POST", endpoint, settings)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(engine).toHaveBeenCalledTimes(1);
    await c.json("POST", endpoint, { ...settings, overlap: 0.2 });
    const again = await c.json<ChunkExperiment>("POST", endpoint, settings);
    expect(again.body).toEqual(results[0].body);
    expect(engine).toHaveBeenCalledTimes(2);
    const documents = (await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0].chunkCount).toBe(0);
  });

  it("never overwrites an existing document when an insert races with another save", async () => {
    const store = (await import("../server/store/local.ts")).createLocalStore(app.dataDir).forUser({ id: "alice" });
    const before = (await store.documents.get(pid, doc.id))!;
    await expect(store.documents.create({ ...before, name: "Replacement" })).rejects.toThrow("Document already exists");
    expect(await store.documents.get(pid, doc.id)).toEqual(before);
  });

  it("reuses previews and saved chunks without recomputing or creating another document", async () => {
    const engine = vi.spyOn(tokenChunking, "buildTokenChunks");
    const first = await save();
    expect(engine).toHaveBeenCalledTimes(1);
    const before = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`)).body;
    const again = await save({ ...settings, maxChars: 24000 }); // inactive in token mode
    expect(again.preview.reusedDocumentId).toBe(first.document.id);
    expect(again.document).toEqual(first.document);
    expect(engine).toHaveBeenCalledTimes(1);
    expect((await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents).toHaveLength(1);
    expect((await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`)).body).toEqual(before);
    const stale = await c.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, { settings, textHash: "stale" });
    expect(stale.status).toBe(409);
  });

  it("reuses a matching configuration across variants of the same source", async () => {
    const original = await save();
    const changedSettings = { ...settings, tokens: { ...tokens, generation: { ...tokens.generation, maxTokens: 300 } } };
    const variant = await save(changedSettings);
    expect(variant.document.id).not.toBe(original.document.id);
    const repeated = await save(changedSettings);
    expect(repeated.document.id).toBe(variant.document.id);
    const restored = await c.json<{ document: ProjectDocument }>(
      "POST",
      `/api/projects/${pid}/documents/${variant.document.id}/chunk-variant`,
      {
        settings,
        textHash: original.preview.textHash,
      },
    );
    expect(restored.body.document.id).toBe(original.document.id);
    expect((await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents).toHaveLength(2);
  });

  it("coalesces concurrent saves for both the first configuration and a new variant", async () => {
    for (const maxTokens of [200, 300]) {
      const configuration = { ...settings, tokens: { ...tokens, generation: { ...tokens.generation, maxTokens } } };
      const preview = (await c.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, configuration)).body;
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, {
            settings: configuration,
            textHash: preview.textHash,
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.body.document.id)).size).toBe(1);
    }
    expect((await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents).toHaveLength(2);
  });

  it("keeps changes to chunking, models and request budgets as distinct configurations", async () => {
    const baseline = await save();
    const configurations: ChunkSettings[] = [
      { ...settings, method: "paragraph" },
      { ...settings, overlap: 0.2 },
      { ...settings, tokens: { ...tokens, embedding: { ...tokens.embedding, maxTokens: 64 } } },
      ...[{ model: "mock-2" }, { maxTokens: 300 }, { contextTokens: 65536 }, { outputTokens: 8192 }, { promptReserveTokens: 8192 }].map(
        (patch) => ({ ...settings, tokens: { ...tokens, generation: { ...tokens.generation, ...patch } } }),
      ),
    ];
    const ids = new Set([baseline.document.id]);
    for (const configuration of configurations) ids.add((await save(configuration)).document.id);
    expect(ids.size).toBe(configurations.length + 1);
    expect(chunkSettingsKey({ ...settings, tokens: { ...tokens, embedding: { ...tokens.embedding, profile: "another-model" } } })).not.toBe(
      chunkSettingsKey(settings),
    );
  });

  it("invalidates cached previews and saved reuse when the parsed text changes", async () => {
    const engine = vi.spyOn(tokenChunking, "buildTokenChunks");
    const original = await save();
    const store = (await import("../server/store/local.ts")).createLocalStore(app.dataDir).forUser({ id: "alice" });
    const text = (await store.documents.getText(pid, doc.id))!;
    const chunks = await store.documents.chunks(pid, [doc.id]);
    await store.documents.putText(pid, doc.id, { ...text, text: text.text + "\n\nA new final fact." }, chunks);
    const changed = await c.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings);
    expect(changed.body.reusedDocumentId).toBeUndefined();
    expect(changed.body.textHash).not.toBe(original.preview.textHash);
    expect(engine).toHaveBeenCalledTimes(2);
    const stale = await c.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, {
      settings,
      textHash: original.preview.textHash,
    });
    expect(stale.status).toBe(409);
  });

  it("invalidates reuse when section metadata changes without changing the text", async () => {
    const engine = vi.spyOn(tokenChunking, "buildTokenChunks");
    await save();
    const store = (await import("../server/store/local.ts")).createLocalStore(app.dataDir).forUser({ id: "alice" });
    const text = (await store.documents.getText(pid, doc.id))!;
    const chunks = await store.documents.chunks(pid, [doc.id]);
    await store.documents.putText(
      pid,
      doc.id,
      { ...text, sections: text.sections?.map((s) => ({ ...s, path: ["Updated heading"] })) },
      chunks,
    );
    const changed = await c.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings);
    expect(changed.body.reusedDocumentId).toBeUndefined();
    expect(changed.body.chunks[0].sectionPath).toEqual(["Updated heading"]);
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it("batches every induction chunk without sampling or clipping model inputs", async () => {
    const uploaded = await c.upload(
      `/api/projects/${pid}/documents`,
      "large.txt",
      "A Sensor measures pressure in a Machine. ".repeat(2200) + "Final fact: Valve Z controls flow.",
      false,
    );
    doc = uploaded.body.document as ProjectDocument;
    await app.processDocuments();
    const { document: saved } = await save({
      ...settings,
      method: "paragraph",
      tokens: {
        embedding: { profile: "hash:384", maxTokens: 256 },
        generation: { ...tokens.generation, maxTokens: 2000 },
      },
    });
    const source = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${saved.id}/text`)).body;
    const created = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, body([saved.id]));
    const done = await driveRun(c, pid, created.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const report = (await c.json<RunResearch>("GET", `/api/projects/${pid}/runs/${done.id}/research`)).body;
    const byId = new Map(source.chunks.map((chunk) => [chunk.id, chunk]));
    for (const kind of ["terms", "relations"]) {
      const seen = new Set<string>();
      const stages = done.steps.filter((s) => s.kind === kind);
      expect(stages.length).toBeGreaterThan(1);
      for (const stage of stages) {
        const cp = report.checkpoints.find((c) => c.key === stage.key)!;
        expect(cp.trace?.diagnostics?.fullChunkCoverage).toBe(true);
        const passages = cp.trace?.input?.sampledDocuments as { text: string; chunkId: string; start: number }[];
        expect(passages).toHaveLength(stage.chunkIds!.length);
        for (const passage of passages) {
          const chunk = byId.get(passage.chunkId)!;
          expect(passage.start).toBe(chunk.start);
          expect(passage.text).toBe(source.text.slice(chunk.start, chunk.end));
          seen.add(passage.chunkId);
        }
      }
      expect([...seen].sort()).toEqual([...byId.keys()].sort());
    }
  });

  it("accepts unchanged saved settings after Postgres JSON key reordering", () => {
    const reordered: ChunkSettings = {
      tokens: {
        generation: {
          outputTokens: 4096,
          contextTokens: 32768,
          promptReserveTokens: 4096,
          maxTokens: 200,
          model: "mock-1",
          provider: "mock",
        },
        embedding: { maxTokens: 32, profile: "hash:384" },
      },
      unit: "tokens",
      overlap: 0.1,
      maxChars: 12000,
      method: "section",
    };
    expect(chunkSettingsKey(reordered)).toBe(chunkSettingsKey(settings));
    expect(chunkSettingsKey({ ...reordered, overlap: 0.2 })).not.toBe(chunkSettingsKey(settings));
  });

  it("records independent budgets, token counts, coverage, source offsets and immutable configurations", async () => {
    const { preview, document: saved } = await save();
    expect(preview.tokenization?.fullCoverage).toBe(true);
    expect(preview.tokenization?.generation.exact).toBe(false);
    expect(preview.chunks.every((c) => c.tokenization!.generation.count <= 200)).toBe(true);
    expect(preview.chunks.every((c) => c.tokenization!.embeddingPassages.every((p) => p.tokens <= 32))).toBe(true);
    expect(preview.chunks.at(-1)?.text).toContain("sensor C");
    expect(saved.preprocessing?.version).toBe("chunking-tokens-v1");
    expect(saved.preprocessing?.settings.tokens).toEqual(tokens);
    const run = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, body([saved.id]));
    expect(run.status).toBe(201);
    expect(run.body.run.options?.tokenization).toEqual(tokens);
    const final = await driveRun(c, pid, run.body.run.id);
    expect(final.status).toBe("ready_for_review");
    const changed = await save({ ...settings, tokens: { ...tokens, generation: { ...tokens.generation, maxTokens: 300 } } });
    expect(changed.document.id).not.toBe(saved.id);
    const before = (await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents.find(
      (d) => d.id === saved.id,
    )!;
    expect(before.preprocessing?.settings.tokens).toEqual(tokens);
  });
  it("rejects impossible budgets, unavailable embedding choices and model changes before inference", async () => {
    const excessive = await c.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, {
      ...settings,
      tokens: { ...tokens, generation: { ...tokens.generation, contextTokens: 256 } },
    });
    expect(excessive.status).toBe(400);
    const wrong = await c.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, {
      ...settings,
      tokens: { ...tokens, embedding: { profile: "arbitrary:model", maxTokens: 32 } },
    });
    expect(wrong.status).toBe(400);
    const { document: saved } = await save();
    const store = (await import("../server/store/local.ts")).createLocalStore(app.dataDir).forUser({ id: "alice" });
    await store.documents.update(pid, saved.id, {
      preprocessing: {
        ...saved.preprocessing!,
        settings: { ...settings, tokens: { ...tokens, generation: { ...tokens.generation, model: "different-model" } } },
      },
    });
    const run = await c.json("POST", `/api/projects/${pid}/runs`, body([saved.id]));
    expect(run.status).toBe(409);
  });
  it("stops an actual structured step before inference when the complete request exceeds its budget", async () => {
    const constrained = {
      ...settings,
      tokens: {
        ...tokens,
        generation: { ...tokens.generation, maxTokens: 64, contextTokens: 1024, outputTokens: 256, promptReserveTokens: 512 },
      },
    };
    const saved = await save(constrained);
    const run = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, body([saved.document.id]));
    expect(run.status).toBe(201);
    const final = await driveRun(c, pid, run.body.run.id);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Full request needs");
  });
  it("keeps a parent chunk's tail in the vector index input", () => {
    const text = "Prefix ".repeat(1000) + "Unique final fact";
    expect(chunkEmbeddingText({ text, sectionPath: ["Section"] })).toContain("Unique final fact");
  });
});
