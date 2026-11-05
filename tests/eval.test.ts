// The evaluation harness's metrics, and the Docling sidecar contract as the
// server consumes it.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { agreement, alignIndividuals, answerCorrect, cqSimilarity, extractionMetrics, inductionMetrics, normValue, prf, resolutionMetrics, tokenJaccard, verifiedShare, type GoldAbox } from "../eval/metrics.ts";
import { parseWithDocling } from "../server/services/parsing.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const NS = "http://g/#";
const TBOX = parseTBox(`
@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Organisation a owl:Class . :Agreement a owl:Class . :Supplier a owl:Class ; rdfs:subClassOf :Organisation .
:isPartyTo a owl:ObjectProperty ; rdfs:domain :Organisation ; rdfs:range :Agreement .
:value a owl:DatatypeProperty ; rdfs:domain :Agreement ; rdfs:range xsd:decimal .
`);

const GOLD: GoldAbox = {
  individuals: [
    { key: "acme", class: "Organisation", label: "Acme Robotics GmbH", aliases: ["Acme"], links: [{ prop: "isPartyTo", target: "sa" }] },
    { key: "beta", class: "Organisation", label: "Beta Foods Ltd" },
    { key: "sa", class: "Agreement", label: "Supply Agreement SA-1", data: [{ prop: "value", value: 12000 }] },
  ],
};

describe("eval metrics", () => {
  const pred: ABoxResult = {
    individuals: [
      { id: "acme", classUri: `${NS}Organisation`, label: "Acme Robotics", objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] },
      { id: "acme-2", classUri: `${NS}Organisation`, label: "ACME" },
      { id: "sa", classUri: `${NS}Organisation`, label: "Supply Agreement SA-1", dataProperties: [{ propUri: `${NS}value`, value: "12,000 EUR" }] },
      { id: "ghost", classUri: `${NS}Agreement`, label: "Zorblax Deal" },
    ],
  };

  it("computes precision/recall and F1", () => {
    expect(prf(2, 4, 3)).toMatchObject({ precision: 0.5, recall: 2 / 3 });
    expect(prf(0, 0, 0).f1).toBe(0);
  });

  it("normalises values for comparison", () => {
    expect(normValue("12,000 EUR")).toBe("12000");
    expect(normValue(12000)).toBe("12000");
    expect(normValue("Yes")).toBe("true");
  });

  it("aligns predictions to gold one-to-one and scores extraction", () => {
    const al = alignIndividuals(pred, GOLD);
    expect(al.oneToOne.get("acme")).toBe("acme");
    expect(al.goldToPreds.get("acme")).toEqual(expect.arrayContaining(["acme", "acme-2"]));
    const m = extractionMetrics(pred, GOLD, TBOX, "Acme Robotics GmbH and Beta Foods Ltd signed Supply Agreement SA-1 worth 12,000 EUR.");
    expect(m.individuals).toMatchObject({ tp: 2, predicted: 4, gold: 3 });
    expect(m.typingAccuracy).toBe(0.5); // the agreement was typed Organisation
    expect(m.assertions.tp).toBe(2);
    expect(m.ontologyConformance).toBe(1);
    expect(m.hallucination.subject).toBe(0);
  });

  it("measures duplicates and wrong merges against gold clusters", () => {
    expect(resolutionMetrics(pred, GOLD).duplicateRate).toBeGreaterThan(0);
    const merged: ABoxResult = { individuals: [{ ...pred.individuals[0], mergedFrom: ["acme-2"] }, pred.individuals[2]] };
    const after = resolutionMetrics(merged, GOLD, pred);
    expect(after).toMatchObject({ duplicateRate: 0, wrongMergeRate: 0, merges: 1 });
    const bad: ABoxResult = { individuals: [{ ...pred.individuals[0], mergedFrom: ["sa"] }] };
    expect(resolutionMetrics(bad, GOLD, pred).wrongMergeRate).toBe(1);
  });

  it("counts verified evidence and agreement with human labels", () => {
    const v = verifiedShare({ individuals: [{ id: "a", classUri: "c", evidence: [{ quote: "q", status: "verified" }], dataProperties: [{ propUri: "p", value: "1" }] }] });
    expect(v).toMatchObject({ claims: 2, verified: 1, share: 0.5 });
    expect(agreement([true, true, false, false], [true, true, false, false])).toMatchObject({ accuracy: 1, kappa: 1 });
    expect(agreement([true, false], [false, true]).kappa).toBeLessThan(0);
  });

  it("scores an induced ontology against the gold one", () => {
    const induced = parseTBox(`
@prefix : <http://i/#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Organization a owl:Class . :Agreement a owl:Class . :Supplier a owl:Class ; rdfs:subClassOf :Organization . :Invoice a owl:Class .
:isPartyTo a owl:ObjectProperty .`);
    const m = inductionMetrics(induced, TBOX);
    expect(m.classes.literal.tp).toBe(2); // Agreement, Supplier
    expect(m.classes.fuzzy.tp).toBe(3); // + Organization ≈ Organisation
    expect(m.graph.tp).toBe(1);
    expect(m.properties.literal.tp).toBe(1);
  });

  it("compares generated with approved competency questions", () => {
    const r = cqSimilarity(["Which parties signed the supply agreement?", "What colour is the sky?"], ["Which parties signed each supply agreement?"], tokenJaccard, 0.5);
    expect(r.keptShare).toBe(0.5);
    expect(r.meanBest).toBeGreaterThan(0.5);
    expect(answerCorrect("The supplier is Acme Robotics.", ["acme robotics"])).toBe(true);
  });
});

describe("Docling sidecar contract", () => {
  it("maps the sidecar response and drops spans outside the text", async () => {
    const text = "# Title\n\nBody text.\n";
    const server = http.createServer((req, res) => {
      expect(req.headers["x-file-name"]).toBe("deck.pptx");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text,
          pages: [{ page: 1, start: 0, end: text.length }],
          sections: [
            { level: 1, title: "Title", path: ["Title"], start: 0, end: text.length },
            { level: 2, title: "Bad", path: ["Bad"], start: 5, end: 9999 },
          ],
          tables: [],
          ocr: true,
          parser: "docling",
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const parsed = await parseWithDocling("deck.pptx", Buffer.from("x"), url);
      expect(parsed).toMatchObject({ text, parser: "docling", ocr: true });
      expect(parsed.sections.map((s) => s.title)).toEqual(["Title"]);
    } finally {
      server.close();
    }
  });
});

describe("research metrics", async () => {
  const { axiomMetrics, calibration, claimScores, cqTermCoverage, llms4olMetrics, alignmentMetrics, extensionRecovery, leafClasses } = await import("../eval/research.ts");
  const { loadOaeiAlignment } = await import("../eval/oaei.ts");
  const P = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`;
  const gold = parseTBox(`@prefix : <${NS}> . ${P}
    :Organisation a owl:Class ; owl:disjointWith :Agreement . :Agreement a owl:Class . :Supplier rdfs:subClassOf :Organisation . :Buyer rdfs:subClassOf :Organisation .
    :isPartyTo a owl:ObjectProperty ; rdfs:domain :Organisation ; rdfs:range :Agreement .`);
  const pred = parseTBox(`@prefix : <http://p/#> . ${P}
    :Organization a owl:Class . :Agreement a owl:Class ; owl:disjointWith :Organization . :Supplier rdfs:subClassOf :Organization . :Vendor rdfs:subClassOf :Supplier .
    :isPartyTo a owl:ObjectProperty ; rdfs:domain :Organization ; rdfs:range :Agreement .`);

  it("scores axioms per type after mapping names (Organization ~ Organisation)", () => {
    const m = axiomMetrics(pred, gold);
    expect(m.asserted.disjointWith).toMatchObject({ tp: 1, predicted: 1, gold: 1 });
    expect(m.asserted.subClassOf).toMatchObject({ tp: 1, predicted: 2, gold: 2 });
    expect(m.asserted.domain.tp).toBe(1);
    expect(m.entailedSubsumption.tp).toBe(1);
  });

  it("measures schema-level CQ coverage and the LLMs4OL tasks", () => {
    const cqs = [{ sparql: `PREFIX : <${NS}> SELECT ?o WHERE { ?o a :Supplier ; :isPartyTo ?a }` }, { sparql: `PREFIX : <${NS}> SELECT ?b WHERE { ?b a :Buyer }` }];
    expect(cqTermCoverage(cqs, pred, gold)).toEqual({ covered: 1, total: 2, share: 0.5 });
    const l = llms4olMetrics(pred, gold);
    expect(l.relations).toMatchObject({ tp: 1, predicted: 1, gold: 1 });
    expect(l.taxonomy.tp).toBe(1); // Supplier < Organisation
  });

  it("computes calibration and the precision of auto-accepted facts", () => {
    const scored = claimScores(
      {
        individuals: [
          { id: "acme", classUri: `${NS}Organisation`, label: "Acme Robotics", evidence: [{ quote: "q", status: "verified", confidence: 0.9 }], review: { status: "accepted", by: "auto" } },
          { id: "sa", classUri: `${NS}Organisation`, label: "Supply Agreement SA-1", evidence: [{ quote: "q", status: "verified", confidence: 0.8 }], review: { status: "accepted", by: "auto" } },
        ],
      },
      GOLD,
    );
    expect(scored.map((s) => s.correct)).toEqual([true, false]);
    const c = calibration(scored);
    expect(c.autoAcceptedPrecision).toBe(0.5);
    expect(c.brier).toBeCloseTo((0.1 ** 2 + 0.8 ** 2) / 2, 5);
    expect(c.selective.find((s) => s.threshold === 0.9)).toMatchObject({ coverage: 0.5, accuracy: 1 });
  });

  it("reads an OAEI reference alignment and scores mappings against it", async () => {
    const ref = await loadOaeiAlignment(`<?xml version="1.0"?>
<rdf:RDF xmlns="http://knowledgeweb.semanticweb.org/heterogeneity/alignment#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <Alignment><map><Cell><entity1 rdf:resource="http://a#Person"/><entity2 rdf:resource="http://b#Human"/><relation>=</relation><measure>1.0</measure></Cell></map>
  <map><Cell><entity1 rdf:resource="http://a#Paper"/><entity2 rdf:resource="http://b#Document"/><relation>&lt;</relation></Cell></map></Alignment>
</rdf:RDF>`);
    expect(ref).toHaveLength(2);
    const m = alignmentMetrics(
      [
        { source: "http://a#Person", target: "http://b#Human", relation: "equivalent" },
        { source: "http://a#Paper", target: "http://b#Document", relation: "broader" },
        { source: "http://a#Review", target: "http://b#Document", relation: "candidate" },
      ],
      ref,
    );
    expect(m).toMatchObject({ tp: 2, predicted: 2, gold: 2 });
    expect(m.equivalenceOnly).toMatchObject({ tp: 1, predicted: 1, gold: 1 });
  });

  it("scores held-out term recovery for the extension protocol", () => {
    expect(leafClasses(gold).map((u) => u.replace(NS, ""))).toEqual(["Buyer", "Supplier"]);
    const r = extensionRecovery(["Buyer", "Organization"], ["Buyer"], ["Organisation", "Agreement"]);
    expect(r.recovery).toMatchObject({ tp: 1, predicted: 2, gold: 1 });
    expect(r.duplicateRate).toBe(0.5);
  });
});
