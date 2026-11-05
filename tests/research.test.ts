// Research-testbed features: recorded run configurations, ablation switches,
// reasoning in validation, CQ answerability, per-fact review and the T-Box
// feedback loop. Everything runs offline against the mock provider.
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";
import { validateOntology } from "../src/lib/ontology/validate.ts";

const TBOX = await readFile(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");

let app: TestApp;
let alice: Client;
beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
});
afterEach(async () => app.close());

type J = Record<string, any>;

async function projectWithOntology(turtle = TBOX): Promise<string> {
  const { body } = await alice.json<J>("POST", "/api/projects", { name: "Plant" });
  const pid = body.project.id as string;
  const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "core.ttl", turtle }], abox: null, baseIri: "" }, source: "import", summary: "T-Box" });
  await alice.json("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`, { acknowledgedWarnings: true });
  return pid;
}

async function upload(pid: string, name: string, text: string): Promise<string> {
  const up = await alice.upload(`/api/projects/${pid}/documents`, name, text);
  expect(up.status).toBe(201);
  return (up.body.document as J).id;
}

async function extract(pid: string, documentIds: string[], options: J = {}): Promise<J> {
  const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds, mode: "automatic", provider: "mock", model: "mock-1", options });
  expect(run.status).toBe(201);
  return driveRun(alice, pid, run.body.run.id);
}

describe("run configurations and ablation switches", () => {
  it("freezes the configuration on the run and keeps cached results of different settings apart", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor and a cylinder.");
    const quiet = { relevanceScreen: false, resolveEntities: false, verifyEvidence: false };

    const first = await extract(pid, [did], quiet);
    expect(first.status).toBe("ready_for_review");
    expect(first.config).toMatchObject({ schemaRetrieval: "auto", embedder: expect.any(String) });
    expect(first.config.promptVersion).toBeTruthy();

    const again = await extract(pid, [did], quiet);
    expect(again.cached).toBeGreaterThan(0);

    const tree = await extract(pid, [did], { ...quiet, promptStyle: "tree", schemaRetrieval: "off" });
    expect(tree.config).toMatchObject({ promptStyle: "tree", schemaRetrieval: "off" });
    expect(tree.options).toMatchObject({ promptStyle: "tree", schemaRetrieval: "off" });
    expect(tree.cached ?? 0).toBe(0);
  });

  it("ignores ablation values it does not know", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor.");
    const run = await extract(pid, [did], { promptStyle: "yaml", schemaRetrieval: "sometimes", schemaTopK: -3 });
    expect(run.options.promptStyle).toBeUndefined();
    expect(run.options.schemaRetrieval).toBeUndefined();
    expect(run.options.schemaTopK).toBeUndefined();
  });
});

const PRE = `@prefix : <http://ex/r#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`;
const R = (n: string) => `http://ex/r#${n}`;
const ACADEMIA = `${PRE}
  :Person a owl:Class ; owl:disjointWith :Organization .
  :Organization a owl:Class .
  :University rdfs:subClassOf :Organization .
  :Researcher rdfs:subClassOf :Person .
  :worksAt a owl:ObjectProperty ; rdfs:domain :Person ; rdfs:range :Organization .`;

describe("reasoning in T-Box change validation", () => {
  const base = [{ id: "m1", name: "academia.ttl", turtle: ACADEMIA }];

  it("blocks a change that makes a class unsatisfiable, and explains why", () => {
    const report = validateOntology(base, { name: "bad.ttl", turtle: `${PRE} :Researcher rdfs:subClassOf :University .` });
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.code === "unsatisfiable-class")!;
    expect(issue.severity).toBe("error");
    expect(issue.subject).toBe(R("Researcher"));
    expect(issue.explanation?.some((l) => l.includes("bad.ttl"))).toBe(true);
    expect(issue.explanation?.some((l) => l.includes("disjoint"))).toBe(true);
    expect(report.reasoning?.newlyUnsat).toEqual([R("Researcher")]);
  });

  it("warns when a change alters what holds between existing terms, but not for new terms", () => {
    const report = validateOntology(base, {
      name: "change.ttl",
      turtle: `${PRE} :PhDStudent rdfs:subClassOf :Researcher . :Lab rdfs:subClassOf :Organization . :University rdfs:subClassOf :Lab .`,
    });
    expect(report.ok).toBe(true);
    const changed = report.issues.filter((i) => i.code === "entailment-changed");
    // University ⊑ Lab: Lab is new, so nothing between EXISTING terms changed
    expect(changed).toEqual([]);
    const shifted = validateOntology(base, { name: "shift.ttl", turtle: `${PRE} :Researcher rdfs:subClassOf :Organization .` });
    expect(shifted.ok).toBe(false); // Researcher is now under Person and Organization
    const regrouped = validateOntology([{ id: "m1", name: "academia.ttl", turtle: `${PRE} :A a owl:Class . :B a owl:Class . :C rdfs:subClassOf :A .` }], {
      name: "x.ttl",
      turtle: `${PRE} :A rdfs:subClassOf :B .`,
    });
    expect(regrouped.issues.filter((i) => i.code === "entailment-changed").map((i) => i.message)).toEqual([
      expect.stringMatching(/^A now is a subclass of B/),
      expect.stringMatching(/^C now is a subclass of B/),
    ]);
  });

  it("can be turned off", () => {
    const report = validateOntology(base, { name: "bad.ttl", turtle: `${PRE} :Researcher rdfs:subClassOf :University .` }, { reason: false });
    expect(report.reasoning).toBeUndefined();
    expect(report.issues.some((i) => i.code === "unsatisfiable-class")).toBe(false);
  });
});

describe("reasoning in revision validation", () => {
  it("reports an inconsistency that only exists through inference, once, with its explanation", async () => {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Uni" });
    const pid = body.project.id as string;
    const abox = {
      individuals: [
        { id: "sarah", classUri: R("Researcher"), objectProperties: [{ propUri: R("worksAt"), targetId: "oxford" }] },
        // asserted a Person, inferred an Organization through the range of worksAt
        { id: "oxford", classUri: R("Person") },
      ],
    };
    const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "academia.ttl", turtle: ACADEMIA }], abox, baseIri: "http://ex/data#" }, source: "import", summary: "x" });
    const rid = draft.body.revision.id as string;
    const res = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/validate`, { queries: [] });
    expect(res.status).toBe(200);
    const report = res.body.report;
    expect(report.reasoner).toMatchObject({ tier: "rl", consistent: false, clashes: 1 });
    expect(report.reasonerIssues).toHaveLength(1);
    expect(report.reasonerIssues[0]).toMatchObject({ code: "inconsistent", id: "oxford", severity: "error" });
    expect(report.reasonerIssues[0].explanation.join(" | ")).toMatch(/range\(worksAt\) = Organization/);
    // the hand validator's range warning for the same link stays (closed-world data quality), the disjointness is not restated
    expect(report.schemaIssues.filter((i: J) => i.code === "disjoint")).toHaveLength(0);
    expect(report.counts.errors).toBeGreaterThanOrEqual(1);

    const md = await alice.get(`/api/projects/${pid}/revisions/${rid}/report/download?format=md`);
    expect(await md.text()).toMatch(/## Reasoning[\s\S]*Inconsistent/);
  });
});

describe("competency-question answerability", () => {
  async function academia(): Promise<string> {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Uni" });
    const pid = body.project.id as string;
    const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "academia.ttl", turtle: ACADEMIA }], abox: null, baseIri: "" }, source: "import", summary: "T-Box" });
    await alice.json("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`, { acknowledgedWarnings: true });
    return pid;
  }
  const cq = (id: string, text: string, extra: J = {}) => ({ id, text, status: "approved", source: "user", ...extra });

  it("separates schema-answerable questions from ones the ontology lacks terms for", async () => {
    const pid = await academia();
    await alice.json("PUT", `/api/projects/${pid}/requirements`, {
      stories: [],
      cqs: [cq("q1", "Which researchers work at a university?"), cq("q2", "Which funders support each university?")],
    });
    const res = await alice.json<J>("POST", `/api/projects/${pid}/requirements/answerability`, { provider: "mock", model: "mock-1" });
    expect(res.status).toBe(200);
    const [q1, q2] = res.body.project.settings.requirements.cqs;
    expect(q1.answerability).toMatchObject({ schema: "answerable", missing: [], data: "untested" });
    expect(q1.answerability.path).toEqual(expect.arrayContaining([R("Researcher"), R("University")]));
    expect(q2.answerability).toMatchObject({ schema: "partial", missing: ["funder"] });

    // editing a question drops its analysis
    const edited = await alice.json<J>("PUT", `/api/projects/${pid}/requirements`, { ...res.body.project.settings.requirements, cqs: [{ ...q1, text: "Which researchers work where?" }, q2] });
    expect(edited.body.project.settings.requirements.cqs[0].answerability).toBeUndefined();
    expect(edited.body.project.settings.requirements.cqs[1].answerability.schema).toBe("partial");
  });

  it("generates questions from the ontology's own structure, answerable by construction", async () => {
    const pid = await academia();
    const res = await alice.json<J>("POST", `/api/projects/${pid}/requirements/generate-from-tbox`, { provider: "mock", model: "mock-1" });
    expect(res.status).toBe(200);
    const generated = res.body.project.settings.requirements.cqs.filter((q: J) => q.source === "tbox");
    expect(generated.length).toBeGreaterThan(0);
    expect(generated[0]).toMatchObject({ status: "proposed", answerability: { schema: "answerable" } });
  });

  it("flags stored queries that use terms the ontology no longer has, and re-translates them on request", async () => {
    const pid = await academia();
    const stale = `PREFIX r: <http://ex/r#> SELECT ?x WHERE { ?x r:memberOf ?o }`;
    await alice.json("PUT", `/api/projects/${pid}/requirements`, { stories: [], cqs: [cq("q1", "Who is a member of what?", { sparql: stale })] });
    const check = await alice.json<J>("POST", `/api/projects/${pid}/requirements/retranslate-stale`, {});
    expect(check.body.stale).toEqual(["Who is a member of what?"]);
    const fixed = await alice.json<J>("POST", `/api/projects/${pid}/requirements/retranslate-stale`, { provider: "mock", model: "mock-1" });
    expect(fixed.body).toMatchObject({ translated: 1, stale: [] });
    expect(fixed.body.project.settings.requirements.cqs[0].sparqlTboxHash).toBeTruthy();
  });
});

describe("induction: grounding, axioms and the repair loop", () => {
  const TEXT =
    "Every Machine has a Sensor. A Sensor is a Device and a Controller is a Device. The Controller reads the Sensor. The Machine has a Controller. Each Device has a serial number.";

  it("records where each term came from and keeps only reasoner-safe axioms", async () => {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Plant", purpose: "Describe machines." });
    const pid = body.project.id as string;
    const did = await upload(pid, "m.txt", TEXT);
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, { kind: "induction", documentIds: [did], mode: "automatic", provider: "mock", model: "mock-1" });
    expect((run.body.run.steps as J[]).map((s) => s.kind)).toContain("axioms");
    const done = await driveRun(alice, pid, run.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const draft = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    const ev = draft.content.review.termEvidence as J[];
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.kind === "class").every((e) => e.located && e.documentId === did)).toBe(true);
    expect(draft.content.review.axioms.accepted.length).toBeGreaterThan(0);
    expect(draft.content.modules[0].turtle).toMatch(/disjointWith|AllDisjointClasses/);
    expect(done.notes.join(" ")).toMatch(/proposed axioms kept/);
  });

  it("switches stages off for ablation studies", async () => {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Plant" });
    const pid = body.project.id as string;
    const did = await upload(pid, "m.txt", TEXT);
    const run = await alice.json<J>("POST", `/api/projects/${pid}/runs`, {
      kind: "induction",
      documentIds: [did],
      mode: "automatic",
      provider: "mock",
      model: "mock-1",
      options: { inductionAxioms: false, repair: false, cqGuided: false, strictGrounding: true },
    });
    expect((run.body.run.steps as J[]).map((s) => s.kind)).not.toContain("axioms");
    expect(run.body.run.options).toMatchObject({ inductionAxioms: false, repair: false, cqGuided: false, strictGrounding: true });
    const done = await driveRun(alice, pid, run.body.run.id);
    expect(done.status).toBe("ready_for_review");
    expect(done.notes.join(" ")).toMatch(/after 0 rounds/);
  });
});

describe("semantic review", () => {
  it("stores advisory findings per content hash", async () => {
    const pid = await projectWithOntology(ACADEMIA);
    const rid = (await alice.json<J>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId as string;
    expect((await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}/semantic-review`)).body.findings).toBeNull();
    const res = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/semantic-review`, { provider: "mock", model: "mock-1" });
    expect(res.status).toBe(200);
    expect(res.body.findings[0]).toMatchObject({ kind: "hierarchy", severity: "minor", status: "open" });
    expect(res.body.findings[0].subject).toMatch(/^http:\/\/ex\/r#/);
    expect((await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}/semantic-review`)).body.findings).toHaveLength(1);
  });
});

describe("change-aware extension", () => {
  it("classifies proposals and analyses the impact before committing them", async () => {
    const pid = await projectWithOntology();
    await alice.json("PATCH", `/api/projects/${pid}`, { settings: { savedQueries: [{ question: "What is there?", sparql: "SELECT ?s WHERE { ?s a ?t } LIMIT 5" }] } });
    const did = await upload(pid, "a.txt", "The station has a sensor. The Conveyor moves workpieces to the Turntable.");
    const done = await extract(pid, [did]);
    expect(done.proposals.length).toBeGreaterThan(0);
    expect(["new", "synonym", "specialization", "conflict"]).toContain(done.proposals[0].relation);
    const acc = await alice.json<J>("POST", `/api/projects/${pid}/runs/${done.id}/proposals`, { accept: [done.proposals[0].id] });
    expect(acc.status).toBe(200);
    expect(acc.body.impact).toMatchObject({ ok: true, cq: { checked: 1, regressions: [] }, newlyUnsat: [] });
    expect(acc.body.committed).toBe(true);
    const rev = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${acc.body.revision.id}`)).body.revision;
    expect(rev.content.impact.changes.length).toBeGreaterThan(0);
  });
});

describe("per-fact review", () => {
  it("reviews new facts at the end of a run, and rejected facts leave the graph", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor and a cylinder. The sensor monitors the cylinder.");
    const done = await extract(pid, [did], { resolveEntities: false });
    expect(done.notes.join(" ")).toMatch(/new facts?: \d+ trusted automatically, \d+ waiting for review/);
    expect(done.config.evidenceGate).toBe("auto-accept");
    const rid = done.resultRevisionId as string;

    const all = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}/facts?status=all`);
    expect(all.status).toBe(200);
    const facts = all.body.facts as J[];
    expect(facts.length).toBeGreaterThan(0);
    expect(all.body.counts.accepted + all.body.counts.candidate).toBe(facts.length);

    // reject one individual's type: it leaves the export (the run's draft is edited in place)
    const target = facts.find((f) => f.kind === "type")!;
    const res = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/facts/review`, { decisions: [{ key: target.key, status: "rejected", reason: "wrong" }] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.revision.id).toBe(rid);
    const after = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}/facts?status=rejected`);
    expect(after.body.facts.map((f: J) => f.key)).toEqual([target.key]);
    const exp = await alice.get(`/api/projects/${pid}/revisions/${rid}/export?scope=abox&ack=1`);
    const turtle = await exp.text();
    expect(turtle).not.toMatch(new RegExp(`[:#/]${target.individualId}\b`));

    // with "accepted-only", a commit with open candidates asks first
    await alice.json("PATCH", `/api/projects/${pid}`, { settings: { reviewPolicy: "accepted-only" } });
    const open = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}/facts`)).body.counts.candidate as number;
    const commit = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/commit`, {});
    if (open) {
      expect(commit.status).toBe(409);
      expect(commit.body.error).toMatch(/waiting for review/);
      expect((await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/commit`, { acknowledged: true, acknowledgedWarnings: true })).status).toBe(200);
    } else expect(commit.status).toBe(200);
  });
});

describe("closing the loop: ontology extension feeds back into the graph", () => {
  it("keeps facts the ontology could not express, replays them once the term exists, and re-extracts only their chunks", async () => {
    const pid = await projectWithOntology();
    const did = await upload(pid, "a.txt", "The station has a sensor. The Conveyor moves workpieces to the Turntable.");
    const done = await extract(pid, [did], { resolveEntities: false });
    expect(done.pendingFacts?.length).toBeGreaterThan(0);
    const p = done.proposals.find((x: J) => x.pendingFactIds?.length);
    expect(p).toBeTruthy();
    expect(p.chunkIds?.length).toBeGreaterThan(0);

    const acc = await alice.json<J>("POST", `/api/projects/${pid}/runs/${done.id}/proposals`, { accept: [p.id] });
    expect(acc.body.committed).toBe(true);
    expect(acc.body.reextract).toMatchObject({ pendingFacts: p.pendingFactIds.length, documentIds: [did] });

    const replay = await alice.json<J>("POST", `/api/projects/${pid}/runs/${done.id}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBeGreaterThan(0);
    const rev = (await alice.json<J>("GET", `/api/projects/${pid}/revisions/${replay.body.revision.id}`)).body.revision;
    const fact = done.pendingFacts.find((f: J) => p.pendingFactIds.includes(f.id));
    const ind = rev.content.abox.individuals.find((i: J) => i.id === fact.subjectId);
    expect(ind.classUri).toMatch(new RegExp(`${p.name}$`));
    expect(ind.review).toMatchObject({ status: "candidate", by: "auto" });
    expect(ind.evidence[0]).toMatchObject({ status: "verified", documentId: did });

    const again = await alice.json<J>("POST", `/api/projects/${pid}/runs`, {
      documentIds: acc.body.reextract.documentIds,
      mode: "automatic",
      provider: "mock",
      model: "mock-1",
      options: { onlyChunks: acc.body.reextract.chunkIds },
    });
    expect(again.status).toBe(201);
    const chunkSteps = (again.body.run.steps as J[]).filter((s) => s.kind === "chunk");
    expect(chunkSteps.map((s) => s.chunkId).sort()).toEqual([...acc.body.reextract.chunkIds].sort());
  });
});
