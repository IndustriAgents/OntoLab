import { describe, expect, it } from "vitest";
import { buildTboxEvidence } from "../src/lib/tboxEvidence";
import { buildEvidenceGraph, evidenceNodeId, layoutEvidenceGraph, traceEvidenceGraph } from "../src/lib/tboxEvidenceGraph";
import type { RunResearch } from "../src/types/research";
import type { RevisionWithContent } from "../src/types/project";

function fixture() {
  const chunks = [
    { id: "c1", documentId: "d", ordinal: 0, start: 0, end: 25, text: "Sensor measures pressure." },
    { id: "c2", documentId: "d", ordinal: 1, start: 25, end: 51, text: "Omitted unrelated context." },
    { id: "c3", documentId: "e", ordinal: 0, start: 0, end: 21, text: "Valve regulates flow." },
  ];
  const report = {
    version: 1,
    run: {
      id: "r",
      kind: "induction",
      status: "ready_for_review",
      steps: [
        { key: "terms:0", kind: "terms", label: "Topic 1", topic: { index: 0, count: 2, batch: 0, batches: 1 }, chunkIds: ["c1", "c2"] },
        { key: "terms:1", kind: "terms", label: "Topic 2", topic: { index: 1, count: 2, batch: 0, batches: 1 }, chunkIds: ["c3"] },
        {
          key: "relations:0",
          kind: "relations",
          label: "Topic 1 properties",
          topic: { index: 0, count: 2, batch: 0, batches: 1 },
          chunkIds: ["c1"],
        },
      ],
    },
    inputs: {
      documents: [
        { id: "d", name: "sensors.txt" },
        { id: "e", name: "valves.txt" },
      ],
      chunks,
    },
    checkpoints: [
      {
        key: "terms:0",
        payload: {
          classes: [{ name: "PressureSensor" }, { name: "Controller" }],
          evidence: [{ kind: "class", term: "PressureSensor", quote: chunks[0].text, located: true, documentId: "d" }],
        },
        trace: { input: { sampledDocuments: [{ ...chunks[0], chunkId: "c1", name: "sensors.txt" }] } },
      },
      {
        key: "terms:1",
        payload: {
          classes: [{ name: "Sensor" }, { name: "Valve" }],
          evidence: [
            { kind: "class", term: "Sensor", quote: chunks[2].text, located: true, documentId: "e" },
            { kind: "class", term: "Valve", quote: chunks[2].text, located: true, documentId: "e" },
          ],
        },
        trace: { input: { sampledDocuments: [{ ...chunks[2], chunkId: "c3", name: "valves.txt" }] } },
      },
      {
        key: "relations:0",
        payload: {
          objectProperties: [{ name: "measures", domain: ["Sensor"], range: ["Pressure"] }],
          evidence: [{ kind: "object", term: "measures", quote: chunks[0].text, located: true, documentId: "d" }],
        },
        trace: { input: { sampledDocuments: [{ ...chunks[0], chunkId: "c1", name: "sensors.txt" }] } },
      },
      { key: "merge", payload: { aliases: { PressureSensor: "Sensor" } } },
    ],
  } as unknown as RunResearch;
  return report;
}
const term = (id: string) => evidenceNodeId("term", id);
const chunk = (id: string) => evidenceNodeId("chunk", id);

describe("T-Box provenance graph", () => {
  it("traces a merged class across all recorded topics to its actual quoted chunks", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    const trace = traceEvidenceGraph(graph, term("class:Sensor"));
    expect(trace.nodeIds).toContain(evidenceNodeId("topic", "topic:1"));
    expect(trace.nodeIds).toContain(evidenceNodeId("topic", "topic:2"));
    expect(trace.nodeIds).toContain(chunk("c1"));
    expect(trace.nodeIds).toContain(chunk("c3"));
    expect(trace.nodeIds).not.toContain(chunk("c2"));
    expect(trace.nodeIds).not.toContain(term("class:Valve"));
    expect(trace.nodeIds).not.toContain(term("class:Controller"));
    expect(graph.nodes.filter((n) => n.kind === "passage" && trace.nodeIds.has(n.id))).toHaveLength(2);
  });
  it("never converts planned or omitted chunks into generation inputs", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    expect(graph.edges.some((e) => e.kind === "member" && e.target === chunk("c2"))).toBe(true);
    expect(graph.edges.some((e) => e.kind === "input" && e.source === chunk("c2"))).toBe(false);
    expect(traceEvidenceGraph(graph, term("class:Sensor"), true).nodeIds).not.toContain(chunk("c2"));
  });
  it("keeps uncited same-call associations opt-in and labels them separately", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    const strict = traceEvidenceGraph(graph, term("class:Controller"));
    expect(strict.nodeIds).not.toContain(chunk("c1"));
    expect(strict.associationOnly).toBe(true);
    expect(strict.hiddenInputs).toBe(1);
    const expanded = traceEvidenceGraph(graph, term("class:Controller"), true);
    expect(expanded.nodeIds).toContain(chunk("c1"));
    expect(graph.edges.filter((e) => expanded.edgeIds.has(e.id)).some((e) => e.kind === "input")).toBe(true);
    expect(graph.edges.filter((e) => expanded.edgeIds.has(e.id)).some((e) => e.kind === "located")).toBe(false);
  });
  it("traces a property through its recorded quote and topic", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    expect(graph.byId.get(term("object:measures"))?.kind).toBe("property");
    const trace = traceEvidenceGraph(graph, term("object:measures"));
    expect(trace.nodeIds).toContain(chunk("c1"));
    expect(trace.nodeIds).toContain(evidenceNodeId("topic", "topic:1"));
    expect(trace.nodeIds).not.toContain(chunk("c3"));
  });
  it("does not attach an unlocated quote to an arbitrary chunk in its document", () => {
    const report = fixture();
    (report.checkpoints[0].payload as { evidence: { quote: string }[] }).evidence[0].quote = "A quote not present in the source";
    const graph = buildEvidenceGraph(buildTboxEvidence(report));
    const unlocated = graph.nodes.find((n) => n.text === "A quote not present in the source")!;
    expect(unlocated.unavailable).toBe(true);
    expect(graph.edges.some((e) => e.kind === "located" && e.target === unlocated.id)).toBe(false);
    expect(traceEvidenceGraph(graph, unlocated.id).nodeIds).not.toContain(chunk("c1"));
  });
  it("keeps ambiguous namespace terms separate from candidate provenance", () => {
    const revision = {
      content: {
        baseIri: "",
        modules: [
          {
            turtle:
              "@prefix a: <http://example.org/a#>. @prefix b: <http://example.org/b#>. @prefix owl: <http://www.w3.org/2002/07/owl#>. a:Sensor a owl:Class. b:Sensor a owl:Class.",
          },
        ],
      },
    } as RevisionWithContent;
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture(), revision));
    const result = graph.nodes.filter((n) => n.term?.inResult);
    expect(result).toHaveLength(2);
    expect(result.every((n) => traceEvidenceGraph(graph, n.id).edgeIds.size === 0)).toBe(true);
  });
  it("keeps passage IDs stable as new checkpoints and terms are added", () => {
    const report = fixture(),
      first = buildEvidenceGraph(buildTboxEvidence(report));
    (report.checkpoints[0].payload as { classes: { name: string }[] }).classes.unshift({ name: "AddedLater" });
    const next = buildEvidenceGraph(buildTboxEvidence(report));
    expect(
      first.nodes
        .filter((n) => n.kind === "passage")
        .map((n) => n.id)
        .sort(),
    ).toEqual(
      next.nodes
        .filter((n) => n.kind === "passage")
        .map((n) => n.id)
        .sort(),
    );
  });
  it("lays out all graph nodes deterministically with finite positions and valid endpoints", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    const first = layoutEvidenceGraph(graph.nodes, graph.edges),
      next = layoutEvidenceGraph(graph.nodes, graph.edges);
    expect([...first.positions]).toEqual([...next.positions]);
    expect(first.positions.size).toBe(graph.nodes.length);
    expect([...first.positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(graph.edges.every((e) => graph.byId.has(e.source) && graph.byId.has(e.target))).toBe(true);
  });
  it("shows planned grouping without fabricating generated terms for a pending build", () => {
    const report = fixture();
    report.checkpoints = [];
    const graph = buildEvidenceGraph(buildTboxEvidence(report));
    expect(graph.nodes.some((n) => n.kind === "class" || n.kind === "property" || n.kind === "passage")).toBe(false);
    expect(traceEvidenceGraph(graph, evidenceNodeId("topic", "topic:1")).nodeIds).toContain(chunk("c2"));
  });
  it("arranges a selected source path in readable rows on mobile", () => {
    const graph = buildEvidenceGraph(buildTboxEvidence(fixture()));
    const trace = traceEvidenceGraph(graph, term("object:measures"));
    const nodes = graph.nodes.filter((n) => trace.nodeIds.has(n.id));
    const edges = graph.edges.filter((e) => trace.edgeIds.has(e.id));
    const layout = layoutEvidenceGraph(nodes, edges, true);
    const topic = nodes.find((n) => n.kind === "topic")!,
      passage = nodes.find((n) => n.kind === "passage")!;
    expect(layout.width).toBe(300);
    expect(layout.positions.get(topic.id)!.y).toBeLessThan(layout.positions.get(chunk("c1"))!.y);
    expect(layout.positions.get(chunk("c1"))!.y).toBeLessThan(layout.positions.get(passage.id)!.y);
    expect(layout.positions.get(passage.id)!.y).toBeLessThan(layout.positions.get(term("object:measures"))!.y);
    expect(
      nodes.every((n) => {
        const p = layout.positions.get(n.id)!;
        return p.x >= 92 && p.x + 92 <= layout.width && p.y >= 26 && p.y + 26 <= layout.height;
      }),
    ).toBe(true);
  });
});
