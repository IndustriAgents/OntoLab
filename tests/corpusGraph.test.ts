import { applyMerge } from "../src/lib/ontology/resolution";
import { describe, it, expect } from "vitest";
import {
  documentOrigins,
  withoutSources,
  canonicalizeIncoming,
  corpusUserEdit,
  suppressFacts,
  retainLostFact,
  normalizeCorpusLiterals,
  respectCorpusEdits,
  corpusIdentityIndex,
  preserveCorpusDecisions,
  corpusChanges,
  corpusFactKey,
  decideCorpusReplacement,
} from "../src/lib/corpusGraph";
import { mergeAboxes } from "../src/lib/ontology/aboxMerge";
import { parseTBox } from "../src/lib/ontology/tboxParser";
import type { ABoxResult } from "../src/types/abox";
import type { RevisionContent } from "../src/types/project";
import { listFacts } from "../src/lib/ontology/factReview";
const cls = "http://ex/#Pump",
  prop = "http://ex/#name";
const source = (id: string): ABoxResult =>
  documentOrigins(
    {
      individuals: [
        {
          id: "pump",
          classUri: cls,
          evidence: [{ documentId: id, chunkId: `${id}_c0`, quote: "Pump A", status: "verified", start: 0, end: 6 }],
          dataProperties: [
            {
              propUri: prop,
              value: "A",
              datatype: "http://www.w3.org/2001/XMLSchema#string",
              evidence: [{ documentId: id, chunkId: `${id}_c0`, quote: "Pump A", status: "verified", start: 0, end: 6 }],
            },
          ],
        },
      ],
    },
    id,
    `${id}_c0`,
    `run_${id}`,
  );
const content = (abox: ABoxResult): RevisionContent => ({
  modules: [],
  abox,
  corpus: {
    ontology: { projectId: "p", revisionId: "r", number: 1, hash: "hash", name: "schema" },
    sources: [],
    suppressed: [],
    losses: [],
  },
});
describe("corpus provenance invariants", () => {
  it("keeps replacement identity hints without resurrecting the superseded source's facts", () => {
    const previous = source("old");
    previous.individuals[0].iri = "http://ex/pump-101";
    previous.individuals[0].mergedFrom = ["old-pump-name"];
    const index = corpusIdentityIndex(previous);
    expect(index.individuals[0].id).toBe("pump");
    expect(index.individuals[0].mergedFrom).toEqual(["old-pump-name"]);
    expect(index.individuals[0].evidence).toBeUndefined();
    expect(index.individuals[0].dataProperties).toBeUndefined();
    expect(index.individuals[0].origins).toBeUndefined();
    expect(withoutSources(previous, new Set(["old"])).abox.individuals).toEqual([]);
  });
  it("preserves exact human decisions and identifiers after replacement, with fresh source evidence", () => {
    const previous = source("old"),
      incoming = source("new");
    previous.individuals[0].mergedFrom = ["alias"];
    previous.individuals[0].sameAs = ["http://ex/equipment/101"];
    previous.individuals[0].differentFrom = ["other-pump"];
    previous.individuals[0].review = { by: "user", status: "accepted" };
    previous.individuals[0].dataProperties![0].review = { by: "user", status: "accepted" };
    incoming.individuals[0].id = "alias";
    const result = preserveCorpusDecisions(incoming, previous).individuals[0];
    expect(result.id).toBe("pump");
    expect(result.sameAs).toEqual(previous.individuals[0].sameAs);
    expect(result.differentFrom).toEqual(previous.individuals[0].differentFrom);
    const hinted = preserveCorpusDecisions(incoming, corpusIdentityIndex(previous)).individuals[0];
    expect(hinted.sameAs).toEqual(previous.individuals[0].sameAs);
    expect(hinted.differentFrom).toEqual(previous.individuals[0].differentFrom);
    expect(hinted.review).toBeUndefined();
    expect(result.review).toEqual(previous.individuals[0].review);
    expect(result.dataProperties![0].review).toEqual(previous.individuals[0].dataProperties![0].review);
    expect(result.evidence![0].documentId).toBe("new");
    incoming.individuals[0].dataProperties![0].value = "Different value";
    expect(preserveCorpusDecisions(incoming, previous).individuals[0].dataProperties![0].review).toBeUndefined();
  });
  it("compares replacements on the same entity and property without pairing unrelated or ambiguous values", () => {
    const before = source("old"),
      after = source("new");
    after.individuals[0].dataProperties![0].value = "Revised value";
    expect(corpusChanges(before, after).updated).toHaveLength(1);
    after.individuals[0].dataProperties!.push({ propUri: prop, value: "Another value" });
    expect(corpusChanges(before, after).updated).toEqual([]);
    after.individuals[0].id = "another-pump";
    expect(corpusChanges(before, after).updated).toEqual([]);
  });
  it("surfaces lost independent support even when the fact survives, including provenance without quotes", () => {
    for (const quoted of [true, false]) {
      const before = mergeAboxes([source("one"), source("two")]).abox;
      if (!quoted)
        for (const i of before.individuals) {
          i.evidence = [];
          for (const p of i.dataProperties ?? []) p.evidence = [];
        }
      const after = withoutSources(before, new Set(["one"])).abox;
      const changes = corpusChanges(before, after);
      expect(changes.reduced).toHaveLength(2);
      expect(changes.added).toEqual([]);
      expect(changes.removed).toEqual([]);
      expect(changes.unchanged).toBe(0);
    }
  });
  it("surfaces review changes and counts a fact with multiple provenance changes only once", () => {
    const before = source("one"),
      after = source("two");
    after.individuals[0].dataProperties![0].review = { by: "user", status: "rejected" };
    const changes = corpusChanges(before, after);
    expect(changes.enriched).toHaveLength(2);
    expect(changes.reduced).toHaveLength(2);
    expect(changes.reviewed).toHaveLength(1);
    expect(changes.unchanged).toBe(0);
    const decisionOnly = structuredClone(before);
    decisionOnly.individuals[0].review = { by: "user", status: "rejected" };
    expect(corpusChanges(before, decisionOnly).reviewed).toHaveLength(1);
    expect(corpusChanges(before, decisionOnly).unchanged).toBe(1);
  });
  it.each(["proposed", "previous"] as const)("resolves a source replacement as %s without changing history", (decision) => {
    const before = source("old"),
      incoming = source("new");
    const loss = withoutSources(before, new Set(["old"])).losses.find((l) => l.fact.kind === "data")!;
    incoming.individuals[0].dataProperties![0].value = "Revised value";
    const draft = content(incoming);
    draft.corpus!.losses = [loss];
    const afterKey = corpusFactKey(listFacts(incoming).find((f) => f.kind === "data")!);
    const resolved = decideCorpusReplacement(draft, loss.key, afterKey, decision, "2026-10-31T12:00:00Z")!;
    expect(resolved.corpus!.losses[0].decision).toBe(decision === "proposed" ? "remove" : "manual");
    const proposed = resolved.abox!.individuals[0].dataProperties!.find((d) => d.value === "Revised value")!;
    expect(proposed.review?.status).toBe(decision === "proposed" ? "accepted" : "rejected");
    if (decision === "previous") {
      const retained = resolved.abox!.individuals[0].dataProperties!.find((d) => d.value === loss.data!.value)!;
      expect(retained.origins).toEqual([{ kind: "manual" }]);
      expect(retained.evidence).toBeUndefined();
    }
    expect(draft.corpus!.losses[0].decision).toBe("pending");
    expect(before.individuals[0].dataProperties![0].value).toBe(loss.data!.value);
    expect(decideCorpusReplacement(draft, loss.key, "unrelated", decision, "now")).toBeNull();
    for (const retry of ["previous", "proposed"] as const)
      expect(decideCorpusReplacement(resolved, loss.key, afterKey, retry, "later")).toBeNull();
  });
  it("merges repeated results without duplicating entities, facts, quotes or source origins", () => {
    const a = source("one");
    const result = mergeAboxes([a, a, a]).abox;
    expect(result.individuals).toHaveLength(1);
    expect(result.individuals[0].dataProperties).toHaveLength(1);
    expect(result.individuals[0].evidence).toHaveLength(1);
    expect(result.individuals[0].origins).toHaveLength(1);
  });
  it("preserves independent support and removes the deleted source's quotes", () => {
    const both = mergeAboxes([source("one"), source("two")]).abox;
    const result = withoutSources(both, new Set(["one"]));
    expect(result.losses).toEqual([]);
    expect(result.abox.individuals[0].origins?.map((o) => o.documentId)).toEqual(["two"]);
    expect(result.abox.individuals[0].dataProperties?.[0].evidence?.map((e) => e.documentId)).toEqual(["two"]);
  });
  it("requires a decision when the final source disappears and retains literal datatype on manual preservation", () => {
    const result = withoutSources(source("one"), new Set(["one"]));
    expect(result.abox.individuals).toHaveLength(0);
    expect(result.losses).toHaveLength(2);
    const restored = result.losses.reduce(retainLostFact, content(result.abox)).abox!;
    expect(restored.individuals[0].dataProperties?.[0].datatype).toBe("http://www.w3.org/2001/XMLSchema#string");
    expect(restored.individuals[0].evidence).toBeUndefined();
    expect(restored.individuals[0].origins?.every((o) => o.kind === "manual")).toBe(true);
  });
  it("does not guess identity from a common label", () => {
    const base = { individuals: [{ id: "a", classUri: cls, label: "Pump" }] };
    expect(canonicalizeIncoming({ individuals: [{ id: "b", classUri: cls, label: "Pump" }] }, base).individuals[0].id).toBe("b");
  });
  it("reuses explicit same-IRI and user merge identities for properties and missing targets", () => {
    const base = { individuals: [{ id: "a", classUri: cls, iri: "http://ex/id", mergedFrom: ["old"] }] };
    const result = canonicalizeIncoming(
      { individuals: [{ id: "new", classUri: cls, iri: "http://ex/id", objectProperties: [{ propUri: prop, targetId: "old" }] }] },
      base,
    );
    expect(result.individuals[0].id).toBe("a");
    expect(result.individuals[0].objectProperties?.[0].targetId).toBe("a");
  });
  it("preserves manual property corrections and their deletion decisions across extraction", () => {
    const before = content(source("one"));
    const next = structuredClone(before);
    next.abox!.individuals[0].dataProperties![0].value = "Corrected";
    const edited = corpusUserEdit(before, next);
    const d = edited.abox!.individuals[0].dataProperties![0];
    expect(d.origins).toEqual([{ kind: "manual" }]);
    expect(d.evidence).toBeUndefined();
    const incoming = suppressFacts(source("two"), edited.corpus!.suppressed);
    const merged = mergeAboxes([edited.abox!, incoming]).abox;
    expect(merged.individuals[0].dataProperties?.map((p) => p.value)).toEqual(["Corrected"]);
  });
  it("preserves a human class correction without attaching the old class's quote", () => {
    const before = content(source("one")),
      next = structuredClone(before);
    next.abox!.individuals[0].classUri = "http://ex/#Valve";
    const edited = corpusUserEdit(before, next);
    const incoming = respectCorpusEdits(source("two"), edited.abox!, edited.corpus!.suppressed);
    const result = mergeAboxes([edited.abox!, incoming]).abox.individuals[0];
    expect(result.classUri).toBe("http://ex/#Valve");
    expect(result.additionalTypes ?? []).not.toContain(cls);
    expect(result.evidence).toBeUndefined();
    expect(result.origins?.every((o) => o.kind === "manual")).toBe(true);
    expect(result.dataProperties?.[0].origins?.some((o) => o.documentId === "two")).toBe(true);
  });
  it("retains a missing relationship and resolves it when its target arrives", () => {
    const partial = mergeAboxes([
      { individuals: [{ id: "pump", classUri: cls, objectProperties: [{ propUri: prop, targetId: "missing" }] }] },
    ]).abox;
    expect(partial.individuals[0].objectProperties).toBeUndefined();
    expect(partial.unresolved?.[0].targetId).toBe("missing");
    const complete = mergeAboxes([partial, { individuals: [{ id: "missing", classUri: cls }] }]).abox;
    expect(complete.unresolved).toBeUndefined();
    expect(complete.individuals[0].objectProperties?.[0].targetId).toBe("missing");
  });
  it("keeps a dismissed missing relationship dismissed if the target later arrives", () => {
    const partial = mergeAboxes([
      { individuals: [{ id: "pump", classUri: cls, objectProperties: [{ propUri: prop, targetId: "missing" }] }] },
    ]).abox;
    partial.unresolved![0].status = "dismissed";
    const complete = mergeAboxes([partial, { individuals: [{ id: "missing", classUri: cls }] }]).abox;
    expect(complete.individuals[0].objectProperties).toBeUndefined();
    expect(complete.unresolved?.[0].status).toBe("dismissed");
  });
  it("normalizes implicit RDF datatypes before merging, without merging different values", () => {
    const schema = parseTBox(
      "@prefix ex:<http://ex/#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix xsd:<http://www.w3.org/2001/XMLSchema#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. ex:Pump a owl:Class. ex:name a owl:DatatypeProperty;rdfs:range xsd:string.",
    );
    const implicit = source("two");
    delete implicit.individuals[0].dataProperties![0].datatype;
    const merged = mergeAboxes([source("one"), normalizeCorpusLiterals(implicit, schema)]).abox;
    expect(merged.individuals[0].dataProperties).toHaveLength(1);
    expect(merged.individuals[0].dataProperties![0].origins).toHaveLength(2);
  });
});

it("restores each original source after undoing a manual merge", () => {
  const first = source("one"),
    second = source("two");
  second.individuals[0].id = "pump-two";
  const original = content(mergeAboxes([first, second]).abox);
  original.corpus!.sources = ["one", "two"].map((documentId) => ({
    documentId,
    memberId: documentId,
    runId: `run_${documentId}`,
    checksum: "",
    fingerprint: "",
    chunks: 1,
    cached: 0,
    screened: 0,
  }));
  const merged = corpusUserEdit(original, { ...original, abox: applyMerge(original.abox!, ["pump", "pump-two"]).abox });
  const undo = corpusUserEdit(merged, structuredClone(original), original.abox!);
  for (const [id, documentId] of [
    ["pump", "one"],
    ["pump-two", "two"],
  ]) {
    const i = undo.abox!.individuals.find((i) => i.id === id)!;
    expect(i.origins?.map((o) => o.documentId)).toEqual([documentId]);
    expect(i.evidence?.map((e) => e.documentId)).toEqual([documentId]);
    expect(i.dataProperties?.[0].evidence?.map((e) => e.documentId)).toEqual([documentId]);
  }
  expect(undo.corpus!.suppressed).toEqual([]);
});
it("does not restore claimed source metadata that disagrees with the trusted extraction", () => {
  const original = content(source("one"));
  original.corpus!.sources = [
    { documentId: "one", memberId: "s", runId: "run_one", checksum: "", fingerprint: "", chunks: 1, cached: 0, screened: 0 },
  ];
  const deleted = corpusUserEdit(original, { ...original, abox: { individuals: [] } });
  const forged = structuredClone(original);
  forged.abox!.individuals[0].evidence![0].quote = "Forged quote";
  const result = corpusUserEdit(deleted, forged, original.abox!);
  expect(result.abox!.individuals[0].origins?.every((o) => o.kind === "manual")).toBe(true);
  expect(result.abox!.individuals[0].evidence).toBeUndefined();
  expect(result.corpus!.suppressed).toEqual([]);
});

it("undo restores document support without retaining a superseded manual override", () => {
  const original = content(source("one"));
  original.corpus!.sources = [
    { documentId: "one", memberId: "s", runId: "run_one", checksum: "", fingerprint: "", chunks: 1, cached: 0, screened: 0 },
  ];
  const modified = structuredClone(original);
  modified.abox!.individuals[0].dataProperties![0].value = "Manual correction";
  const corrected = corpusUserEdit(original, modified);
  const restored = corpusUserEdit(corrected, structuredClone(original), original.abox!);
  expect(restored.abox!.individuals[0].origins).toEqual(original.abox!.individuals[0].origins);
  expect(restored.abox!.individuals[0].dataProperties![0].origins).toEqual(original.abox!.individuals[0].dataProperties![0].origins);
  expect(restored.corpus!.suppressed).toEqual([]);
});
