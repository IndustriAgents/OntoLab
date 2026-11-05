import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "n3";
import SHACLValidator from "rdf-validate-shacl";
import ds from "@rdfjs/dataset";
import { startApp, type TestApp, type Client } from "./helpers.ts";
import type { OntologyRevision, RevisionWithContent, StoredValidationReport } from "../src/types/project.ts";

const standard = (ns: string) => `@prefix : <${ns}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Device a owl:Class; rdfs:label "Device" .
:Sensor a owl:Class; rdfs:label "Sensor"; rdfs:subClassOf :Device .
:reading a owl:DatatypeProperty; rdfs:domain :Device; rdfs:range xsd:integer .`;
let app: TestApp;
let client: Client;
let pid: string;
beforeEach(async () => {
  app = await startApp();
  client = app.as("researcher");
  const p = await client.json<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Transparent workflows",
    settings: { models: { embeddings: "hash", nli: "lexical" } },
  });
  pid = p.body.project.id;
});
afterEach(async () => app.close());
async function draft(abox: unknown = null) {
  const r = await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions`, {
    source: "import",
    summary: "Two standards",
    content: {
      modules: [
        { id: "a", name: "a.ttl", turtle: standard("https://a.example/#") },
        { id: "b", name: "b.ttl", turtle: standard("https://b.example/#") },
      ],
      abox,
      baseIri: "https://data.example/#",
    },
  });
  expect(r.status).toBe(201);
  return r.body.revision;
}
async function read(id: string) {
  return (await client.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${id}`)).body.revision;
}

describe("alignment research trail", () => {
  it("persists exact inputs, active matchers, candidate scores and merge decisions", async () => {
    const r = await draft();
    const aligned = await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions/${r.id}/align`, {
      sourceModules: ["a"],
      targetModules: ["b"],
      matchers: { lexical: true, semantic: false, structural: false },
    });
    expect(aligned.status).toBe(200);
    const before = await read(aligned.body.revision.id);
    const record = before.content.review!.alignmentRuns![0];
    expect(record.inputHash).toBe(r.contentHash);
    expect(record.modules.map((m) => m.turtle)).toEqual([standard("https://a.example/#"), standard("https://b.example/#")]);
    expect(record.diagnostics).toMatchObject({
      sourceTerms: 3,
      processedSourceTerms: 3,
      targetTerms: 3,
      embedder: null,
      matchers: { lexical: true, semantic: false, structural: false },
      returnedMappings: 3,
    });
    expect(
      record.candidates.every((c) => c.relation === "candidate" && !c.verified && c.scores?.lexical === 1 && c.scores.semantic === 0),
    ).toBe(true);
    const ids = before.content.review!.alignment!.map((m) => m.id);
    const accepted = await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions/${r.id}/align/accept`, {
      ids,
    });
    expect(accepted.status).toBe(200);
    const after = await read(r.id);
    const decision = after.content.review!.alignmentRuns![0].decisions[0];
    expect(decision.accepted).toEqual(ids);
    expect(decision.conflicts).toEqual([]);
    expect(decision.forced).toBe(false);
    expect(decision.turtle).toContain("closeMatch");
    expect(decision.turtle).not.toContain("equivalentClass");
    expect(after.content.modules.filter((m) => m.name !== "alignment.ttl")).toEqual(before.content.modules);
    expect(after.content.review!.alignment!.every((m) => m.status === "accepted")).toBe(true);
    expect(new Parser().parse(decision.turtle).length).toBe(3);
    expect((await client.json("POST", `/api/projects/${pid}/revisions/${r.id}/align/accept`, { ids })).status).toBe(400);
  });
  it("rejects overlapping groups and acceptance against modified ontology inputs", async () => {
    const r = await draft();
    expect(
      (await client.json("POST", `/api/projects/${pid}/revisions/${r.id}/align`, { sourceModules: ["a"], targetModules: ["a", "b"] }))
        .status,
    ).toBe(400);
    await client.json("POST", `/api/projects/${pid}/revisions/${r.id}/align`, {
      sourceModules: ["a"],
      targetModules: ["b"],
      matchers: { semantic: false },
    });
    const aligned = await read(r.id);
    aligned.content.modules[0].turtle += "\n<https://a.example/#Extra> a <http://www.w3.org/2002/07/owl#Class> .";
    expect((await client.json("PUT", `/api/projects/${pid}/revisions/${r.id}`, { content: aligned.content })).status).toBe(200);
    const result = await client.json("POST", `/api/projects/${pid}/revisions/${r.id}/align/accept`, {
      ids: aligned.content.review!.alignment!.map((m) => m.id),
    });
    expect(result.status).toBe(409);
  });
});

describe("validation evidence", () => {
  it("captures shapes for an empty A-Box without claiming data conformance", async () => {
    const r = await draft();
    const result = await client.json<{ report: StoredValidationReport }>("POST", `/api/projects/${pid}/revisions/${r.id}/validate`, {
      queries: [],
    });
    expect(result.status).toBe(200);
    const evidence = result.body.report.shaclExecution!;
    expect(evidence).toMatchObject({ status: "empty-data", conforms: null, dataQuads: 0, results: [] });
    expect(evidence.shapeQuads).toBeGreaterThan(0);
    expect(new Parser().parse(evidence.shapesTurtle)).toHaveLength(evidence.shapeQuads);
    expect(result.body.report.ontologyIssues).toBeDefined();
    const saved = await client.json<{ report: StoredValidationReport }>("GET", `/api/projects/${pid}/revisions/${r.id}/report`);
    expect(saved.body.report.shaclExecution).toEqual(evidence);
  });
  it("exports a reproducible SHACL data graph with ancestor types and raw constraint evidence", async () => {
    const r = await draft({
      individuals: [
        {
          id: "sensor1",
          classUri: "https://a.example/#Sensor",
          label: "S1",
          dataProperties: [
            { propUri: "https://a.example/#reading", value: "not-an-integer", datatype: "http://www.w3.org/2001/XMLSchema#string" },
          ],
          objectProperties: [],
        },
      ],
      notes: [],
    });
    const result = await client.json<{ report: StoredValidationReport }>("POST", `/api/projects/${pid}/revisions/${r.id}/validate`, {
      queries: [],
    });
    expect(result.status).toBe(200);
    const evidence = result.body.report.shaclExecution!;
    expect(evidence.status).toBe("completed");
    expect(evidence.inferredTypeQuads).toBeGreaterThan(0);
    expect(evidence.dataTurtle).toContain("https://a.example/#Device");
    expect(evidence.results.length).toBeGreaterThan(0);
    expect(
      evidence.results.some(
        (r) => r.constraint.endsWith("DatatypeConstraintComponent") && r.path === "https://a.example/#reading" && !!r.sourceShape,
      ),
    ).toBe(true);
    const rerun = await new SHACLValidator(ds.dataset(new Parser().parse(evidence.shapesTurtle))).validate(
      ds.dataset(new Parser().parse(evidence.dataTurtle)),
    );
    expect(rerun.conforms).toBe(evidence.conforms);
    expect(rerun.results.length).toBe(evidence.results.length);
    expect(result.body.report.execution?.individuals).toBe(1);
  });
});
