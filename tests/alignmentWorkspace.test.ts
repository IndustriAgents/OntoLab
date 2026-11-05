import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "n3";
import { startApp, type TestApp, type Client } from "./helpers";
import type { OntologyRevision, RevisionWithContent } from "../src/types/project";
import type { AlignmentReviewInput, AlignmentSetup } from "../src/types/alignment";

const ontology = (namespace: string) => `@prefix : <${namespace}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Device a owl:Class; rdfs:label "Device" .
:Sensor a owl:Class; rdfs:label "Sensor"; rdfs:subClassOf :Device .
:reading a owl:DatatypeProperty; rdfs:domain :Device .
:contains a owl:ObjectProperty; rdfs:domain :Device; rdfs:range :Device .`;
const a = "https://a.example/#",
  b = "https://b.example/#";
const setup: AlignmentSetup = {
  sourceModules: ["a"],
  targetModules: ["b"],
  matchers: { lexical: true, semantic: false, structural: false },
  verify: false,
  maxSource: null,
};
let app: TestApp, client: Client, pid: string, rid: string;
let originalModules: RevisionWithContent["content"]["modules"];
const route = () => `/api/projects/${pid}/revisions/${rid}`;
const read = async () => (await client.json<{ revision: RevisionWithContent }>("GET", route())).body.revision;
const run = async (options = {}) => client.json<{ revision: OntologyRevision }>("POST", `${route()}/align`, { ...setup, ...options });
const decide = async (input: AlignmentReviewInput) => client.json<{ revision: OntologyRevision }>("POST", `${route()}/align/review`, input);
const mapping = (rev: RevisionWithContent, suffix = "Device") => rev.content.review!.alignment!.find((m) => m.source === a + suffix)!;
const bridge = (rev: RevisionWithContent) => new Parser().parse(rev.content.modules.find((m) => m.name === "alignment.ttl")?.turtle ?? "");

beforeEach(async () => {
  app = await startApp();
  client = app.as("alignment-reviewer");
  pid = (
    await client.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Alignment workspace",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  originalModules = [
    { id: "a", name: "a.ttl", turtle: ontology(a) },
    { id: "b", name: "b.ttl", turtle: ontology(b) },
  ];
  rid = (
    await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions`, {
      source: "import",
      summary: "Compare",
      content: { modules: originalModules, abox: null, baseIri: a },
    })
  ).body.revision.id;
});
afterEach(async () => app.close());

describe("persistent alignment workspace", () => {
  it("records the resolved provider default model when older clients omit the model", async () => {
    expect((await run({ provider: "mock" })).status).toBe(200);
    const revision = await read();
    expect(revision.content.review!.alignmentSetup).toMatchObject({ provider: "mock", model: "mock-1", verify: true });
  });

  it("anchors legacy undo snapshots to their original comparison", async () => {
    await run();
    const revision = await read();
    const originalRun = revision.content.review!.alignmentRuns![0].id;
    const id = mapping(revision).id;
    for (const mapping of revision.content.review!.alignment!) delete mapping.runId;
    await client.json("PUT", route(), { content: revision.content });
    await decide({ action: "reject", ids: [id] });
    const decision = (await read()).content.review!.alignmentDecisions!.at(-1)!;
    expect(decision.before?.runId).toBe(originalRun);
    expect(decision.after?.runId).toBe(originalRun);
    await run();
    await decide({ action: "undo", ids: [id] });
    expect(mapping(await read()).runId).toBe(originalRun);
  });

  it("saves setup before matching, validates inputs, and rejects stale clients", async () => {
    const initial = await read();
    const saved = await client.json("POST", `${route()}/align/setup`, {
      setup: { ...setup, verify: true, provider: "mock", model: "mock-1", maxSource: 500 },
      expectedHash: initial.contentHash,
    });
    expect(saved.status).toBe(200);
    const after = await read();
    expect(after.content.review!.alignmentSetup).toMatchObject({ verify: true, maxSource: 500, provider: "mock" });
    expect(after.content.review!.alignmentRuns).toBeUndefined();
    expect(after.content.modules).toEqual(originalModules);
    expect((await client.json("POST", `${route()}/align/setup`, { setup, expectedHash: initial.contentHash })).status).toBe(409);
    for (const invalid of [{ maxSource: -1 }, { maxSource: "all" }, { sourceModules: ["missing"] }, { targetModules: ["a"] }])
      expect((await client.json("POST", `${route()}/align/setup`, { setup: { ...setup, ...invalid } })).status).toBe(400);
    expect((await app.as("other-user").json("POST", `${route()}/align/setup`, { setup })).status).toBeGreaterThanOrEqual(400);
  });

  it("retains accepted, rejected and deferred decisions across reruns without duplicate bridge triples", async () => {
    expect((await run()).status).toBe(200);
    const first = await read();
    const ids = first.content.review!.alignment!.map((m) => m.id);
    expect((await decide({ action: "accept", ids: [mapping(first).id] })).status).toBe(200);
    expect((await decide({ action: "reject", ids: [mapping(first, "Sensor").id], note: "Different scope" })).status).toBe(200);
    expect((await decide({ action: "defer", ids: [mapping(first, "reading").id] })).status).toBe(200);
    expect((await run()).status).toBe(200);
    const again = await read();
    expect(again.content.review!.alignment!.map((m) => m.id).sort()).toEqual(ids.sort());
    expect(mapping(again).status).toBe("accepted");
    expect(mapping(again, "Sensor")).toMatchObject({ status: "dismissed", reviewNote: "Different scope" });
    expect(mapping(again, "reading").status).toBe("deferred");
    expect(
      again.content
        .review!.alignmentRuns!.at(-1)!
        .candidates.map((m) => m.id)
        .sort(),
    ).toEqual(ids.sort());
    expect(bridge(again)).toHaveLength(1);
    expect((await decide({ action: "accept", ids: [mapping(again).id] })).status).toBe(400);
    expect(again.content.modules.filter((m) => m.name !== "alignment.ttl")).toEqual(originalModules);
  });

  it("edits relation direction and undoes decisions while preserving unrelated bridge RDF", async () => {
    await run();
    const initial = await read(),
      id = mapping(initial).id;
    await decide({ action: "accept", ids: [id] });
    const withBridge = await read();
    withBridge.content.modules.find((m) => m.name === "alignment.ttl")!.turtle +=
      `\n<https://manual.example/A> <https://manual.example/p> "retain me" .`;
    await client.json("PUT", route(), { content: withBridge.content });
    await decide({ action: "edit", ids: [id], relation: "broader", note: "Source is more specific" });
    let current = await read();
    expect(mapping(current)).toMatchObject({ relation: "broader", status: "open", humanReviewed: true, verified: false });
    expect(bridge(current)).toHaveLength(1);
    await decide({ action: "accept", ids: [id] });
    current = await read();
    expect(
      bridge(current).some(
        (q) => q.subject.value === a + "Device" && q.predicate.value.endsWith("subClassOf") && q.object.value === b + "Device",
      ),
    ).toBe(true);
    await decide({ action: "reject", ids: [id] });
    expect(bridge(await read())).toHaveLength(1);
    await decide({ action: "undo", ids: [id] });
    current = await read();
    expect(mapping(current).status).toBe("accepted");
    expect(bridge(current)).toHaveLength(2);
    expect(current.content.review!.alignmentDecisions!.at(-1)).toMatchObject({ action: "undo", mappingId: id });
    expect((await decide({ action: "undo", ids: [id] })).status).toBe(400);
  });

  it("adds manual alternatives, rejects incompatible kinds and duplicate pairs, and can undo an addition", async () => {
    await run();
    const added = {
      action: "add" as const,
      source: a + "Sensor",
      target: b + "Device",
      relation: "broader" as const,
      note: "Manual hierarchy mapping",
    };
    expect((await decide(added)).status).toBe(200);
    const before = await read();
    const manual = before.content.review!.alignment!.find((m) => m.source === added.source && m.target === added.target)!;
    expect(manual).toMatchObject({ humanReviewed: true, status: "open", relation: "broader" });
    expect((await decide(added)).status).toBe(409);
    expect((await decide({ ...added, source: a + "contains", target: b + "reading" })).status).toBe(400);
    expect((await decide({ ...added, source: "https://unknown.example/Term" })).status).toBe(400);
    await run();
    expect((await read()).content.review!.alignment!.find((m) => m.id === manual.id)).toBeDefined();
    await decide({ action: "undo", ids: [manual.id] });
    expect((await read()).content.review!.alignment!.find((m) => m.id === manual.id)).toBeUndefined();
  });

  it("invalidates decisions after source edits, removes their old bridge statements on rerun, and blocks stale undo", async () => {
    await run();
    let current = await read();
    const id = mapping(current).id;
    await decide({ action: "accept", ids: [id] });
    current = await read();
    current.content.modules[0].turtle += `\n<${a}Device> <http://www.w3.org/2000/01/rdf-schema#comment> "Definition updated" .`;
    await client.json("PUT", route(), { content: current.content });
    expect((await decide({ action: "edit", ids: [id], relation: "equivalent" })).status).toBe(409);
    expect((await client.json("POST", `${route()}/commit`, { acknowledged: true, acknowledgedWarnings: true })).status).toBe(409);
    await decide({ action: "reject", ids: [id] });
    expect((await decide({ action: "undo", ids: [id] })).status).toBe(409);
    await run();
    current = await read();
    expect(mapping(current)).toMatchObject({ id, status: "open" });
    expect(bridge(current)).toHaveLength(0);
    expect(current.content.review!.alignmentDecisions!.some((d) => d.action === "inputs_changed")).toBe(true);
    expect((await decide({ action: "accept", ids: [id] })).status).toBe(200);
  });

  it("checks human-authored equivalences for coherence and records held-back mappings", async () => {
    let current = await read();
    current.content.modules[0].turtle += `\n<${a}Device> <http://www.w3.org/2002/07/owl#disjointWith> <${a}Sensor> .`;
    // A direct source/target equivalence with an existing disjoint declaration creates a new unsatisfiable target class.
    current.content.modules[1].turtle += `\n<${b}Device> <http://www.w3.org/2002/07/owl#disjointWith> <${a}Device> .`;
    await client.json("PUT", route(), { content: current.content });
    await run();
    current = await read();
    const id = mapping(current).id;
    await decide({ action: "edit", ids: [id], relation: "equivalent" });
    expect((await decide({ action: "accept", ids: [id] })).status).toBe(200);
    current = await read();
    expect(mapping(current).status).not.toBe("accepted");
    expect(mapping(current).conflict?.unsat.length).toBeGreaterThan(0);
    expect(bridge(current)).toHaveLength(0);
  });

  it("does not let a stale page overwrite newer review decisions", async () => {
    await run();
    const old = await read();
    const ids = [mapping(old).id];
    await decide({ action: "defer", ids, expectedHash: old.contentHash });
    expect((await decide({ action: "accept", ids, expectedHash: old.contentHash })).status).toBe(409);
    expect(mapping(await read()).status).toBe("deferred");
  });
});
