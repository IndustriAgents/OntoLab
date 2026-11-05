// The update plan's phases, end to end over HTTP with the mock model:
//   1 from my documents — templates, requirements → CQs, induction, review aids
//   2 incremental graph — runs merge into the graph, the improvement loop
//   3 quality           — merge candidates and decisions, the evidence gate
//   4 structure         — HTML/Markdown sections, standard imports
//   5 scale and cost    — estimate, budget, cache, the background worker
//   6 assistant + versions — routed answers, separate T-Box/A-Box versions, migration

import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";
import { createLocalStore } from "../server/store/local.ts";
import { startWorker } from "../server/worker.ts";
import { silentLogger } from "../server/services/context.ts";

const TBOX = await readFile(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
const MANUAL = await readFile(new URL("../samples/distributing-manual.txt", import.meta.url));

let app: TestApp;
let alice: Client;
beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
});
afterEach(async () => app.close());

type J = Record<string, any>;

async function projectWithOntology(): Promise<string> {
  const { body } = await alice.json<J>("POST", "/api/projects", { name: "Plant" });
  const pid = body.project.id as string;
  const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "mechatronic.ttl", turtle: TBOX }], abox: null, baseIri: "" }, source: "import", summary: "T-Box" });
  await alice.json("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`, { acknowledgedWarnings: true });
  return pid;
}

async function upload(pid: string, name: string, text: string | Buffer): Promise<string> {
  const up = await alice.upload(`/api/projects/${pid}/documents`, name, text);
  expect(up.status).toBe(201);
  return (up.body.document as J).id;
}

async function extract(pid: string, documentIds: string[], extra: J = {}): Promise<J> {
  const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds, mode: "automatic", provider: "mock", model: "mock-1", ...extra });
  expect(run.status).toBe(201);
  return driveRun(alice, pid, run.body.run.id);
}

describe("phase 1 — from my documents", () => {
  it("lists templates and starts a project from one, with approved CQs and a committed T-Box", async () => {
    const list = await alice.json<J>("GET", "/api/templates");
    const ids = (list.body.templates as J[]).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["contracts", "clinical-notes", "financial-filings", "hr", "research-papers", "technical-manuals"]));
    const created = await alice.json<J>("POST", "/api/projects/template", { templateId: "contracts" });
    expect(created.status).toBe(201);
    const p = created.body.project;
    expect(p.currentRevisionId).toBeTruthy();
    expect(p.settings.requirements.cqs.every((q: J) => q.status === "approved" && q.source === "template")).toBe(true);
    expect(p.competencyQuestions.length).toBeGreaterThanOrEqual(5);
    expect((await alice.json("POST", "/api/projects/template", { templateId: "../../etc" })).status).toBe(404);
  });

  it("turns user stories into proposed CQs, then approves and translates one", async () => {
    const pid = await projectWithOntology();
    const saved = await alice.json<J>("PUT", `/api/projects/${pid}/requirements`, { stories: ["As an engineer I want to find every sensor of a station so that I can plan maintenance."], cqs: [] });
    expect(saved.status).toBe(200);
    const gen = await alice.json<J>("POST", `/api/projects/${pid}/requirements/generate`, { provider: "mock", model: "mock-1" });
    expect(gen.status).toBe(200);
    const cqs = gen.body.project.settings.requirements.cqs as J[];
    expect(cqs.length).toBeGreaterThan(0);
    expect(cqs[0]).toMatchObject({ status: "proposed", source: "generated", story: 0 });
    // approve: mirrored into competencyQuestions
    const approved = await alice.json<J>("PUT", `/api/projects/${pid}/requirements`, { stories: gen.body.project.settings.requirements.stories, cqs: cqs.map((q) => ({ ...q, status: "approved" })) });
    expect(approved.body.project.competencyQuestions).toEqual(cqs.map((q) => q.text));
    const tr = await alice.json<J>("POST", `/api/projects/${pid}/requirements/${cqs[0].id}/translate`, { provider: "mock", model: "mock-1" });
    expect(tr.status).toBe(200);
    expect(tr.body.project.settings.requirements.cqs[0].sparql).toMatch(/SELECT/);
    expect(tr.body.project.settings.savedQueries.some((s: J) => s.question === cqs[0].text)).toBe(true);
  });

  it("induces an ontology draft from documents alone, with pitfall and reuse review attached", async () => {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Docs only", purpose: "Describe the station." });
    const pid = body.project.id;
    const did = await upload(pid, "manual.txt", MANUAL);
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { kind: "induction", documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    expect(run.status).toBe(201);
    const kinds = (run.body.run.steps as J[]).map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["terms", "merge", "relations", "reuse", "pitfalls", "finalize"]));
    const done = await driveRun(alice, pid, run.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const draft = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    expect(draft.source).toBe("induction");
    expect(draft.content.modules).toHaveLength(1);
    expect(draft.content.modules[0].turtle).toMatch(/owl:Class/);
    expect(draft.content.review.pitfallsBefore).toBeTruthy();
    // committing makes it the project's ontology: no Turtle written by hand
    const commit = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true });
    expect(commit.status).toBe(200);
    const pitfalls = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draft.id}/pitfalls`);
    expect(Array.isArray(pitfalls.body.pitfalls)).toBe(true);
    // and the graph can now be extracted from the same documents
    const ex = await extract(pid, [did]);
    expect(ex.status).toBe("ready_for_review");
  });
});

describe("phase 1 — induction on top of an existing ontology", () => {
  it("adds only new terms and never redeclares existing ones", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The Station has a Sensor. The Sensor reports to the Controller. The Controller drives the Conveyor. The Conveyor moves the Workpiece.");
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { kind: "induction", documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    const done = await driveRun(alice, pid, run.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const draft = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    const induced = draft.content.modules.find((m: J) => m.name.startsWith("induced-")).turtle as string;
    expect(induced).not.toMatch(/[#:]Station\s+a\s+owl:Class|[#:]Sensor\s+a\s+owl:Class|<[^>]*#Station> a <http:\/\/www\.w3\.org\/2002\/07\/owl#Class>/);
    expect(induced).toMatch(/Controller|Conveyor|Workpiece/);
  });
});

describe("phase 2 — incremental graph", () => {
  it("adds documents to the existing graph instead of replacing it, and caches repeated chunks", async () => {
    const pid = await projectWithOntology();
    const a = await upload(pid, "a.txt", "The station has a sensor and a cylinder.");
    const first = await extract(pid, [a]);
    await alice.json("POST", `/api/projects/${pid}/revisions/${first.resultRevisionId}/commit`, { acknowledgedWarnings: true });
    const firstIds = ((await alice.json<J>("GET", `/api/projects/${pid}/revisions/${first.resultRevisionId}`)).body.revision.content.abox.individuals as J[]).map((i) => i.id);
    const b = await upload(pid, "b.txt", "The actuator sends a signal during each operation of the station.");
    const second = await extract(pid, [b]);
    const ids = ((await alice.json<J>("GET", `/api/projects/${pid}/revisions/${second.resultRevisionId}`)).body.revision.content.abox.individuals as J[]).map((i) => i.id);
    for (const id of firstIds) expect(ids).toContain(id);
    expect(ids.length).toBeGreaterThan(firstIds.length);
    // replace mode still exists
    const replaced = await extract(pid, [b], { options: { incremental: false } });
    const only = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${replaced.resultRevisionId}`)).body.revision.content.abox.individuals as J[];
    expect(only.length).toBeLessThan(ids.length);
    // the same chunk with the same T-Box and model is answered from the cache
    expect(replaced.cached).toBeGreaterThan(0);
  });

  it("proposes terms the ontology lacks and commits accepted ones as a T-Box revision", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor. The Conveyor moves workpieces to the Turntable.");
    const done = await extract(pid, [did]);
    expect(done.proposals.length).toBeGreaterThan(0);
    const p = done.proposals[0];
    expect(p).toMatchObject({ status: "open", count: 1 });
    const acc = await alice.json<J>("POST", `/api/projects/${pid}/runs/${done.id}/proposals`, { accept: [p.id] });
    expect(acc.status).toBe(200);
    expect(acc.body.committed).toBe(true);
    const rev = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${acc.body.revision.id}`)).body.revision;
    expect(rev.content.modules.map((m: J) => m.name)).toContain("extensions.ttl");
    expect(rev.scope).toBeUndefined(); // derived only in listings
    const list = (await alice.json<J>("GET", `/api/projects/${pid}/revisions`)).body.revisions as J[];
    expect(list.find((r) => r.id === rev.id).scope).toBe("tbox");
    expect(acc.body.proposals[0].status).toBe("accepted");
  });
});

describe("phase 3 — quality", () => {
  it("lists merge candidates on the draft and applies a decision", async () => {
    const pid = await projectWithOntology();
    const a = await upload(pid, "a.txt", "The station has a sensor.");
    const b = await upload(pid, "b.txt", "Sensor details: the station sensor is inductive.");
    const done = await extract(pid, [a, b]);
    const draft = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    // claims carry an entailment score from the evidence gate
    const ev = (draft.content.abox.individuals as J[]).flatMap((i) => i.evidence ?? []);
    expect(ev.every((e: J) => typeof e.confidence === "number")).toBe(true);
    // fabricate a pending candidate to decide on
    const inds = draft.content.abox.individuals as J[];
    draft.content.resolution = { candidates: [{ id: "mc_test", ids: [inds[0].id, inds[1].id], label: "x", score: 0.8, method: "label", decision: "pending", explanation: "test" }] };
    await alice.json("PUT", `/api/projects/${pid}/revisions/${draft.id}`, { content: draft.content });
    const res = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${draft.id}/merges`, { decisions: [{ id: "mc_test", decision: "merge" }] });
    expect(res.status).toBe(200);
    const after = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draft.id}`)).body.revision.content;
    expect(after.abox.individuals.length).toBe(inds.length - 1);
    expect(after.abox.individuals.find((i: J) => i.id === inds[0].id).mergedFrom).toEqual([inds[1].id]);
    expect(after.resolution.candidates).toHaveLength(0);
  });
});

describe("phase 4 — structure and standards", () => {
  it("keeps headings of HTML and Markdown documents as chunk section paths", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "page.html", "<h1>Station</h1><p>The station has a sensor.</p><h2>Magazine</h2><table><tr><th>Part</th></tr><tr><td>Cylinder</td></tr></table>");
    const text = await alice.json<J>("GET", `/api/projects/${pid}/documents/${did}/text`);
    expect(text.body.sections.map((s: J) => s.title)).toEqual(["Station", "Magazine"]);
    expect(text.body.tables).toHaveLength(1);
    const doc = (await alice.json<J>("GET", `/api/projects/${pid}/documents`)).body.documents[0];
    expect(doc).toMatchObject({ kind: "html", parser: "node", sectionCount: 2, tableCount: 1 });
    expect(text.body.chunks[0].sectionPath).toEqual(["Station"]);
    // PPTX needs the Docling sidecar
    const pptx = await alice.upload(`/api/projects/${pid}/documents`, "deck.pptx", Buffer.from("PK\u0003\u0004rest"));
    expect(pptx.status).toBe(415);
  });

  it("converts an RDF/XML standard to Turtle", async () => {
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="http://ex.org/std#Thing"/></rdf:RDF>`;
    const res = await alice.json<J>("POST", "/api/convert-rdf", { name: "std.owl", text: xml });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("rdfxml");
    expect(res.body.turtle).toContain("http://ex.org/std#Thing");
  });
});

describe("phase 5 — scale and cost", () => {
  it("estimates a run before it starts and enforces the project budget", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "manual.txt", MANUAL);
    const est = await alice.json<J>("POST", `/api/projects/${pid}/runs/estimate`, { documentIds: [did], provider: "mock", model: "mock-1" });
    expect(est.status).toBe(200);
    expect(est.body.estimate).toMatchObject({ priced: true, usd: 0 });
    expect(est.body.estimate.modelCalls).toBeGreaterThan(0);
    await alice.json("PATCH", `/api/projects/${pid}`, { settings: { budget: { maxUsdTotal: 0 } } });
    const refused = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/budget/);
  });

  it("advances runs on the server without a browser", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor and a cylinder.");
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    const worker = startWorker(createLocalStore(app.dataDir), silentLogger, { autoStart: false, now: () => app.clock.now })!;
    expect(await worker.tick()).toBe(1);
    await worker.stop();
    const view = await alice.json<J>("GET", `/api/projects/${pid}/runs/${run.body.run.id}`);
    expect(view.body.run.status).toBe("ready_for_review");
  });
});

describe("phase 6 — assistant and versioning", () => {
  it("routes an aggregate question to Text2SPARQL and reports the query", async () => {
    const res = await alice.json<J>("POST", "/api/projects/sample");
    const pid = res.body.project.id;
    const docs = (await alice.json<J>("GET", `/api/projects/${pid}/documents`)).body.documents;
    const done = await extract(pid, docs.map((d: J) => d.id));
    await alice.json("POST", `/api/projects/${pid}/revisions/${done.resultRevisionId}/commit`, { acknowledgedWarnings: true });
    const ask = await alice.json<J>("POST", `/api/projects/${pid}/assistant/ask`, { question: "How many sensors are there?", provider: "mock", model: "mock-1" });
    expect(ask.status).toBe(200);
    expect(ask.body.message.route).toBe("aggregate");
    expect(ask.body.message.query.sparql).toMatch(/SELECT/);
    expect(ask.body.message.query.rows.length).toBeGreaterThan(0);
    const single = await alice.json<J>("POST", `/api/projects/${pid}/assistant/ask`, { question: "What does the stack magazine do?", provider: "mock", model: "mock-1" });
    expect(single.body.message.route).toBe("single");
  });

  it("migrates individuals when a T-Box term is renamed and versions the halves separately", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor and a cylinder.");
    const done = await extract(pid, [did]);
    const commit = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${done.resultRevisionId}/commit`, { acknowledgedWarnings: true });
    expect(commit.body.report).toBeTruthy(); // validation runs on every commit
    const cur = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    const sensor = (cur.content.abox.individuals as J[]).find((i) => /Sensor$/.test(i.classUri));
    expect(sensor).toBeTruthy();
    const renamed = cur.content.modules.map((m: J) => ({ ...m, turtle: m.turtle.replace(/(:|#)Sensor\b/g, "$1Detector") }));
    const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { ...cur.content, modules: renamed }, source: "ontology", summary: "rename" });
    const d = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${draft.body.revision.id}`)).body.revision;
    expect(d.content.migration.renamed[0].to).toMatch(/Detector$/);
    expect((d.content.abox.individuals as J[]).find((i) => i.id === sensor.id).classUri).toMatch(/Detector$/);
    await alice.json("POST", `/api/projects/${pid}/revisions/${d.id}/commit`, { acknowledgedWarnings: true });
    const list = (await alice.json<J>("GET", `/api/projects/${pid}/revisions`)).body.revisions as J[];
    const byNumber = list.filter((r) => r.status === "committed").sort((a, b) => a.number - b.number);
    expect(byNumber.map((r) => r.tboxVersion)).toEqual([1, 1, 2]);
    expect(byNumber.map((r) => r.aboxVersion)).toEqual([null, 1, 2]);
  });
});
