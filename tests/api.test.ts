import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createLocalStore } from "../server/store/local.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";

const TBOX = await readFile(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
const MANUAL = await readFile(new URL("../samples/distributing-manual.txt", import.meta.url));

let app: TestApp;
let alice: Client;
let bob: Client;

beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
  bob = app.as("bob");
});
afterEach(async () => app.close());

type J = Record<string, any>;

async function projectWithOntology(c: Client = alice): Promise<string> {
  const { body } = await c.json<J>("POST", "/api/projects", { name: "Test plant" });
  const pid = body.project.id as string;
  const draft = await c.json<J>("POST", `/api/projects/${pid}/revisions`, {
    content: { modules: [{ name: "mechatronic.ttl", turtle: TBOX }], abox: null, baseIri: "" },
    source: "import",
    summary: "T-Box",
  });
  expect(draft.status).toBe(201);
  const commit = await c.json<J>("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`, { acknowledgedWarnings: true });
  expect(commit.status).toBe(200);
  return pid;
}

describe("authentication and ownership", () => {
  it("reports web MCP unavailability explicitly without enabling connection management", async () => {
    const status = await alice.json("GET", "/api/local-mcp");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ available: false, connections: [], projects: [] });
    expect((await app.as(null).json("GET", "/api/local-mcp")).status).toBe(401);
    expect((await alice.json("POST", "/api/local-mcp/connections", { name: "Web client" })).status).toBe(404);
  });

  it("rejects requests without a session", async () => {
    const res = await app.as(null).json("GET", "/api/projects");
    expect(res.status).toBe(401);
  });

  it("never exposes one user's project to another", async () => {
    const pid = await projectWithOntology();
    expect((await bob.json("GET", `/api/projects/${pid}`)).status).toBe(404);
    expect((await bob.json("GET", `/api/projects/${pid}/revisions`)).status).toBe(404);
    expect((await bob.json("DELETE", `/api/projects/${pid}`)).status).toBe(404);
    expect((await bob.upload(`/api/projects/${pid}/documents`, "x.txt", "hello world")).status).toBe(404);
    expect(((await bob.json<J>("GET", "/api/projects")).body.projects as unknown[]).length).toBe(0);
    // and alice still has it
    expect((await alice.json("GET", `/api/projects/${pid}`)).status).toBe(200);
  });

  it("rejects malformed ids before they reach storage", async () => {
    expect((await alice.json("GET", "/api/projects/..%2F..%2Fetc")).status).toBe(404);
  });

  it("serves private downloads only to the owner", async () => {
    const pid = await projectWithOntology();
    const up = await alice.upload(`/api/projects/${pid}/documents`, "notes.txt", "The cylinder pushes the workpiece.");
    const did = (up.body.document as J).id;
    expect((await alice.get(`/api/projects/${pid}/documents/${did}/file`)).status).toBe(200);
    expect((await bob.get(`/api/projects/${pid}/documents/${did}/file`)).status).toBe(404);
  });
});

describe("static requests", () => {
  it("rejects malformed path encodings and keeps the server running", async () => {
    expect((await alice.get("/%")).status).toBe(400);
    expect((await alice.get("/%E0%A4%A")).status).toBe(400);
    expect((await alice.get("/api/health")).status).toBe(200);
  });
});

describe("projects", () => {
  it("creates, renames, lists and deletes", async () => {
    const created = await alice.json<J>("POST", "/api/projects", { name: "  Plant A  ", purpose: "p" });
    expect(created.status).toBe(201);
    const pid = created.body.project.id;
    expect(created.body.project.name).toBe("Plant A");
    expect((await alice.json<J>("PATCH", `/api/projects/${pid}`, { name: "Plant B" })).body.project.name).toBe("Plant B");
    const list = await alice.json<J>("GET", "/api/projects");
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].documentCount).toBe(0);
    expect((await alice.json("DELETE", `/api/projects/${pid}`)).status).toBe(200);
    expect((await alice.json("GET", `/api/projects/${pid}`)).status).toBe(404);
  });

  it("requires a name", async () => {
    expect((await alice.json("POST", "/api/projects", { name: " " })).status).toBe(400);
  });

  it("creates the bundled sample with a committed T-Box and a parsed manual", async () => {
    const res = await alice.json<J>("POST", "/api/projects/sample");
    expect(res.status).toBe(201);
    const pid = res.body.project.id;
    expect(res.body.project.currentRevisionId).toBeTruthy();
    const docs = await alice.json<J>("GET", `/api/projects/${pid}/documents`);
    expect(docs.body.documents).toHaveLength(1);
    expect(docs.body.documents[0].parseState).toBe("parsed");
    expect(docs.body.documents[0].chunkCount).toBeGreaterThan(1);
  });
});

describe("documents", () => {
  it("keeps successful uploads when another file fails", async () => {
    const pid = await projectWithOntology();
    const ok = await alice.upload(`/api/projects/${pid}/documents`, "a.txt", "Sensor B1 detects the workpiece.");
    const bad = await alice.upload(`/api/projects/${pid}/documents`, "evil.exe", Buffer.from([0x4d, 0x5a, 0, 0]));
    const broken = await alice.upload(`/api/projects/${pid}/documents`, "broken.pdf", Buffer.from("%PDF-1.4 not really a pdf"));
    expect(ok.status).toBe(201);
    expect(bad.status).toBe(415);
    expect(broken.status).toBe(201);
    expect((broken.body.document as J).parseState).toBe("failed");
    const docs = await alice.json<J>("GET", `/api/projects/${pid}/documents`);
    expect(docs.body.documents.map((d: J) => d.parseState).sort()).toEqual(["failed", "parsed"]);
  });

  it("refuses duplicates and exposes chunk offsets", async () => {
    const pid = await projectWithOntology();
    const up = await alice.upload(`/api/projects/${pid}/documents`, "manual.txt", MANUAL);
    expect(up.status).toBe(201);
    const dup = await alice.upload(`/api/projects/${pid}/documents`, "copy.txt", MANUAL);
    expect(dup.status).toBe(409);
    const did = (up.body.document as J).id;
    const text = await alice.json<J>("GET", `/api/projects/${pid}/documents/${did}/text`);
    for (const c of text.body.chunks) expect(c.end).toBeGreaterThan(c.start);
    expect(text.body.chunks[0].start).toBe(0);
  });

  it("enforces the per-file size limit", async () => {
    const pid = await projectWithOntology();
    const big = Buffer.alloc(21 * 1024 * 1024, 97);
    const res = await alice.upload(`/api/projects/${pid}/documents`, "big.txt", big);
    expect(res.status).toBe(413);
  });
});

describe("extraction runs", () => {
  async function setupRun(mode: "automatic" | "interactive" = "automatic") {
    const pid = await projectWithOntology();
    const up = await alice.upload(`/api/projects/${pid}/documents`, "manual.txt", MANUAL);
    const did = (up.body.document as J).id as string;
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: [did], mode, provider: "mock", model: "mock-1" });
    expect(run.status).toBe(201);
    return { pid, did, runId: run.body.run.id as string, steps: run.body.run.steps as J[] };
  }

  it("runs to a reviewable draft with verified evidence", async () => {
    const { pid, runId, steps } = await setupRun();
    expect(steps.length).toBeGreaterThan(2);
    const done = await driveRun(alice, pid, runId);
    expect(done.status).toBe("ready_for_review");
    const rev = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`);
    expect(rev.body.revision.status).toBe("draft");
    const inds = rev.body.revision.content.abox.individuals as J[];
    expect(inds.length).toBeGreaterThan(2);
    // entities found in several chunks are merged by id, not duplicated
    expect(new Set(inds.map((i) => i.id)).size).toBe(inds.length);
    const ev = inds.flatMap((i) => i.evidence ?? []);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e: J) => e.status === "verified" && typeof e.start === "number" && e.documentId)).toBe(true);
  });

  it("allows only one active run per project", async () => {
    const { pid, did } = await setupRun();
    const second = await alice.json("POST", `/api/projects/${pid}/runs`, { documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    expect(second.status).toBe(409);
  });

  it("does not duplicate results when a step is repeated or requested concurrently", async () => {
    const { pid, runId } = await setupRun();
    // three tabs hammering advance at once
    const results = await Promise.all([0, 1, 2].map(() => alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/advance`)));
    expect(results.filter((r) => r.body.waitMs).length).toBeGreaterThanOrEqual(2);
    const done = await driveRun(alice, pid, runId);
    expect(done.status).toBe("ready_for_review");
    expect(done.completedSteps).toBe((done.steps as unknown[]).length);
  });

  it("resumes an interrupted run once its lease expires", async () => {
    const { pid, runId } = await setupRun();
    await alice.json("POST", `/api/projects/${pid}/runs/${runId}/advance`);
    // simulate a tab that died while holding the lease: take it by hand
    const { createLocalStore } = await import("../server/store/local.ts");
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    await store.runs.acquireLease(pid, runId, "dead-tab", 60_000, app.clock.now);
    const blocked = await alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/advance`);
    expect(blocked.body.waitMs).toBeGreaterThan(0);
    expect(blocked.body.run.resumable).toBe(false);
    app.clock.now = new Date(app.clock.now.getTime() + 120_000);
    const view = await alice.json<J>("GET", `/api/projects/${pid}/runs/${runId}`);
    expect(view.body.run.resumable).toBe(true);
    const done = await driveRun(alice, pid, runId);
    expect(done.status).toBe("ready_for_review");
  });

  it("cancels, refuses to advance a cancelled run, and retries from checkpoints", async () => {
    const { pid, runId } = await setupRun();
    await alice.json("POST", `/api/projects/${pid}/runs/${runId}/advance`);
    const cancelled = await alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/cancel`);
    expect(cancelled.body.run.status).toBe("cancelled");
    const after = await alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/advance`);
    expect(after.body.run.status).toBe("cancelled");
    expect(after.body.run.completedSteps).toBe(1);
    const retried = await alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/retry`);
    expect(retried.body.run.status).toBe("running");
    expect(retried.body.run.completedSteps).toBe(1);
    expect((await driveRun(alice, pid, runId)).status).toBe("ready_for_review");
  });

  it("asks clarifying questions in interactive mode and continues with the answers", async () => {
    const { pid, runId } = await setupRun("interactive");
    const waiting = await driveRun(alice, pid, runId);
    expect(waiting.status).toBe("awaiting_answers");
    const questions = waiting.questions as J[];
    expect(questions.length).toBeGreaterThan(0);
    const answered = await alice.json<J>("POST", `/api/projects/${pid}/runs/${runId}/answers`, { answers: { [questions[0].id]: "Distributing station" } });
    expect(answered.body.run.status).toBe("running");
    const done = await driveRun(alice, pid, runId);
    expect(done.status).toBe("ready_for_review");
    expect(done.clarifications).toHaveLength(1);
  });

  it("fails a run whose pinned document was removed", async () => {
    const pid = await projectWithOntology();
    const a = await alice.upload(`/api/projects/${pid}/documents`, "a.txt", "The station has a sensor.");
    const did = (a.body.document as J).id;
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    // removal is refused while the run is active
    expect((await alice.json("DELETE", `/api/projects/${pid}/documents/${did}`)).status).toBe(409);
    await alice.json("POST", `/api/projects/${pid}/runs/${run.body.run.id}/cancel`);
    expect((await alice.json("DELETE", `/api/projects/${pid}/documents/${did}`)).status).toBe(200);
    await alice.json("POST", `/api/projects/${pid}/runs/${run.body.run.id}/retry`);
    const done = await driveRun(alice, pid, run.body.run.id);
    expect(done.status).toBe("failed");
    expect(String(done.error)).toMatch(/removed/);
  });
});

describe("revisions, validation and export", () => {
  async function reviewedDraft() {
    const pid = await projectWithOntology();
    const up = await alice.upload(`/api/projects/${pid}/documents`, "manual.txt", MANUAL);
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: [(up.body.document as J).id], mode: "automatic", provider: "mock", model: "mock-1" });
    const done = await driveRun(alice, pid, run.body.run.id);
    return { pid, draftId: done.resultRevisionId as string };
  }

  it("commits a reviewed draft and numbers revisions", async () => {
    const { pid, draftId } = await reviewedDraft();
    const c = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${draftId}/commit`, { acknowledgedWarnings: true });
    expect(c.body.revision.number).toBe(2);
    expect((await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(draftId);
    // committed revisions are immutable
    const put = await alice.json("PUT", `/api/projects/${pid}/revisions/${draftId}`, { content: { modules: [], abox: null, baseIri: "" } });
    expect(put.status).toBe(409);
  });

  it("detects a stale draft and allows an explicit rebase", async () => {
    const { pid, draftId } = await reviewedDraft();
    const current = (await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId;
    const other = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${current}`);
    const competing = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: other.body.revision.content, summary: "manual" });
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${competing.body.revision.id}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
    const stale = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${draftId}/commit`, { acknowledgedWarnings: true });
    expect(stale.status).toBe(409);
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${draftId}/rebase`)).status).toBe(200);
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${draftId}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
  });

  it("restores an old revision as a new one", async () => {
    const { pid, draftId } = await reviewedDraft();
    const first = (await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId;
    await alice.json("POST", `/api/projects/${pid}/revisions/${draftId}/commit`, { acknowledgedWarnings: true });
    const restored = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${first}/restore`);
    expect(restored.body.revision.number).toBe(3);
    expect(restored.body.revision.source).toBe("restore");
    const rev = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${restored.body.revision.id}`);
    expect(rev.body.revision.content.abox).toBeNull();
  });

  it("ties validation reports to the revision content and marks them stale", async () => {
    const { pid, draftId } = await reviewedDraft();
    const v = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${draftId}/validate`, {
      queries: [{ question: "all types", sparql: "SELECT ?s ?t WHERE { ?s a ?t } LIMIT 5" }],
    });
    expect(v.status).toBe(200);
    expect(v.body.report.stale).toBe(false);
    expect(v.body.report.cqResults[0].rows.length).toBeGreaterThan(0);
    const rev = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draftId}`);
    const content = rev.body.revision.content;
    content.abox.individuals = content.abox.individuals.slice(1);
    await alice.json("PUT", `/api/projects/${pid}/revisions/${draftId}`, { content });
    const again = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draftId}/report`);
    expect(again.body.report.stale).toBe(true);
  });

  it("marks reports from an older validator outdated until checks are rerun", async () => {
    const { pid, draftId } = await reviewedDraft();
    const route = `/api/projects/${pid}/revisions/${draftId}`;
    const first = await alice.json<J>("POST", `${route}/validate`, {});
    expect(first.body.report.validatorVersion).toBeDefined();
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    const old = (await store.reports.latest(pid, draftId))!;
    delete old.validatorVersion;
    await store.reports.put(old);
    expect((await alice.json<J>("GET", `${route}/report`)).body.report.stale).toBe(true);
    await alice.json("POST", `${route}/validate`, {});
    expect((await alice.json<J>("GET", `${route}/report`)).body.report.stale).toBe(false);
  });

  it("only runs read-only SELECT/ASK queries", async () => {
    const { pid, draftId } = await reviewedDraft();
    const run = (sparql: string) => alice.json<J>("POST", `/api/projects/${pid}/revisions/${draftId}/sparql`, { sparql });
    expect((await run("ASK { ?s ?p ?o }")).status).toBe(200);
    expect((await run("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).status).toBe(400);
    expect((await run("INSERT DATA { <a:b> <a:c> <a:d> }")).status).toBe(400);
    expect((await run("SELECT * WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }")).status).toBe(400);
    expect((await run("SELECT * FROM <http://example.org/g> WHERE { ?s ?p ?o }")).status).toBe(400);
  });

  it("requires an acknowledgment to export a revision with errors", async () => {
    const { pid, draftId } = await reviewedDraft();
    const rev = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draftId}`);
    const content = rev.body.revision.content;
    content.abox.individuals.push({ id: "x", classUri: "http://nowhere.example/NotAClass" });
    await alice.json("PUT", `/api/projects/${pid}/revisions/${draftId}`, { content });
    expect((await alice.get(`/api/projects/${pid}/revisions/${draftId}/export?scope=combined`)).status).toBe(409);
    const ok = await alice.get(`/api/projects/${pid}/revisions/${draftId}/export?scope=combined&ack=1`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("owl:Class");
  });

  it("round-trips a project through the archive", async () => {
    const { pid, draftId } = await reviewedDraft();
    await alice.json("POST", `/api/projects/${pid}/revisions/${draftId}/commit`, { acknowledgedWarnings: true });
    const res = await alice.get(`/api/projects/${pid}/archive`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const archive = JSON.parse(gunzipSync(bytes).toString("utf8"));
    expect(archive.format).toBe("ontolab-archive");
    const imported = await bob.upload("/api/projects/import", "x.ontolab.json.gz", bytes);
    expect(imported.status).toBe(201);
    const newPid = (imported.body.project as J).id;
    const revs = await bob.json<J>("GET", `/api/projects/${newPid}/revisions`);
    expect(revs.body.revisions.filter((r: J) => r.status === "committed").map((r: J) => r.number).sort()).toEqual([1, 2]);
    const cur = await bob.json<J>("GET", `/api/projects/${newPid}`);
    const curRev = await bob.json<J>("GET", `/api/projects/${newPid}/revisions/${cur.body.project.currentRevisionId}`);
    const orig = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draftId}`);
    expect(curRev.body.revision.content.abox.individuals.length).toBe(orig.body.revision.content.abox.individuals.length);
    expect((await bob.json<J>("GET", `/api/projects/${newPid}/documents`)).body.documents[0].parseState).toBe("parsed");
  });
});

describe("assistant", () => {
  it("answers questions with resolvable citations and never changes the graph", async () => {
    const res = await alice.json<J>("POST", "/api/projects/sample");
    const pid = res.body.project.id;
    const before = (await alice.json<J>("GET", `/api/projects/${pid}/revisions`)).body.revisions.length;
    const ask = await alice.json<J>("POST", `/api/projects/${pid}/assistant/ask`, { question: "What does the stack magazine do?", provider: "mock", model: "mock-1" });
    expect(ask.status).toBe(200);
    expect(ask.body.message.mode).toBe("ask");
    expect(ask.body.message.citations.length).toBeGreaterThan(0);
    expect(ask.body.message.citations[0].evidence.status).toBe("verified");
    const after = (await alice.json<J>("GET", `/api/projects/${pid}/revisions`)).body.revisions.length;
    expect(after).toBe(before);
  });

  it("proposes changes as a draft that only applies when committed", async () => {
    const res = await alice.json<J>("POST", "/api/projects/sample");
    const pid = res.body.project.id;
    const current = res.body.project.currentRevisionId;
    const prop = await alice.json<J>("POST", `/api/projects/${pid}/assistant/propose`, { instruction: "add a sensor", provider: "mock", model: "mock-1" });
    expect(prop.status).toBe(200);
    const p = prop.body.message.proposal;
    expect(p.diff.individuals.added).toEqual(["mock-added"]);
    expect((await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(current);
    await alice.json("POST", `/api/projects/${pid}/revisions/${p.draftRevisionId}/commit`, { acknowledgedWarnings: true });
    expect((await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(p.draftRevisionId);
  });
});
