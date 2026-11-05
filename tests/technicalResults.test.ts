import { describe, expect, it } from "vitest";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { clusterChunks, mergeClasses } from "../server/services/induction.ts";
import { retrieveSchema, scoreTermsDetailed } from "../server/services/schemaRetrieval.ts";
import { findMergeCandidates } from "../server/services/resolution.ts";
import { alignOntologies } from "../server/services/alignment.ts";
import type { TechnicalResult } from "../src/types/research.ts";
import type { DocumentChunk } from "../src/types/project.ts";
import type { Embedder } from "../server/ml/embeddings.ts";
const prefixes =
  "@prefix : <http://example.org/#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .";
const tbox = parseTBox(`${prefixes} :Sensor a owl:Class . :Valve a owl:Class .`);
const vector = (x: number, y: number) => Float32Array.from([x, y]);
const embedder: Embedder = {
  id: "technical-fixture",
  backend: "hash",
  embed: async (texts) => texts.map((text) => (/sensor/i.test(text) ? vector(1, 0) : vector(0, 1))),
};
const trace = (): TechnicalResult => ({ title: "Test", method: "k-means", parameters: {}, rows: [], columns: [] });

describe("recorded numerical evidence", () => {
  it("separates exact cosine from the lexical bonus and records retrieval decisions", async () => {
    const scored = await scoreTermsDetailed(tbox, "Sensor readings", embedder, "technical-test");
    expect(scored.rows[0]).toMatchObject({ maxCosine: 1, lexicalBonus: 0.3, score: 1.3, windowCosines: [1] });
    expect(scored.rows[1]).toMatchObject({ maxCosine: 0, lexicalBonus: 0, score: 0 });
    const retrieved = await retrieveSchema(tbox, "Sensor readings", embedder, "technical-test", { force: true, k: 1 });
    expect(retrieved.tbox.classes.map((c) => c.uri)).toEqual(["http://example.org/#Sensor"]);
    expect(retrieved.technical?.rows[0].decision).toBe("Top-k selection");
    expect(retrieved.technical?.rows[1].decision).toBe("Excluded");
    const bypassed = await retrieveSchema(tbox, "Sensor", null, "technical-test");
    expect(bypassed.technical?.method).toContain("no similarity ranking");
    expect(bypassed.technical?.rows).toEqual([]);
  });
  it("records the actual final centroid comparisons used to assign chunks", async () => {
    const chunks = Array.from(
      { length: 4 },
      (_, i) => ({ id: `c${i}`, documentId: "d", ordinal: i, text: "a".repeat(15000) }) as DocumentChunk,
    );
    const evidence = trace();
    const groups = await clusterChunks(chunks, [vector(1, 0), vector(1, 0), vector(0, 1), vector(0, 1)], evidence);
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([
      ["c0", "c1"],
      ["c2", "c3"],
    ]);
    expect(evidence.parameters.iterations).toBe(8);
    for (const row of evidence.rows) {
      const scores = row.centroidCosines as number[];
      expect(row.assignedCosine).toBe(1);
      expect(scores[row.centroidIndex as number]).toBe(Math.max(...scores));
      expect(groups[(row.assignedTopic as number) - 1].map((c) => c.id)).toContain(row.chunk);
    }
    const one = trace();
    await clusterChunks([chunks[0]], [vector(1, 0)], one);
    expect(one.method).toContain("no cosine");
    expect(one.rows[0]).not.toHaveProperty("assignedCosine");
    const sequential = trace();
    await clusterChunks(chunks, null, sequential);
    expect(sequential.method).toContain("Sequential");
    expect(sequential.rows).toHaveLength(4);
  });
  it("records both rejected and accepted class comparisons and preserves short-circuit decisions", () => {
    const result = mergeClasses(
      [[{ name: "Sensor" }, { name: "Valve" }, { name: "Detector" }, { name: "Sensors" }]],
      [vector(1, 0), vector(0, 1), vector(0.95, Math.sqrt(1 - 0.95 ** 2)), vector(0, 1)],
      new Set(),
    );
    expect(result.classes.map((c) => c.name)).toEqual(["Sensor", "Valve"]);
    expect(result.technical.rows.find((r) => r.proposal === "Valve" && r.retainedClass === "Sensor")).toMatchObject({
      cosine: 0,
      decision: "Keep distinct; continue comparison",
    });
    expect(result.technical.rows.find((r) => r.proposal === "Detector")).toMatchObject({ decision: "Merge into retained class" });
    expect(result.technical.rows.find((r) => r.proposal === "Detector")?.cosine).toBeCloseTo(0.95);
    expect(result.technical.rows.find((r) => r.proposal === "Sensors")).toMatchObject({
      normalizedNameMatch: true,
      cosine: null,
      decision: "Merge into retained class",
    });
  });
  it("records raw entity cosine separately from the weighted combined score", async () => {
    const allSame: Embedder = { id: "same-fixture", backend: "hash", embed: async (texts) => texts.map(() => vector(1, 0)) };
    const result = await findMergeCandidates(
      {
        individuals: [
          { id: "a", label: "Detector", classUri: "http://example.org/#Sensor" },
          { id: "b", label: "Probe", classUri: "http://example.org/#Sensor" },
        ],
      },
      tbox,
      { embedder: allSame },
    );
    expect(result.technical[0].rows[0]).toMatchObject({
      cosine: 1,
      weightedCosine: 0.97,
      score: 0.97,
      decision: "Candidate",
      finalDecision: "pending",
    });
    expect(result.candidates[0].score).toBe(0.97);
  });
  it("retains raw negative alignment cosine while the combined score clamps it", async () => {
    const target = parseTBox(
      prefixes.replace("http://example.org/#", "http://target.org/#") + ' :Sensor a owl:Class; rdfs:comment "opposite" .',
    );
    const opposite: Embedder = {
      id: "opposite-fixture",
      backend: "hash",
      embed: async (texts) => texts.map((t) => vector(t.includes("opposite") ? -1 : 1, 0)),
    };
    const result = await alignOntologies(tbox, target, { embedder: opposite, matchers: { structural: false } });
    const sensor = result.candidates.find((c) => c.source.endsWith("#Sensor"));
    expect(sensor).toMatchObject({ cosine: -1, scores: { semantic: 0, lexical: 1 }, score: 1 });
  });
});
