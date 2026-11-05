import { randomUUID } from "node:crypto";
import { createPostgresStore } from "../server/store/postgres.ts";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";
import type { Project, ProjectDocument, RevisionWithContent, RunView } from "../src/types/project.ts";
import type { CorpusPlan } from "../src/types/corpus.ts";
import { listFacts } from "../src/lib/ontology/factReview.ts";
const ttl =
  "@prefix ex:<http://example.org/#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. ex:Pump a owl:Class. ex:Sensor a owl:Class. ex:Valve a owl:Class. ex:connects a owl:ObjectProperty; rdfs:domain ex:Pump; rdfs:range ex:Sensor.";
const pgStore = process.env.CORPUS_TEST_DATABASE_URL ? createPostgresStore(process.env.CORPUS_TEST_DATABASE_URL) : undefined;
afterAll(async () => {
  await pgStore?.close?.();
});
let app: TestApp, c: Client, pid: string, rid: string;
beforeEach(async () => {
  app = await startApp({ store: pgStore });
  c = app.as(pgStore ? `corpus-check-${randomUUID()}` : "alice");
  pid = (
    await c.json<{ project: Project }>("POST", "/api/projects", {
      name: "Research",
      settings: { provider: "mock", model: "mock-1", models: { embeddings: "hash", nli: "off" } },
    })
  ).body.project.id;
  const draft = await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
    source: "import",
    content: {
      modules: [{ id: "core", name: "schema.ttl", turtle: ttl }],
      abox: { individuals: [{ id: "parent-only", classUri: "http://example.org/#Pump" }] },
      baseIri: "http://example.org/#",
    },
  });
  rid = draft.body.revision.id;
  expect((await c.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
});
afterEach(async () => {
  if (pgStore && c) {
    const roots = await c.json<{ projects: Project[] }>("GET", "/api/projects");
    for (const p of roots.body.projects ?? []) await c.json("DELETE", `/api/projects/${p.id}`);
  }
  await app.close();
});
async function corpus(name = "Housing") {
  const result = await c.json<{ corpus: Project }>("POST", `/api/projects/${pid}/corpora`, {
    name,
    ontologyRevisionId: rid,
    provider: "mock",
    model: "mock-1",
  });
  expect(result.status).toBe(201);
  return result.body.corpus;
}
const cp = (id: string) => `/api/projects/${id}/corpus`;
async function graph(id: string, revisionId?: string) {
  if (revisionId)
    return (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${id}/revisions/${revisionId}`)).body.revision;
  return (await c.json<{ graph: RevisionWithContent }>("GET", cp(id))).body.graph;
}
async function plan(id: string) {
  return (await c.json<CorpusPlan>("POST", `${cp(id)}/plan`, {})).body;
}
async function extract(id: string) {
  const p = await plan(id);
  expect(p.errors).toEqual([]);
  const started = await c.json<{ run: RunView }>("POST", `${cp(id)}/updates`, { hash: p.hash });
  expect(started.status).toBe(200);
  const done = await driveRun(c, id, started.body.run.id);
  expect(done.status).toBe("ready_for_review");
  return graph(id, done.resultRevisionId!);
}
async function publish(id: string, rev: RevisionWithContent) {
  const decisions = listFacts(rev.content.abox!).map((f) => ({ key: f.key, status: "accepted" }));
  if (decisions.length)
    expect((await c.json("POST", `/api/projects/${id}/revisions/${rev.id}/facts/review`, { decisions })).status).toBe(200);
  const result = await c.json("POST", `/api/projects/${id}/revisions/${rev.id}/commit`, { acknowledgedWarnings: true });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return graph(id);
}
async function upload(id: string, name: string, text: string, member?: string) {
  const result = await c.upload(`${cp(id)}/documents${member ? `?member=${member}` : ""}`, name, text, false);
  expect([200, 201]).toContain(result.status);
  await app.processDocuments();
  return result.body as { document: ProjectDocument; member: { id: string }; duplicate: boolean };
}

describe("isolated, repeat-safe corpus workflow", () => {
  it("starts empty, pins a saved ontology, and keeps ontology sources and project facts separate", async () => {
    await c.upload(`/api/projects/${pid}/documents`, "ontology.txt", "Sensor ontology definitions.");
    const a = await corpus(),
      b = await corpus("Energy");
    expect(a.id).not.toBe(b.id);
    expect((await graph(a.id)).content.abox?.individuals).toEqual([]);
    expect((await graph(a.id)).content.corpus?.ontology.revisionId).toBe(rid);
    expect((await c.json<{ documents: ProjectDocument[] }>("GET", `${cp(a.id)}/documents`)).body.documents).toEqual([]);
    expect((await c.json<{ projects: Project[] }>("GET", "/api/projects")).body.projects.map((p) => p.id)).toEqual([pid]);
  });
  it("deduplicates identical bytes despite different filenames and concurrent uploads", async () => {
    const a = await corpus();
    const files = await Promise.all([upload(a.id, "a.txt", "Pump first source."), upload(a.id, "renamed.txt", "Pump first source.")]);
    expect(files.filter((f) => f.duplicate)).toHaveLength(1);
    const detail = (await c.json<{ corpus: Project }>("GET", cp(a.id))).body;
    expect(detail.corpus.settings.corpus?.members).toHaveLength(1);
    expect((await c.json<{ documents: ProjectDocument[] }>("GET", `${cp(a.id)}/documents`)).body.documents).toHaveLength(1);
  });
  it("automatically prepares sources and rejects ontology documents and unplanned extraction", async () => {
    const a = await corpus();
    const doc = await upload(a.id, "sources.txt", "Pump uses Sensor.");
    const prepared = (await c.json<{ documents: ProjectDocument[] }>("GET", `${cp(a.id)}/documents`)).body.documents[0];
    expect(prepared.parseState).toBe("parsed");
    expect(prepared.chunkCount).toBeGreaterThan(0);
    expect(prepared.preprocessing?.settings.unit).toBe("tokens");
    expect(doc.member.id).toBeTruthy();
    const run = await c.json("POST", `/api/projects/${a.id}/runs`, {
      provider: "mock",
      model: "mock-1",
      documentIds: [prepared.id],
      kind: "extraction",
    });
    expect(run.status).toBe(409);
  });
  it("extracts a reviewable draft, saves it, and skips unchanged sources without another run", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const before = (await graph(a.id)).id,
      draft = await extract(a.id);
    expect((await graph(a.id)).id).toBe(before);
    expect(draft.content.abox?.individuals.length).toBeGreaterThan(0);
    expect(draft.content.abox!.individuals.every((i) => i.origins?.some((o) => o.kind === "document"))).toBe(true);
    const saved = await publish(a.id, draft);
    expect(saved.content.corpus!.sources).toHaveLength(1);
    const p = await plan(a.id);
    expect(p.processDocumentIds).toEqual([]);
    expect(p.reused).toBe(1);
    expect((await c.json<{ upToDate: boolean }>("POST", `${cp(a.id)}/updates`, { hash: p.hash })).body.upToDate).toBe(true);
    expect((await graph(a.id)).id).toBe(saved.id);
  });
  it("stores one fact with support from two sources instead of duplicating knowledge", async () => {
    const a = await corpus();
    await upload(a.id, "first.txt", "Pump connects Sensor.");
    await publish(a.id, await extract(a.id));
    await upload(a.id, "second.txt", "Pump connects Sensor in this second source.");
    const next = await extract(a.id);
    const pump = next.content.abox!.individuals.find((i) => i.id === "pump")!;
    expect(next.content.abox!.individuals.filter((i) => i.id === "pump")).toHaveLength(1);
    expect(new Set(pump.origins?.map((o) => o.documentId)).size).toBe(2);
    expect(pump.objectProperties).toHaveLength(1);
    expect(new Set(pump.objectProperties![0].evidence?.map((e) => e.documentId)).size).toBe(2);
  });
  it("removes only a source's support, preserves other support, and retains historical files", async () => {
    const a = await corpus();
    const first = await upload(a.id, "first.txt", "Pump connects Sensor."),
      second = await upload(a.id, "second.txt", "Pump connects Sensor elsewhere.");
    const saved = await publish(a.id, await extract(a.id));
    expect((await c.json("PUT", `${cp(a.id)}/members/${first.member.id}`, { removed: true })).status).toBe(200);
    const p = await plan(a.id);
    expect(p.affected.retained).toBeGreaterThan(0);
    expect(p.affected.lost).toBe(0);
    const start = await c.json<{ revision: RevisionWithContent }>("POST", `${cp(a.id)}/updates`, { hash: p.hash });
    const rev = await graph(a.id, start.body.revision.id);
    expect(rev.content.abox!.individuals[0].origins!.every((o) => o.documentId === second.document.id)).toBe(true);
    await publish(a.id, rev);
    expect((await graph(a.id, saved.id)).content.corpus!.sources).toHaveLength(2);
    expect((await c.get(`/api/projects/${a.id}/documents/${first.document.id}/text`)).status).toBe(200);
    expect((await c.json("DELETE", `/api/projects/${a.id}/documents/${first.document.id}`)).status).toBe(409);
  });
  it("requires a decision on facts that lose their only source and can retain them as manual knowledge", async () => {
    const a = await corpus(),
      file = await upload(a.id, "only.txt", "Pump connects Sensor.");
    await publish(a.id, await extract(a.id));
    await c.json("PUT", `${cp(a.id)}/members/${file.member.id}`, { removed: true });
    const p = await plan(a.id);
    const start = await c.json<{ revision: RevisionWithContent }>("POST", `${cp(a.id)}/updates`, { hash: p.hash });
    const draft = await graph(a.id, start.body.revision.id);
    expect(draft.content.corpus!.losses.length).toBeGreaterThan(0);
    expect((await c.json("POST", `/api/projects/${a.id}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true })).status).toBe(409);
    expect(
      (
        await c.json("POST", `${cp(a.id)}/updates/${draft.id}/losses`, {
          keys: draft.content.corpus!.losses.map((l) => l.key),
          decision: "manual",
        })
      ).status,
    ).toBe(200);
    const manual = await graph(a.id, draft.id);
    expect(manual.content.abox!.individuals.every((i) => i.origins?.some((o) => o.kind === "manual"))).toBe(true);
    expect(
      (
        await c.json("POST", `${cp(a.id)}/updates/${draft.id}/losses`, {
          keys: draft.content.corpus!.losses.map((l) => l.key),
          decision: "remove",
        })
      ).status,
    ).toBe(409);
    expect((await graph(a.id, draft.id)).contentHash).toBe(manual.contentHash);
    expect((await c.json("POST", `/api/projects/${a.id}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
  });
  it("rejects a stale extraction plan and never changes another user's corpus", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const old = await plan(a.id);
    await upload(a.id, "new.txt", "Valve is documented.");
    expect((await c.json("POST", `${cp(a.id)}/updates`, { hash: old.hash })).status).toBe(409);
    expect((await app.as("bob").json("GET", cp(a.id))).status).toBe(404);
    expect((await app.as("bob").json("POST", `${cp(a.id)}/plan`, {})).status).toBe(404);
  });
  it("keeps an older ontology pinned until an explicit upgrade is reviewed and saved", async () => {
    const a = await corpus();
    const draft = (
      await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
        content: {
          modules: [{ id: "new", name: "v2.ttl", turtle: ttl + " ex:Controller a owl:Class." }],
          abox: null,
          baseIri: "http://example.org/#",
        },
        source: "import",
      })
    ).body.revision;
    await c.json("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true });
    expect((await graph(a.id)).content.corpus!.ontology.revisionId).toBe(rid);
    await c.json("PUT", `${cp(a.id)}/settings`, { ontologyRevisionId: draft.id });
    const p = await plan(a.id);
    expect(p.ontology.revisionId).toBe(draft.id);
    const start = await c.json<{ revision: RevisionWithContent }>("POST", `${cp(a.id)}/updates`, { hash: p.hash });
    expect((await graph(a.id)).content.corpus!.ontology.revisionId).toBe(rid);
    await publish(a.id, await graph(a.id, start.body.revision.id));
    expect((await graph(a.id)).content.corpus!.ontology.revisionId).toBe(draft.id);
  });
});

describe("portable corpus history", () => {
  async function roundTrip(id: string) {
    const res = await c.get(`/api/projects/${id}/archive`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const archive = JSON.parse(gunzipSync(bytes).toString("utf8"));
    const result = await c.upload("/api/projects/import", "backup.ontolab.json.gz", bytes, false);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return { archive, root: result.body.project as Project };
  }
  it("round-trips isolated corpora, pinned ontologies, source history and immutable evidence snapshots", async () => {
    const a = await corpus();
    const original = await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const saved = await publish(a.id, await extract(a.id));
    await c.json("PUT", `${cp(a.id)}/members/${original.member.id}`, { removed: true });
    const { archive, root } = await roundTrip(pid);
    expect(archive.version).toBe(2);
    expect(archive.corpora).toHaveLength(1);
    const imported = (await c.json<{ corpora: Project[] }>("GET", `/api/projects/${root.id}/corpora`)).body.corpora[0];
    expect(imported.id).not.toBe(a.id);
    const restored = await graph(imported.id);
    const pin = restored.content.corpus!.ontology;
    expect(pin.projectId).toBe(root.id);
    expect(pin.revisionId).not.toBe(rid);
    expect(restored.content.abox!.individuals).toHaveLength(saved.content.abox!.individuals.length);
    const ev = restored.content.abox!.individuals[0].evidence![0];
    expect(ev.documentId).not.toBe(original.document.id);
    expect(ev.runId).toBeTruthy();
    const snap = await c.json<{ text: string }>("GET", `${cp(imported.id)}/evidence?run=${ev.runId}&document=${ev.documentId}`);
    expect(snap.status, JSON.stringify(snap.body)).toBe(200);
    expect(JSON.stringify(snap.body)).toContain("Pump connects Sensor.");
    const p = await plan(imported.id);
    expect(p.processDocumentIds).toEqual([]);
    expect(p.removeDocumentIds).toHaveLength(1);
    const restoredMember = imported.settings.corpus!.members[0];
    await c.json("PUT", `${cp(imported.id)}/members/${restoredMember.id}`, { removed: false });
    expect((await plan(imported.id)).reused).toBe(1);
    const importedRun = (await c.json<{ run: RunView }>("GET", `/api/projects/${imported.id}/runs/${ev.runId}`)).body.run;
    expect(importedRun.documentChecksums[ev.documentId!]).toBe(original.document.checksum);
  });
  it("exports a corpus with its ontology package but without sibling corpora or ontology source files", async () => {
    const a = await corpus(),
      b = await corpus("Other corpus");
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    await upload(b.id, "private-other.txt", "Private sibling source.");
    await c.upload(`/api/projects/${pid}/documents`, "ontology-original.txt", "Ontology authoring source.");
    const { archive, root } = await roundTrip(a.id);
    expect(archive.documents).toEqual([]);
    expect(archive.corpora).toHaveLength(1);
    expect(archive.corpora[0].project.name).toBe(a.name);
    expect(JSON.stringify(archive)).not.toContain("private-other.txt");
    expect(JSON.stringify(archive)).not.toContain("ontology-original.txt");
    const imported = (await c.json<{ corpora: Project[] }>("GET", `/api/projects/${root.id}/corpora`)).body.corpora[0];
    expect((await plan(imported.id)).processDocumentIds).toHaveLength(1);
  });
  it("restores active extraction as cancelled without automatically calling a model", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const p = await plan(a.id);
    await c.json("POST", `${cp(a.id)}/updates`, { hash: p.hash });
    const { root } = await roundTrip(pid);
    const imported = (await c.json<{ corpora: Project[] }>("GET", `/api/projects/${root.id}/corpora`)).body.corpora[0];
    const runs = (await c.json<{ runs: RunView[] }>("GET", `/api/projects/${imported.id}/runs`)).body.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("cancelled");
  });
});

describe("corpus update safety", () => {
  it("reserves one extraction when two clients start the same plan concurrently", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const p = await plan(a.id);
    const starts = await Promise.all([
      c.json("POST", `${cp(a.id)}/updates`, { hash: p.hash }),
      c.json("POST", `${cp(a.id)}/updates`, { hash: p.hash }),
    ]);
    expect(starts.some((r) => r.status === 200)).toBe(true);
    expect(starts.every((r) => [200, 409].includes(r.status))).toBe(true);
    const runs = (await c.json<{ runs: RunView[] }>("GET", `/api/projects/${a.id}/runs`)).body.runs;
    expect(runs).toHaveLength(1);
  });
  it("replaces only a source's latest contribution and retains the previous evidence snapshot", async () => {
    const a = await corpus();
    const first = await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const saved = await publish(a.id, await extract(a.id));
    const evidence = saved.content.abox!.individuals[0].evidence![0];
    const second = await upload(a.id, "paper-v2.txt", "Pump connects Sensor in the revised paper.", first.member.id);
    const p = await plan(a.id);
    expect(p.processDocumentIds).toEqual([second.document.id]);
    expect(p.removeDocumentIds).toContain(first.document.id);
    const draft = await extract(a.id);
    expect(draft.content.abox!.individuals.flatMap((i) => i.origins ?? []).every((o) => o.documentId === second.document.id)).toBe(true);
    expect(draft.content.abox!.individuals.map((i) => i.id)).toEqual(saved.content.abox!.individuals.map((i) => i.id));
    expect(listFacts(draft.content.abox!).every((f) => f.status === "accepted" && f.by === "user")).toBe(true);
    expect((await graph(a.id)).id).toBe(saved.id);
    const changes = (await c.json<{ changes: { added: unknown[]; enriched: unknown[] } }>("GET", `${cp(a.id)}/updates/${draft.id}`)).body
      .changes;
    expect(changes.added).toEqual([]);
    expect(changes.enriched.length).toBeGreaterThan(0);
    const snapshot = await c.json("GET", `${cp(a.id)}/evidence?run=${evidence.runId}&document=${evidence.documentId}`);
    expect(snapshot.status).toBe(200);
    expect(JSON.stringify(snapshot.body)).toContain("Pump connects Sensor.");
  });
  it("rejects stale replacement decisions and enforces corpus ownership", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const draft = await extract(a.id);
    const path = `${cp(a.id)}/updates/${draft.id}/replacement`;
    const input = { beforeKey: "missing", afterKey: "missing-too", decision: "proposed" };
    expect((await c.json("POST", path, input)).status).toBe(409);
    expect((await app.as("bob").json("POST", path, input)).status).toBe(404);
    expect((await c.json("POST", path, { ...input, decision: "anything" })).status).toBe(400);
  });
  it.each(["proposed", "previous"] as const)(
    "resolves a relationship replacement as %s without changing the saved graph",
    async (choice) => {
      const a = await corpus();
      const original = await upload(a.id, "spec.txt", "Pump connects Sensor.");
      const saved = await publish(a.id, await extract(a.id));
      await upload(a.id, "spec-v2.txt", "Pump connects Valve.", original.member.id);
      const draft = await extract(a.id);
      const result = (
        await c.json<{ changes: { updated: { before: { key: string }; after: { key: string } }[] } }>(
          "GET",
          `${cp(a.id)}/updates/${draft.id}`,
        )
      ).body;
      expect(draft.summary).toContain("replaced 1 document · 1 new entity");
      expect(result.changes.updated).toHaveLength(1);
      const change = result.changes.updated[0];
      const decision = await c.json("POST", `${cp(a.id)}/updates/${draft.id}/replacement`, {
        beforeKey: change.before.key,
        afterKey: change.after.key,
        decision: choice,
      });
      expect(decision.status).toBe(200);
      const updated = await graph(a.id, draft.id);
      expect(updated.content.corpus!.losses.find((l) => l.key === change.before.key)?.decision).toBe(
        choice === "proposed" ? "remove" : "manual",
      );
      expect(listFacts(updated.content.abox!).find((f) => f.key === change.after.key)?.status).toBe(
        choice === "proposed" ? "accepted" : "rejected",
      );
      if (choice === "previous") {
        const target = updated.content.abox!.individuals.find((i) => i.id === "sensor")!;
        expect(target.review?.status).toBe("accepted");
        expect(target.origins).toEqual([{ kind: "manual", types: [target.classUri] }]);
        expect(target.evidence).toBeUndefined();
        expect(updated.content.corpus!.losses.find((l) => l.subject.id === "sensor")?.decision).toBe("manual");
      }
      for (const retry of ["previous", "proposed"]) {
        expect(
          (
            await c.json("POST", `${cp(a.id)}/updates/${draft.id}/replacement`, {
              beforeKey: change.before.key,
              afterKey: change.after.key,
              decision: retry,
            })
          ).status,
        ).toBe(409);
        expect((await graph(a.id, draft.id)).contentHash).toBe(updated.contentHash);
      }
      expect((await graph(a.id)).id).toBe(saved.id);
      expect((await graph(a.id, saved.id)).content.abox!.individuals.find((i) => i.id === "pump")!.objectProperties![0].targetId).toBe(
        "sensor",
      );
    },
  );
  it("uses the accepted-only corpus policy for explicit draft queries as well as saved graph queries", async () => {
    const a = await corpus();
    await upload(a.id, "paper.txt", "Pump connects Sensor.");
    const draft = await extract(a.id);
    const sparql = "SELECT ?s WHERE {?s a <http://example.org/#Pump>}";
    const before = await c.json("POST", `/api/projects/${a.id}/revisions/${draft.id}/sparql`, { sparql });
    expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).not.toContain('"pump"');
    await publish(a.id, draft);
    const after = await c.json("POST", `/api/projects/${a.id}/revisions/${draft.id}/sparql`, { sparql });
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain("pump");
  });
});

it("restores source provenance when a reviewer undoes deleting an extracted entity", async () => {
  const a = await corpus();
  await upload(a.id, "paper.txt", "Pump connects Sensor.");
  const draft = await extract(a.id),
    id = draft.content.abox!.individuals[0].id;
  const modified = {
    ...draft.content,
    abox: { ...draft.content.abox!, individuals: draft.content.abox!.individuals.filter((i) => i.id !== id) },
  };
  expect((await c.json("PUT", `/api/projects/${a.id}/revisions/${draft.id}`, { content: modified })).status).toBe(200);
  expect((await c.json("PUT", `/api/projects/${a.id}/revisions/${draft.id}`, { content: draft.content })).status).toBe(200);
  const restored = await graph(a.id, draft.id),
    individual = restored.content.abox!.individuals.find((i) => i.id === id)!;
  expect(individual.origins).toEqual(draft.content.abox!.individuals[0].origins);
  expect(individual.evidence).toEqual(draft.content.abox!.individuals[0].evidence);
  expect(restored.content.corpus!.suppressed).toEqual([]);
});
