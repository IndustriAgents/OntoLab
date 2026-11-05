import { isOntologyRevision } from "../src/lib/runNavigation";
import { describe, expect, it } from "vitest";
import { selectedOntology, switchOntologyHref } from "../src/lib/ontologySelection";
import type { OntologyRevision } from "../src/types/project";
const revisions = [
  { id: "draft", status: "draft", stats: { modules: 1 } },
  { id: "v2", status: "committed", stats: { modules: 1 } },
  { id: "v1", status: "committed", stats: { modules: 1 } },
] as OntologyRevision[];
describe("selected ontology context", () => {
  it("prefers an explicit version, remembers the last choice, and falls back after deletion", () => {
    expect(selectedOntology(revisions, "v2", "v1", "draft")).toBe("v1");
    expect(selectedOntology(revisions, "v2", null, "draft")).toBe("draft");
    expect(selectedOntology(revisions, "v2", null, "deleted")).toBe("v2");
    expect(selectedOntology(revisions, null, null, null)).toBe("draft");
    expect(selectedOntology([], null, null, "deleted")).toBeNull();
  });
  it("keeps ontology editor and validation destinations but drops stale run or document context", () => {
    expect(switchOntologyHref("science", "v1", "/p/science/ontology", "?tab=terms&rev=v2&run=old")).toBe(
      "/p/science/ontology?rev=v1&tab=terms",
    );
    expect(switchOntologyHref("science", "draft", "/p/science/validate", "?rev=v2")).toBe("/p/science/validate?rev=draft");
    expect(switchOntologyHref("science", "v1", "/p/science/workflows/tbox", "?step=results&run=old&base=v2&doc=old")).toBe(
      "/p/science/workflows/tbox?rev=v1&start=previous",
    );
  });
  it("opens the parent ontology from a graph without changing its pinned ontology or version", () => {
    expect(switchOntologyHref("science", "v1", "/p/graph/graph", "?tab=updates&run=graph-run")).toBe("/p/science/ontology/overview?rev=v1");
  });
});

describe("legacy ontology draft navigation", () => {
  it("recognizes ontology drafts that predate explicit scopes", () => {
    const revision = { source: "ontology", stats: { modules: 1, individuals: 0 } } as OntologyRevision;
    expect(isOntologyRevision(revision)).toBe(true);
    expect(isOntologyRevision({ ...revision, source: "induction" })).toBe(true);
    expect(isOntologyRevision({ ...revision, source: "manual" })).toBe(true);
    expect(isOntologyRevision({ ...revision, scope: "abox" })).toBe(false);
    expect(isOntologyRevision({ ...revision, source: "extraction", stats: { ...revision.stats, individuals: 5 } })).toBe(false);
  });
});
