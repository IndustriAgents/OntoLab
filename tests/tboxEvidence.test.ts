import { describe, expect, it } from "vitest";
import type { RunResearch } from "../src/types/research";
import type { JobCheckpoint, ResearchInputs, RevisionWithContent, RunView } from "../src/types/project";
import { buildTboxEvidence, passageStatus, questionMatches } from "../src/lib/tboxEvidence";
import { groundTerms } from "../server/services/inductionAxioms.ts";
import { topicChunkEvidence, readableChunkPreview } from "../src/lib/tboxEvidence";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TboxTopicExplorer } from "../src/features/research/TboxTopicExplorer";

const question = "Which sensors measure pressure?";
const source = "Sensor measures pressure. A valve regulates flow.";
function fixture(): RunResearch {
  const split = source.indexOf("A valve");
  const chunks = [
    { id: "c1", ordinal: 0, start: 0, end: split, text: source.slice(0, split), documentId: "d", projectId: "p" },
    { id: "c2", ordinal: 1, start: split, end: source.length, text: source.slice(split), documentId: "d", projectId: "p" },
  ];
  return {
    version: 1,
    run: {
      id: "r",
      kind: "induction",
      status: "ready_for_review",
      steps: [
        {
          key: "terms:0",
          kind: "terms",
          label: "First class batch",
          chunkIds: ["c1"],
          topic: { index: 0, count: 1, batch: 0, batches: 2 },
        },
        {
          key: "terms:1",
          kind: "terms",
          label: "Second class batch",
          chunkIds: ["c2"],
          topic: { index: 0, count: 1, batch: 1, batches: 2 },
        },
      ],
    } as RunView,
    inputs: {
      version: 1,
      documents: [{ id: "d", name: "sensors.txt" }],
      chunks,
      documentTexts: { d: { documentId: "d", text: source, pages: [] } },
      requirements: { requirements: { cqs: [{ id: "q", text: question, status: "approved", source: "generated" }] } },
    } as unknown as ResearchInputs,
    checkpoints: [
      {
        key: "terms:0",
        payload: {
          classes: [{ name: "PressureSensor", comment: "A sensor that measures pressure." }],
          evidence: [{ kind: "class", term: "PressureSensor", quote: "Sensor measures pressure.", located: true, documentId: "d" }],
        },
        trace: { input: { requirementsText: question, sampledDocuments: [{ ...chunks[0], chunkId: "c1", name: "sensors.txt" }] } },
      },
      {
        key: "terms:1",
        payload: { classes: [{ name: "Valve", comment: "Regulates flow." }] },
        trace: { input: { sampledDocuments: [{ ...chunks[1], chunkId: "c2", name: "sensors.txt" }] } },
      },
      { key: "merge", payload: { aliases: { PressureSensor: "Sensor" } } },
    ] as unknown as JobCheckpoint[],
  };
}
const revision = (turtle: string) => ({ content: { modules: [{ turtle }], baseIri: "" } }) as RevisionWithContent;
const prefixes = "@prefix a: <http://example.org/a#>. @prefix b: <http://example.org/b#>. @prefix owl: <http://www.w3.org/2002/07/owl#>.";

describe("T-Box evidence navigation", () => {
  it("separates a located quote from terms generated in the same request", () => {
    const report = fixture();
    (report.checkpoints[0].payload as { classes: { name: string }[] }).classes.push({ name: "Controller" });
    const links = topicChunkEvidence(buildTboxEvidence(report), "topic:1", "c1");
    expect(links.cited.map((t) => t.name)).toEqual(["Sensor"]);
    expect(links.associated.map((t) => t.name)).toEqual(["Controller"]);
    expect(links.status).toBe("used");
    expect([...links.cited, ...links.associated].some((t) => t.name === "Valve")).toBe(false);
  });
  it("does not link a topic's generated terms to an omitted chunk", () => {
    const report = fixture();
    report.checkpoints[0].trace!.input!.sampledDocuments = [];
    const links = topicChunkEvidence(buildTboxEvidence(report), "topic:1", "c1");
    expect(links.status).toBe("omitted");
    expect(links.cited).toEqual([]);
    expect(links.associated).toEqual([]);
  });
  it("puts cited terms first and keeps broader request associations behind details", () => {
    const report = fixture();
    (report.checkpoints[0].payload as { classes: { name: string }[] }).classes.push({ name: "Controller" });
    const data = buildTboxEvidence(report),
      noop = () => {};
    const html = renderToStaticMarkup(
      h(TboxTopicExplorer, {
        data,
        topicId: "topic:1",
        chunkId: "c1",
        query: "",
        onQuery: noop,
        onTopic: noop,
        onChunk: noop,
        onTerm: noop,
        onSource: noop,
        onCall: noop,
        onFiles: noop,
      }),
    );
    const output = html.split('aria-label="Topic classes and properties"')[1];
    expect(output.split('<details class="ee-step-associations"')[0]).toContain("Sensor");
    expect(output.split('<details class="ee-step-associations"')[0]).not.toContain("Controller");
    expect(output).toContain('<details class="ee-step-associations"><summary>Other terms from the same generation steps (1)</summary>');
    expect(output).toContain("Controller");
    expect(output).toContain("Same generation step");
  });
  it("distinguishes a missing input record from an input that was never sent", () => {
    const report = fixture();
    delete report.checkpoints[0].trace!.input!.sampledDocuments;
    const links = topicChunkEvidence(buildTboxEvidence(report), "topic:1", "c1");
    expect(links.status).toBe("unknown");
    expect(links.associated).toEqual([]);
  });
  it("flags shortened historical input without presenting an unmatched quote as cited from the chunk", () => {
    const report = fixture();
    report.checkpoints[0].trace!.input!.sampledDocuments = [
      { chunkId: "c1", documentId: "d", text: "Sensor", start: 0, name: "sensors.txt" },
    ];
    const links = topicChunkEvidence(buildTboxEvidence(report), "topic:1", "c1");
    expect(links.status).toBe("used");
    expect(links.shortened).toBe(true);
    expect(links.cited).toEqual([]);
    expect(links.associated.map((t) => t.name)).toEqual(["Sensor"]);
  });
  it("offers readable chunks and explains pending outputs before any generation result exists", () => {
    const report = fixture();
    report.checkpoints = [];
    const data = buildTboxEvidence(report);
    expect(topicChunkEvidence(data, "topic:1", "c1").status).toBe("pending");
    const noop = () => {};
    const html = renderToStaticMarkup(
      h(TboxTopicExplorer, {
        data,
        topicId: "",
        chunkId: "",
        query: "",
        onQuery: noop,
        onTopic: noop,
        onChunk: noop,
        onTerm: noop,
        onSource: noop,
        onCall: noop,
        onFiles: noop,
      }),
    );
    expect(html).toContain("Choose a topic");
    expect(html).toContain("Read its chunks");
    expect(html).toContain("Inspect its terms");
    expect(html).toContain("Sensor measures pressure.");
    expect(html).toContain("Not processed yet");
    expect(html).toContain("Classes will appear here");
  });
  it("keeps saved call passages navigable even when planned chunk IDs and full snapshots are absent", () => {
    const report = fixture();
    report.inputs = null;
    report.run.steps.forEach((s) => {
      s.chunkIds = [];
    });
    const data = buildTboxEvidence(report);
    expect(data.topics[0].chunkIds).toEqual(["c1", "c2"]);
    expect(topicChunkEvidence(data, "topic:1", "c1").status).toBe("used");
  });
  it("creates a readable XML preview without changing the saved input", () => {
    const xml = "<article><title>Housing &amp; policy</title><p>A source passage.</p></article>";
    expect(readableChunkPreview(xml, true)).toBe("Housing & policy A source passage.");
    expect(xml).toContain("<title>");
    expect(readableChunkPreview("<p>&amp;lt;tag&amp;gt; &lt;tag&gt;</p>", true)).toBe("&lt;tag&gt; <tag>");
  });
  it("keeps topic membership separate from request batches", () => {
    const data = buildTboxEvidence(fixture());
    expect(data.topics).toHaveLength(1);
    expect(data.topics[0].callIds).toEqual(["terms:0", "terms:1"]);
    expect(data.topics[0].chunkIds).toEqual(["c1", "c2"]);
  });

  it("traces a final merged term to its original candidate and exact recorded passage", () => {
    const data = buildTboxEvidence(fixture(), revision(`${prefixes} a:Sensor a owl:Class.`));
    const term = data.terms.find((t) => t.name === "Sensor")!;
    expect(term.inResult).toBe(true);
    expect(term.origins[0]).toMatchObject({ callId: "terms:0", candidate: "PressureSensor" });
    expect(term.citations[0]).toMatchObject({ documentId: "d", chunkId: "c1", start: 0, end: 25 });
    expect(data.terms.find((t) => t.name === "Valve")!.inResult).toBe(false);
  });

  it("does not attach an ambiguous local-name candidate to two different ontology IRIs", () => {
    const data = buildTboxEvidence(fixture(), revision(`${prefixes} a:Sensor a owl:Class. b:Sensor a owl:Class.`));
    const final = data.terms.filter((t) => t.inResult);
    expect(final).toHaveLength(2);
    expect(final.every((t) => t.origins.length === 0)).toBe(true);
    expect(new Set(data.terms.map((t) => t.id)).size).toBe(data.terms.length);
  });

  it("does not rename a manually added result term using a historical merge alias", () => {
    const data = buildTboxEvidence(fixture(), revision(`${prefixes} a:PressureSensor a owl:Class. a:Sensor a owl:Class.`));
    expect(
      data.terms
        .filter((t) => t.inResult)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["PressureSensor", "Sensor"]);
    expect(data.terms.find((t) => t.name === "PressureSensor")!.origins).toHaveLength(0);
    expect(data.terms.find((t) => t.name === "Sensor")!.origins[0].candidate).toBe("PressureSensor");
  });

  it("distinguishes omitted, shortened, overlap-only and unrecorded inputs", () => {
    const data = buildTboxEvidence(fixture());
    const call = data.calls[0];
    const chunk = data.chunks.get("c1")!;
    expect(passageStatus(call, chunk)).toBe("Sent in full");
    expect(passageStatus({ ...call, passages: [] }, chunk)).toBe("Not sent");
    expect(passageStatus({ ...call, passages: undefined }, chunk)).toBe("Not recorded");
    expect(passageStatus({ ...call, passages: [{ ...call.passages![0], text: "Sensor" }] }, chunk)).toBe("Shortened");
    expect(
      passageStatus({ ...call, passages: [{ ...call.passages![0], text: chunk.text.slice(3), start: 3 }] }, { ...chunk, overlap: 3 }),
    ).toBe("Overlap removed");
    expect(passageStatus({ ...call, completed: false }, chunk)).toBe("Pending");
  });

  it("does not fabricate a source location for an unmatched cited quote", () => {
    const report = fixture();
    (report.checkpoints[0].payload as { evidence: { quote: string }[] }).evidence[0].quote = "A passage that is absent.";
    expect(buildTboxEvidence(report).terms.find((t) => t.name === "Sensor")!.citations[0].chunkId).toBeUndefined();
  });

  it("distinguishes a proposed question from recorded generation guidance", () => {
    const report = fixture();
    const req = report.inputs!.requirements as { requirements: { cqs: { status: string }[] } };
    req.requirements.cqs[0].status = "proposed";
    report.checkpoints[0].trace!.input!.requirementsText = "Project purpose only";
    const data = buildTboxEvidence(report);
    expect(data.questions[0]).toMatchObject({ status: "proposed", usedAsGuidance: false, source: "generated" });
    expect(questionMatches(data.questions[0], data.terms).length).toBeGreaterThan(0);
  });

  it("uses recorded call text even when the full historical snapshot is unavailable", () => {
    const report = fixture();
    report.inputs = null;
    const data = buildTboxEvidence(report);
    expect(data.documents.size).toBe(0);
    expect(data.calls[0].passages![0].text).toBe(source.slice(0, source.indexOf("A valve")));
  });

  it("records source offsets when grounding new generation evidence", () => {
    const [evidence] = groundTerms(
      [{ name: "Sensor", kind: "class", quote: "Sensor measures pressure." }],
      [{ text: source, documentId: "d", chunkId: "c1", start: 100 }],
    );
    expect(evidence).toMatchObject({ documentId: "d", chunkId: "c1", start: 100, end: 125, located: true });
  });
});
