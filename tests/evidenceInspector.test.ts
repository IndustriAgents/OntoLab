import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalStore } from "../server/store/local.ts";
import { listFacts } from "../src/lib/ontology/factReview.ts";
import { buildTboxEvidence } from "../src/lib/tboxEvidence.ts";
import type { EvidenceRef } from "../src/types/abox.ts";
import type { EvidenceInspection, EvidenceStructure, EvidenceTarget } from "../src/types/evidence.ts";
import type { DocumentText, ProjectDocument, RevisionWithContent, RunView } from "../src/types/project.ts";
import type { RunResearch } from "../src/types/research.ts";
import { startApp, driveRun, type Client, type TestApp } from "./helpers.ts";

const TBOX = await readFile(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
const TEXT =
  "# Operating limits\n\n🧪 The station contains a sensor and a cylinder. The cylinder moves the workpiece.\n\n| Device | Pressure |\n| --- | --- |\n| Sensor | 16 bar |\n| Cylinder | 25 bar |\n\nCorrosive service has not been assessed.";
let app: TestApp, alice: Client;
beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
});
afterEach(async () => app.close());
const options = { relevanceScreen: false, schemaRetrieval: "off", resolveEntities: false, verifyEvidence: true, reuseCache: true };
async function fixture() {
  const pid = (
    await alice.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Evidence checks",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  const base = (
    await alice.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
      source: "import",
      content: { modules: [{ name: "core.ttl", turtle: TBOX }], abox: null, baseIri: "http://example.org/data#" },
    })
  ).body.revision;
  expect((await alice.json("POST", `/api/projects/${pid}/revisions/${base.id}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
  const doc = (await alice.upload(`/api/projects/${pid}/documents`, "manual.md", TEXT)).body.document as ProjectDocument;
  const parsed = (await alice.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`)).body;
  const run = (
    await alice.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      documentIds: [doc.id],
      provider: "mock",
      model: "mock-1",
      mode: "automatic",
      options,
    })
  ).body.run;
  const done = await driveRun(alice, pid, run.id);
  expect(done.status).toBe("ready_for_review");
  const revision = (await alice.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`))
    .body.revision;
  const chunkId = parsed.chunks[0].id;
  const ref: EvidenceRef = {
    runId: run.id,
    documentId: doc.id,
    chunkId,
    quote: "The cylinder moves the workpiece.",
    status: "verified",
    start: parsed.text.indexOf("The cylinder moves"),
    end: parsed.text.indexOf("The cylinder moves") + "The cylinder moves the workpiece.".length,
    confidence: 0.2,
    claim: "The cylinder supports corrosive service.",
    review: true,
  };
  return { pid, doc, parsed, run, revision, ref };
}
async function inspect(pid: string, target: EvidenceTarget, extra = {}) {
  return alice.json<EvidenceInspection>("POST", `/api/projects/${pid}/evidence/inspect`, { target, ...extra });
}
async function assertion(f: Awaited<ReturnType<typeof fixture>>, refs: EvidenceRef[]) {
  const value = {
    ...f.revision.content,
    abox: {
      individuals: [
        {
          id: "cylinder",
          label: "Cylinder",
          classUri: "http://example.org/Cylinder",
          review: { status: "candidate", by: "auto" },
          evidence: refs,
        },
      ],
    },
  };
  return (
    await alice.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${f.pid}/revisions`, { source: "manual", content: value })
  ).body.revision;
}

describe("unified evidence API", () => {
  it("keeps source location, claim support and human review separate and switches retained sources", async () => {
    const f = await fixture();
    const other = (await alice.upload(`/api/projects/${f.pid}/documents`, "second.txt", "A separate source that is unverified.")).body
      .document as ProjectDocument;
    const rev = await assertion(f, [f.ref, { documentId: other.id, quote: "A separate source", status: "verified", confidence: 0.9 }]);
    const target = { kind: "fact", revisionId: rev.id, factKey: "cylinder#type" } as const;
    const first = await inspect(f.pid, target);
    expect(first.status).toBe(200);
    expect(first.body.source).toMatchObject({
      match: "exact",
      support: "review",
      snapshot: true,
      integrity: "match",
      reference: { confidence: 0.2, review: true },
    });
    expect(first.body.assertion).toMatchObject({ status: "candidate", review: { by: "auto" } });
    expect(
      first.body.source!.excerpt!.text.slice(first.body.source!.excerpt!.highlight!.start, first.body.source!.excerpt!.highlight!.end),
    ).toBe(f.ref.quote);
    expect(first.body.totalSources).toBe(2);
    expect(first.body.inputs).toBeUndefined();
    const second = await inspect(f.pid, target, { sourceIndex: 1 });
    expect(second.body.sources[1].name).toBe(other.name);
    expect(second.body.source?.snapshot).toBe(false);
    expect(second.body.source?.reference.confidence).toBe(0.9);
    expect(second.body.source?.support).toBe("score-only");
    expect((await inspect(f.pid, target, { sourceIndex: 2 })).status).toBe(404);
    expect(JSON.stringify(first.body)).not.toMatch(/storagePath|ownerId|research\/.*inputs\.json/);
  });

  it("retains names, UTF-16 highlights and readable text after current documents and originals are removed", async () => {
    const f = await fixture(),
      rev = await assertion(f, [f.ref]);
    const target = { kind: "fact", revisionId: rev.id, factKey: "cylinder#type" } as const;
    const before = await inspect(f.pid, target);
    expect((await alice.json("DELETE", `/api/projects/${f.pid}/documents/${f.doc.id}`)).status).toBe(200);
    const after = await inspect(f.pid, target);
    expect(after.body.sources).toEqual(before.body.sources);
    expect(after.body.source?.excerpt).toEqual(before.body.source?.excerpt);
    expect(after.body.source?.originalAvailable).toBe(false);
    const text = await alice.json<DocumentText & { name: string }>(
      "GET",
      `/api/projects/${f.pid}/runs/${f.run.id}/documents/${f.doc.id}/evidence`,
    );
    expect(text.status).toBe(200);
    expect(text.body.name).toBe(f.doc.name);
    expect(text.body.text).toBe(f.parsed.text);
    expect((await alice.json("POST", `/api/projects/${f.pid}/evidence/original`, { target })).status).toBe(410);
  });

  it("rejects foreign projects, documents, chunks, stages and fabricated associations", async () => {
    const f = await fixture();
    const target = { kind: "passage", runId: f.run.id, documentId: f.doc.id, chunkId: f.ref.chunkId! } as const;
    expect((await app.as("bob").json("POST", `/api/projects/${f.pid}/evidence/inspect`, { target })).status).toBe(404);
    expect((await app.as(null).json("POST", `/api/projects/${f.pid}/evidence/inspect`, { target })).status).toBe(401);
    const other = (await alice.upload(`/api/projects/${f.pid}/documents`, "outside.txt", "This file was not part of the run.")).body
      .document as ProjectDocument;
    expect((await inspect(f.pid, { ...target, documentId: other.id })).status).toBe(404);
    expect((await inspect(f.pid, { ...target, chunkId: "foreign-chunk" })).status).toBe(404);
    expect((await inspect(f.pid, { ...target, stepKey: "finalize" })).status).toBe(404);
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    await store.runs.update(f.pid, f.run.id, {
      steps: [
        ...f.run.steps,
        { key: "another-passage", kind: "chunk", documentId: f.doc.id, chunkId: "another-chunk", label: "Another passage" },
      ],
    });
    expect((await inspect(f.pid, { ...target, stepKey: "another-passage" })).status).toBe(404);
    expect((await inspect(f.pid, { kind: "fact", revisionId: f.revision.id, factKey: "invented#type" })).status).toBe(404);
    expect((await inspect(f.pid, { kind: "answer", conversationId: "foreign", messageId: "fabricated", ref: "C1" })).status).toBe(404);
    for (const body of [
      { target: { kind: "unknown" } },
      { target, sourceIndex: -1 },
      { target, part: "all" },
      { target: { kind: "term", termId: "x" } },
    ])
      expect((await alice.json("POST", `/api/projects/${f.pid}/evidence/inspect`, body)).status).toBe(400);
  });

  it("does not replace a missing historical snapshot with live text or trust browser scores", async () => {
    const f = await fixture();
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    await store.blobs.delete(`${f.pid}/research/${f.run.id}/inputs.json`);
    const missing = await inspect(f.pid, { kind: "reference", runId: f.run.id, documentId: f.doc.id, quote: f.ref.quote });
    expect(missing.body.source?.excerpt).toBeUndefined();
    expect(missing.body.source?.unavailable).toMatch(/Historical text unavailable/);
    const unsafe = await alice.json<EvidenceInspection>("POST", `/api/projects/${f.pid}/evidence/inspect`, {
      target: { kind: "reference", documentId: f.doc.id, quote: f.ref.quote, confidence: 1, review: false, status: "verified" },
    });
    expect(unsafe.body.source?.match).toBe("exact");
    expect(unsafe.body.source?.reference.confidence).toBeUndefined();
    expect(unsafe.body.assertion).toBeUndefined();
  });

  it("shows normalized and elided matches without moving mismatched stored offsets", async () => {
    const f = await fixture();
    const normalized = await inspect(f.pid, { kind: "reference", runId: f.run.id, documentId: f.doc.id, quote: f.ref.quote.toUpperCase() });
    expect(normalized.body.source?.match).toBe("normalized");
    const partial = await inspect(f.pid, {
      kind: "reference",
      runId: f.run.id,
      documentId: f.doc.id,
      quote: "The station contains … The cylinder moves the workpiece.",
    });
    expect(partial.body.source?.match).toBe("partial");
    const mismatch = await inspect(f.pid, {
      kind: "reference",
      runId: f.run.id,
      documentId: f.doc.id,
      quote: f.ref.quote,
      start: 0,
      end: 12,
    });
    expect(mismatch.body.source?.match).toBe("mismatch");
    expect(mismatch.body.source?.excerpt?.highlight).toBeUndefined();
    expect(
      (await inspect(f.pid, { kind: "reference", documentId: f.doc.id, quote: "An invented scientific result." })).body.source?.match,
    ).toBe("not-found");
    const manual = await assertion(f, []);
    expect((await inspect(f.pid, { kind: "fact", revisionId: manual.id, factKey: "cylinder#type" })).body.message).toMatch(
      /No quoted source/,
    );
  });

  it("loads recorded support-check inputs lazily and labels cache reuse honestly", async () => {
    const f = await fixture();
    const fact = listFacts(f.revision.content.abox!).find((r) => r.evidence.some((ev) => ev.check));
    expect(fact).toBeDefined();
    const inputs = await inspect(f.pid, { kind: "fact", revisionId: f.revision.id, factKey: fact!.key }, { part: "input" });
    expect(inputs.body.inputs?.find((b) => b.label === "Support check")).toMatchObject({
      state: "recorded",
      text: expect.stringContaining("lexical-1"),
    });
    const again = (
      await alice.json<{ run: RunView }>("POST", `/api/projects/${f.pid}/runs`, {
        documentIds: [f.doc.id],
        provider: "mock",
        model: "mock-1",
        mode: "automatic",
        options,
      })
    ).body.run;
    expect((await driveRun(alice, f.pid, again.id)).status).toBe("ready_for_review");
    const cached = await inspect(
      f.pid,
      { kind: "passage", runId: again.id, documentId: f.doc.id, chunkId: f.ref.chunkId! },
      { part: "input" },
    );
    expect(cached.body.inputs?.[0]).toMatchObject({ state: "reused" });
  });

  it("does not present an omitted or unrecorded historical generation passage as an exact input", async () => {
    const f = await fixture();
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    const checkpoint = (await store.runs.checkpoints(f.pid, f.run.id)).find((cp) =>
      f.run.steps.some((step) => step.key === cp.key && step.chunkId === f.ref.chunkId),
    )!;
    expect(checkpoint).toBeDefined();
    const target = { kind: "passage", runId: f.run.id, documentId: f.doc.id, chunkId: f.ref.chunkId! } as const;
    await store.runs.deleteCheckpoints(f.pid, f.run.id, checkpoint.key);
    await store.runs.putCheckpoint(f.pid, { ...checkpoint, trace: { durationMs: 1, input: { sampledDocuments: [] } } });
    const omitted = await inspect(f.pid, target, { part: "input" });
    expect(omitted.body.inputs?.find((b) => b.label === "Generation passage")).toMatchObject({
      state: "unavailable",
      note: expect.stringContaining("absent"),
    });
    expect(omitted.body.inputs?.find((b) => b.label === "Generation passage")?.text).toBeUndefined();
    await store.runs.deleteCheckpoints(f.pid, f.run.id, checkpoint.key);
    await store.runs.putCheckpoint(f.pid, { ...checkpoint, trace: undefined });
    const reconstructed = await inspect(f.pid, target, { part: "input" });
    expect(reconstructed.body.inputs?.find((b) => b.label === "Generation passage")).toMatchObject({ state: "reconstructed" });
  });

  it("highlights parsed table rows and verifies retained original bytes before returning them", async () => {
    const f = await fixture();
    const at = f.parsed.text.indexOf("| Sensor | 16 bar |");
    const target = {
      kind: "reference",
      runId: f.run.id,
      documentId: f.doc.id,
      quote: "| Sensor | 16 bar |",
      start: at,
      end: at + "| Sensor | 16 bar |".length,
    } as const;
    const result = await inspect(f.pid, target);
    expect(result.body.source?.table?.rows.filter((row) => row.highlighted).map((row) => row.cells)).toEqual([["Sensor", "16 bar"]]);
    expect(result.body.source?.table?.rows[0].header).toBe(true);
    const original = await alice.get(`/api/projects/${f.pid}/documents/${f.doc.id}/file`);
    expect(original.status).toBe(200);
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    const doc = await store.documents.get(f.pid, f.doc.id);
    await store.blobs.put(doc!.storagePath, Buffer.from("changed source"), "text/plain");
    expect((await alice.json("POST", `/api/projects/${f.pid}/evidence/original`, { target })).status).toBe(409);
  });

  it("opens induced-term evidence from its saved build and rejects a revision from another build", async () => {
    const f = await fixture();
    const created = (
      await alice.json<{ run: RunView }>("POST", `/api/projects/${f.pid}/runs`, {
        documentIds: [f.doc.id],
        kind: "induction",
        provider: "mock",
        model: "mock-1",
        options: { repair: false, inductionAxioms: false },
      })
    ).body.run;
    const done = await driveRun(alice, f.pid, created.id);
    const report = (await alice.json<RunResearch>("GET", `/api/projects/${f.pid}/runs/${created.id}/research`)).body;
    const revision = (
      await alice.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${f.pid}/revisions/${done.resultRevisionId}`)
    ).body.revision;
    const term = buildTboxEvidence(report, revision).terms.find((t) => t.citations.some((c) => c.located));
    expect(term).toBeDefined();
    const inspected = await inspect(f.pid, { kind: "term", runId: created.id, revisionId: revision.id, termId: term!.id });
    expect(inspected.status).toBe(200);
    expect(inspected.body.source?.snapshot).toBe(true);
    expect(inspected.body.source?.reference.confidence).toBeUndefined();
    expect((await inspect(f.pid, { kind: "term", runId: created.id, revisionId: f.revision.id, termId: term!.id })).status).toBe(404);
  });

  it("resolves recorded XML paths and table spans without accepting client file paths or XPath", async () => {
    const f = await fixture();
    const xml = `<article><body><sec><title>Limits</title><table-wrap><caption>Pressure in water</caption><table><thead><tr><th>Pump</th><th colspan="2">Rating</th></tr></thead><tbody><tr><td>P-101</td><td>16 bar</td><td>20 °C</td></tr></tbody></table><table-wrap-foot>Clean water only.</table-wrap-foot></table-wrap></sec></body></article>`;
    const doc = (await alice.upload(`/api/projects/${f.pid}/documents`, "table.xml", xml)).body.document as ProjectDocument;
    const parsed = (await alice.json<DocumentText>("GET", `/api/projects/${f.pid}/documents/${doc.id}/text`)).body;
    const target = { kind: "passage", documentId: doc.id, chunkId: parsed.chunks[0].id } as const;
    const inspected = await inspect(f.pid, target);
    const index = inspected.body.source!.paths.findIndex((p) => p.endsWith("/table[1]"));
    expect(index).toBeGreaterThanOrEqual(0);
    const element = await alice.json<EvidenceStructure>("POST", `/api/projects/${f.pid}/evidence/structure`, {
      target,
      elementIndex: index,
      path: "/etc/passwd",
      xpath: "//private",
    });
    expect(element.status).toBe(200);
    expect(element.body.table?.rows[0].cells[1].colspan).toBe(2);
    expect(element.body.table?.rows[1].highlighted).toBe(true);
    expect(element.body.table?.caption).toBe("Pressure in water");
    expect(element.body.table?.footnotes).toBe("Clean water only.");
    expect(element.body.path).toBe(inspected.body.source!.paths[index]);
    expect((await alice.json("POST", `/api/projects/${f.pid}/evidence/structure`, { target, elementIndex: 999 })).status).toBe(404);
    expect((await app.as("bob").json("POST", `/api/projects/${f.pid}/evidence/structure`, { target, elementIndex: index })).status).toBe(
      404,
    );
  });

  it("keeps answer citations attached to their stored message and query evidence separate from document evidence", async () => {
    const f = await fixture();
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    await store.conversations.put({
      id: "conv_test",
      projectId: f.pid,
      revisionId: f.revision.id,
      title: "Evidence",
      createdAt: app.clock.now.toISOString(),
      updatedAt: app.clock.now.toISOString(),
      messages: [
        {
          id: "msg_answer",
          role: "assistant",
          mode: "ask",
          content: "A stored answer [C1] [Q1].",
          citations: [{ ref: "C1", evidence: f.ref }],
          createdAt: app.clock.now.toISOString(),
          agent: {
            source: "external",
            sourceLabel: "External graph",
            model: "mock-1",
            durationMs: 1,
            tools: [],
            trace: [],
            runs: [
              {
                id: "Q1",
                purpose: "agent",
                repositoryId: "external",
                kind: "select",
                query: "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }",
                ok: true,
                vars: ["count"],
                rows: [{ count: { type: "literal", value: "10" } }],
                rowCount: 1,
                durationMs: 1,
              },
            ],
          },
        },
      ],
    });
    const target = { kind: "answer", conversationId: "conv_test", messageId: "msg_answer", ref: "C1" } as const;
    const citation = await inspect(f.pid, target);
    expect(citation.body.source?.reference.quote).toBe(f.ref.quote);
    const query = await inspect(f.pid, { ...target, ref: "Q1" });
    expect(query.body.query?.rowCount).toBe(1);
    expect(query.body.sources).toEqual([]);
    expect(query.body.message).toMatch(/No document citation/);
    expect((await inspect(f.pid, { ...target, messageId: "other_message" })).status).toBe(404);
    expect((await inspect(f.pid, { ...target, ref: "C2" })).status).toBe(404);
  });
});
