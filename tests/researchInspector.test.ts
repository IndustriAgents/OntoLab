import { gzipSync, gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";
import type { ProjectDocument, DocumentText, RunView, RevisionWithContent } from "../src/types/project.ts";
import type { RunResearch, ChunkExperiment } from "../src/types/research.ts";
import { chunkText } from "../server/services/chunking.ts";

const TBOX = await readFile(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
const TEXT =
  "# Station\n\nThe station contains a cylinder and a sensor. " +
  "The cylinder moves the workpiece. ".repeat(40) +
  "\n\n# Signals\n\nThe sensor emits a digital signal.";
let app: TestApp;
let alice: Client;
beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
});
afterEach(async () => app.close());

async function setup() {
  const { body } = await alice.json<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Research inspector",
    settings: { models: { embeddings: "hash", nli: "lexical" } },
  });
  const pid = body.project.id;
  const upload = await alice.upload(`/api/projects/${pid}/documents`, "manual.md", TEXT);
  expect(upload.status).toBe(201);
  const doc = upload.body.document as ProjectDocument;
  return { pid, doc };
}

describe("inspectable preprocessing", () => {
  it("preserves source offsets and keeps section boundaries hard, including overlap", () => {
    const text = "First section.\n\n" + "A long sentence here. ".repeat(15) + "\n\nSecond section.\n\n" + "More content. ".repeat(20);
    const boundary = text.indexOf("Second section.");
    const sections = [
      { title: "First", path: ["First"], level: 1, start: 0, end: boundary },
      { title: "Second", path: ["Second"], level: 1, start: boundary, end: text.length },
    ];
    for (const method of ["paragraph", "section", "fixed"] as const) {
      const chunks = chunkText(text, [], 200, { method, overlap: 0.2, sections });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
        expect(chunk.end - chunk.start).toBeLessThanOrEqual(240);
        if (method === "section") expect(chunk.start < boundary && chunk.end > boundary).toBe(false);
      }
      if (method === "fixed") {
        expect(chunks[1].start).toBe(160);
        expect(chunks[1].overlap).toBe(40);
      }
    }
    expect(() => chunkText(text, [], 0)).toThrow();
    expect(chunkText("", [], 200)).toEqual([]);
  });

  it("previews without mutation and saves independent variants with the exact preview chunks", async () => {
    const { pid, doc } = await setup();
    expect(doc.preprocessing?.settings.method).toBe("paragraph");
    expect(doc.preprocessing?.textHash).toMatch(/^[a-f0-9]{64}$/);
    const before = await alice.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`);
    const settings = { method: "section", maxChars: 200, overlap: 0.2 };
    const preview = await alice.json<ChunkExperiment>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings);
    expect(preview.status).toBe(200);
    expect(preview.body.chunks.length).toBeGreaterThan(before.body.chunks.length);
    const unchanged = await alice.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`);
    expect(unchanged.body).toEqual(before.body);
    const stale = await alice.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, { settings, textHash: "stale" });
    expect(stale.status).toBe(409);
    const saved = await alice.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, {
      settings,
      textHash: preview.body.textHash,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.document.variantOf).toBe(doc.id);
    expect(saved.body.document.preprocessing?.settings).toEqual(settings);
    expect(saved.body.document.name.endsWith(".md")).toBe(true);
    const actual = await alice.json<DocumentText>("GET", `/api/projects/${pid}/documents/${saved.body.document.id}/text`);
    expect(actual.body.chunks.map(({ start, end, overlap }) => ({ start, end, overlap }))).toEqual(
      preview.body.chunks.map(({ start, end, overlap }) => ({ start, end, overlap })),
    );
    const archive = Buffer.from(await (await alice.get(`/api/projects/${pid}/archive`)).arrayBuffer());
    const archiveData = JSON.parse(gunzipSync(archive).toString("utf8"));
    archiveData.documents.sort((a: ProjectDocument, b: ProjectDocument) => Number(!!b.variantOf) - Number(!!a.variantOf));
    const restored = await app
      .as("bob")
      .upload("/api/projects/import", "experiment.ontolab.json.gz", gzipSync(JSON.stringify(archiveData)));
    expect(restored.status).toBe(201);
    const restoredPid = (restored.body.project as { id: string }).id;
    const restoredDocs = await app.as("bob").json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${restoredPid}/documents`);
    const restoredVariant = restoredDocs.body.documents.find((d) => d.variantOf)!;
    expect(restoredVariant.preprocessing?.settings).toEqual(settings);
    expect(restoredVariant.chunkCount).toBe(preview.body.chunks.length);
    expect(restoredDocs.body.documents.some((d) => d.id === restoredVariant.variantOf)).toBe(true);
    // Removing the variant must not remove the original file.
    await alice.json("DELETE", `/api/projects/${pid}/documents/${saved.body.document.id}`);
    expect((await alice.get(`/api/projects/${pid}/documents/${doc.id}/file`)).status).toBe(200);
    for (const bad of [
      { ...settings, maxChars: 0 },
      { ...settings, maxChars: 1e9 },
      { ...settings, overlap: 0.31 },
      { ...settings, overlap: "0.2" },
      { ...settings, method: "semantic" },
    ]) {
      expect((await alice.json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, bad)).status).toBe(400);
    }
    expect((await app.as("bob").json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings)).status).toBe(404);
  });
});

describe("T-Box and A-Box research records", () => {
  it.each(["induction", "extraction"] as const)("records %s inputs, keyed outputs, timings and immutable final artifacts", async (kind) => {
    const { pid, doc } = await setup();
    if (kind === "extraction") {
      const draft = await alice.json<{ revision: { id: string } }>("POST", `/api/projects/${pid}/revisions`, {
        content: { modules: [{ name: "core.ttl", turtle: TBOX }], abox: null, baseIri: "" },
        source: "import",
        summary: "T-Box",
      });
      const commit = await alice.json("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`, {
        acknowledgedWarnings: true,
      });
      expect(commit.status).toBe(200);
    }
    const created = await alice.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      kind,
      documentIds: [doc.id],
      mode: "automatic",
      provider: "mock",
      model: "mock-1",
      options: {
        relevanceScreen: false,
        resolveEntities: true,
        verifyEvidence: true,
        repair: false,
        schemaRetrieval: "force",
        schemaTopK: 2,
        reuseCache: false,
      },
    });
    expect(created.status).toBe(201);
    const runId = created.body.run.id;
    const pending = await alice.json<RunResearch>("GET", `/api/projects/${pid}/runs/${runId}/research`);
    expect(pending.body.checkpoints).toEqual([]);
    expect(pending.body.inputs?.documents[0].preprocessing).toEqual(doc.preprocessing);
    const parsed = await alice.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`);
    expect(pending.body.inputs?.documentTexts?.[doc.id]?.text).toBe(parsed.body.text);
    const done = await driveRun(alice, pid, runId);
    expect(done.status).toBe("ready_for_review");
    const report = await alice.json<RunResearch>("GET", `/api/projects/${pid}/runs/${runId}/research`);
    expect(report.status).toBe(200);
    expect(report.body.run.completedStepKeys?.sort()).toEqual(report.body.checkpoints.map((c) => c.key).sort());
    expect(report.body.checkpoints.map((c) => c.key).sort()).toEqual(created.body.run.steps.map((s) => s.key).sort());
    expect(report.body.checkpoints.every((c) => typeof c.trace?.durationMs === "number" && c.trace.durationMs >= 0)).toBe(true);
    const final = report.body.checkpoints.find((c) => c.key === "finalize")!;
    expect(final.payload).toHaveProperty("revisionId", done.resultRevisionId);
    if (kind === "extraction") {
      expect(report.body.inputs?.baseRevision?.content.modules[0].turtle).toBe(TBOX);
      const chunk = report.body.checkpoints.find((c) => c.key.startsWith("chunk:"))!;
      expect(chunk.trace?.input).toHaveProperty("schema.classes");
      expect(chunk.trace?.technical?.find((t) => t.title === "Schema retrieval scores")?.rows.length).toBeGreaterThan(0);
      expect(report.body.run.options?.reuseCache).toBe(false);
      expect(report.body.checkpoints.find((c) => c.key === "resolve")?.trace?.technical).toBeDefined();
      for (const reuseCache of [true, false]) {
        const options = {
          relevanceScreen: false,
          resolveEntities: true,
          verifyEvidence: true,
          repair: false,
          schemaRetrieval: "force",
          schemaTopK: 2,
          reuseCache,
        };
        const estimate = await alice.json<{ estimate: { cached: number } }>("POST", `/api/projects/${pid}/runs/estimate`, {
          documentIds: [doc.id],
          provider: "mock",
          model: "mock-1",
          mode: "automatic",
          options,
        });
        expect(estimate.body.estimate.cached).toBe(reuseCache ? doc.chunkCount : 0);
        const repeat = await alice.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
          documentIds: [doc.id],
          provider: "mock",
          model: "mock-1",
          mode: "automatic",
          options,
        });
        expect(repeat.status).toBe(201);
        expect((await driveRun(alice, pid, repeat.body.run.id)).status).toBe("ready_for_review");
        const repeated = await alice.json<RunResearch>("GET", `/api/projects/${pid}/runs/${repeat.body.run.id}/research`);
        const repeatedChunk = repeated.body.checkpoints.find((c) => c.key.startsWith("chunk:"))!;
        expect(repeatedChunk.via).toBe(reuseCache ? "cache" : undefined);
        if (!reuseCache) expect(repeatedChunk.trace?.technical?.some((t) => t.title === "Schema retrieval scores")).toBe(true);
      }

      expect(chunk.abox.individuals.length).toBeGreaterThan(0);
      expect(report.body.checkpoints.find((c) => c.key === "verify")?.trace?.diagnostics?.backend).toBe("lexical");
    } else {
      expect(report.body.run.steps.find((s) => s.kind === "terms")?.technical?.[0].rows.length).toBeGreaterThan(0);
      expect(report.body.checkpoints.find((c) => c.key === "merge")?.trace?.technical?.[0].rows.length).toBeGreaterThan(0);
      expect(report.body.checkpoints.find((c) => c.key === "terms:0")?.payload).toHaveProperty("classes");
      expect(report.body.checkpoints.find((c) => c.key === "terms:0")?.trace?.input?.sampledDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("station contains"),
            chunkId: expect.any(String),
            start: expect.any(Number),
          }),
        ]),
      );
    }
    const reparse = await alice.json("POST", `/api/projects/${pid}/documents/${doc.id}/retry`);
    expect(reparse.status).toBe(409);
    await alice.json("DELETE", `/api/projects/${pid}/documents/${doc.id}`);
    const retained = await alice.json<RunResearch>("GET", `/api/projects/${pid}/runs/${runId}/research`);
    expect(retained.body.inputs).toEqual(report.body.inputs);
    expect(retained.body.inputs?.chunks[0].text).toContain("station contains");
    const revision = await alice.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`);
    if (kind === "extraction") {
      await alice.json("PATCH", `/api/projects/${pid}/revisions/${done.resultRevisionId}`, {
        content: { ...revision.body.revision.content, abox: { individuals: [] } },
      });
      const afterEdit = await alice.json<RunResearch>("GET", `/api/projects/${pid}/runs/${runId}/research`);
      expect(afterEdit.body.checkpoints.find((c) => c.key === "finalize")?.abox).toEqual(final.abox);
    }
    expect((await app.as("bob").json("GET", `/api/projects/${pid}/runs/${runId}/research`)).status).toBe(404);
  });
});
