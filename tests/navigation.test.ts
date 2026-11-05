import { describe, expect, it } from "vitest";
import { graphReturnState, graphTab, navigationSelection, switchGraphHref } from "../src/app/navigation";

describe("workspace navigation", () => {
  it("distinguishes project ontology validation from graph validation", () => {
    expect(navigationSelection("/p/science/validate", "?rev=ontology-v1", false)).toEqual({
      area: "ontology",
      id: "validation",
      label: "Validation",
    });
    expect(navigationSelection("/p/research/validate", "?rev=graph-v1", true)).toEqual({
      area: "graphs",
      id: "validation",
      label: "Validation",
    });
  });
  it("keeps every exploration mode in the same graph sidebar destination", () => {
    for (const path of ["explore", "assistant", "sparql", "export"]) {
      expect(navigationSelection(`/p/research/${path}`, "", true).id).toBe("explore");
    }
  });
  it("opens recorded work from older extraction links without selecting Documents", () => {
    expect(graphTab("?run=run-1")).toBe("updates");
    expect(graphTab("?rev=draft-1")).toBe("updates");
    expect(graphTab("?tab=history&rev=graph-1")).toBe("history");
    expect(graphTab("?tab=invalid")).toBe("documents");
  });
  it("switches graphs without leaking source IDs, revisions or run IDs", () => {
    expect(navigationSelection("/p/research/evaluate", "?evaluation=old&report=report-1", true).id).toBe("evaluate");
    expect(switchGraphHref("clinical", "/p/research/evaluate", "?evaluation=old&attempt=run-1&question=old&report=report-1", true)).toBe(
      "/p/clinical/evaluate",
    );
    expect(switchGraphHref("clinical", "/p/research/graph", "?tab=updates&run=old-run&rev=old-revision&doc=old-document", true)).toBe(
      "/p/clinical/graph?tab=updates",
    );
    expect(switchGraphHref("clinical", "/p/research/explore", "?view=table&rev=old&selected=entity", true)).toBe(
      "/p/clinical/explore?view=table",
    );
    expect(switchGraphHref("clinical", "/p/research/assistant", "?conversation=old&rev=old", true)).toBe("/p/clinical/assistant");
    expect(switchGraphHref("clinical", "/p/research/sparql", "?rev=old", true)).toBe("/p/clinical/sparql");
  });
  it("preserves settings and history destinations but uses Documents when entering from the project", () => {
    expect(switchGraphHref("clinical", "/p/research/project-settings", "", true)).toBe("/p/clinical/graph?tab=settings");
    expect(switchGraphHref("clinical", "/p/research/graph", "?tab=history", true)).toBe("/p/clinical/graph?tab=history");
    expect(switchGraphHref("clinical", "/p/science/ontology", "?tab=history&rev=ontology", false)).toBe("/p/clinical/graph?tab=documents");
  });
  it("keeps version history separate from execution activity", () => {
    expect(navigationSelection("/p/science/ontology", "?tab=history", false).id).toBe("versions");
    expect(navigationSelection("/p/science/runs/run-1", "", false).id).toBe("activity");
    expect(navigationSelection("/p/research/graph", "?tab=history", true).id).toBe("history");
  });
  it("accepts a return path only inside the original graph workspace", () => {
    const original = { id: "research", name: "Science–Research", to: "/p/research/graph?tab=updates&run=saved" };
    expect(graphReturnState({ graphReturn: original })).toEqual(original);
    expect(graphReturnState({ graphReturn: { ...original, to: "https://example.org" } })).toBeNull();
    expect(graphReturnState({ graphReturn: { ...original, to: "/p/another/graph" } })).toBeNull();
    expect(graphReturnState(null)).toBeNull();
  });
});
