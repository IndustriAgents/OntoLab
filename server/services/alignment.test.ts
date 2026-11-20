import { describe, it, expect } from "vitest";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import type { AlignmentMapping } from "../../src/types/project.ts";
import type { Embedder } from "../ml/embeddings.ts";
import { alignOntologies, coherentSubset, mappingTurtle, relativeSimilarity } from "./alignment.ts";

const P = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`;
const A = "http://ex/a#";
const B = "http://ex/b#";

/** Vectors by keyword: SportsCar and Roadster are only moderately alike (cosine 0.5). */
const fake: Embedder = {
  id: "fake",
  backend: "hash",
  async embed(texts) {
    return texts.map((t) => {
      if (/sports ?car/i.test(t)) return Float32Array.from([1, 0, 0]);
      if (/roadster/i.test(t)) return Float32Array.from([0.5, 0.866, 0]);
      return Float32Array.from([0, 0, 1]);
    });
  },
};

describe("alignOntologies", () => {
  const source = parseTBox(`@prefix : <${A}> . ${P} :Vehicle a owl:Class . :SportsCar rdfs:subClassOf :Vehicle .`);
  const target = parseTBox(`@prefix : <${B}> . ${P} :Vehicle a owl:Class . :Roadster rdfs:subClassOf :Vehicle .`);

  it("reports unprocessed terms separately and supports complete source coverage", async () => {
    const body = Array.from({ length: 151 }, (_, i) => `:Class${i} a owl:Class .`).join("\n") + "\n:reading a owl:DatatypeProperty .";
    const source = parseTBox(`@prefix : <${A}> . ${P} ${body}`);
    const target = parseTBox(`@prefix : <${B}> . ${P} ${body}`);
    const limited = await alignOntologies(source, target, { embedder: null, matchers: { semantic: false, structural: false } });
    expect(limited.diagnostics).toMatchObject({ sourceTerms: 152, processedSourceTerms: 150 });
    expect(limited.diagnostics.coverage!.filter((c) => c.state === "not_processed")).toHaveLength(2);
    expect(limited.diagnostics.coverage!.find((c) => c.source === A + "reading")!.state).toBe("not_processed");
    const full = await alignOntologies(source, target, {
      embedder: null,
      maxSource: null,
      matchers: { semantic: false, structural: false },
    });
    expect(full.diagnostics.processedSourceTerms).toBe(152);
    expect(full.diagnostics.parameters.maxSource).toBeNull();
    expect(full.diagnostics.coverage!.every((c) => c.state === "proposed")).toBe(true);
    expect(full.mappings.some((m) => m.source === A + "reading")).toBe(true);
  });

  it("does not confuse no candidate with unprocessed, or match object properties to datatype properties", async () => {
    const source = parseTBox(`@prefix : <${A}> . ${P} :reading a owl:ObjectProperty .`);
    const target = parseTBox(`@prefix : <${B}> . ${P} :reading a owl:DatatypeProperty .`);
    const result = await alignOntologies(source, target, { embedder: null });
    expect(result.mappings).toEqual([]);
    expect(result.diagnostics.coverage).toEqual([{ source: A + "reading", state: "no_candidate", candidates: 0 }]);
    expect(result.diagnostics.processedSourceTerms).toBe(1);
  });

  it("lets corresponding neighbours lift a weak match (structural matcher)", async () => {
    const { mappings } = await alignOntologies(source, target, { embedder: fake });
    const car = mappings.find((m) => m.source === A + "SportsCar");
    expect(car).toMatchObject({ target: B + "Roadster", relation: "candidate", verified: false });
    expect(car!.scores).toMatchObject({ semantic: 0.5, structural: 1 });
    expect(car!.score).toBeGreaterThanOrEqual(0.55);
    // without the structural matcher the pair stays below the candidate threshold
    const flat = await alignOntologies(source, target, { embedder: fake, matchers: { structural: false } });
    expect(flat.mappings.some((m) => m.source === A + "SportsCar")).toBe(false);
  });

  it("never turns an unverified pair into an equivalence", async () => {
    const { mappings } = await alignOntologies(source, target, { embedder: fake });
    const v = mappings.find((m) => m.source === A + "Vehicle")!;
    expect(v.relation).toBe("candidate");
    expect(mappingTurtle([v])).toMatch(/skos\/core#closeMatch/);
    expect(mappingTurtle([v])).not.toMatch(/equivalentClass/);
  });

  it("uses the model's verdict when verified, including a weak 'related'", async () => {
    const { mappings } = await alignOntologies(source, target, { embedder: fake, call: { provider: "mock", model: "mock-1" } });
    expect(mappings.find((m) => m.source === A + "Vehicle")).toMatchObject({ relation: "equivalent", verified: true });
    const related: AlignmentMapping = { ...mappings[0], relation: "related" };
    expect(mappingTurtle([related])).toMatch(/relatedMatch/);
  });
});

describe("relative semantic calibration", () => {
  it("scores how far a pair stands out from its neighbourhood", () => {
    expect(relativeSimilarity(1, 0.8)).toBe(1);
    expect(relativeSimilarity(0.8, 0.8)).toBe(0);
    expect(relativeSimilarity(0.7, 0.8)).toBe(0);
    expect(relativeSimilarity(0.9, 0.8)).toBeCloseTo(0.5, 6);
    // the same standing-out on a model whose unrelated texts sit lower scores the same
    expect(relativeSimilarity(0.7, 0.4)).toBeCloseTo(0.5, 6);
  });

  it("keeps every candidate for verification but does not score look-alike pairs as matches", async () => {
    // high cosines everywhere (0.72–0.93), as with models whose cosines are compressed,
    // but each source is equally close to two targets: no pair stands out
    const angle: Record<string, number> = { Author: 0, Venue: 120, Fee: 240, Writer: 60, Location: 180, Price: 300 };
    const flat: Embedder = {
      id: "flat",
      backend: "hash",
      async embed(texts) {
        return texts.map((t) => {
          const deg = Object.entries(angle).find(([k]) => t.includes(k))?.[1] ?? 0;
          const v = Float32Array.from([1, 0.4 * Math.cos((deg * Math.PI) / 180), 0.4 * Math.sin((deg * Math.PI) / 180)]);
          const n = Math.hypot(...v);
          return v.map((x) => x / n);
        });
      },
    };
    const s = parseTBox(`@prefix : <${A}> . ${P} :Author a owl:Class . :Venue a owl:Class . :Fee a owl:Class .`);
    const t = parseTBox(`@prefix : <${B}> . ${P} :Writer a owl:Class . :Location a owl:Class . :Price a owl:Class .`);
    const raw = await alignOntologies(s, t, { embedder: flat, matchers: { lexical: false, structural: false }, semanticCalibration: "raw" });
    const rel = await alignOntologies(s, t, { embedder: flat, matchers: { lexical: false, structural: false }, semanticCalibration: "relative" });
    expect(raw.candidates.length).toBeGreaterThan(3);
    // the same pairs still reach verification (retrieval uses the raw cosine) …
    expect(rel.candidates.map((c) => `${c.source} ${c.target}`).sort()).toEqual(raw.candidates.map((c) => `${c.source} ${c.target}`).sort());
    // … but none scores like a confident match without a model
    expect(Math.max(...rel.candidates.map((c) => c.score))).toBeLessThan(0.55);
    expect(Math.min(...raw.candidates.map((c) => c.score))).toBeGreaterThan(0.9);
    expect(rel.diagnostics.parameters.semanticCalibration).toBe("relative");
  });
});

describe("coherentSubset", () => {
  const mine = { name: "mine.ttl", turtle: `@prefix : <${A}> . ${P} :Person owl:disjointWith :Organization .` };
  const theirs = {
    name: "std.ttl",
    turtle: `@prefix : <${B}> . ${P} :Human rdfs:subClassOf :Agent . :Company rdfs:subClassOf :Agent . :Founder rdfs:subClassOf :Human, :Company .`,
  };
  const mapping = (id: string, source: string, target: string, score: number): AlignmentMapping => ({
    id,
    source,
    target,
    kind: "class",
    relation: "equivalent",
    score,
    verified: true,
    rationale: "",
  });

  it("holds back a mapping that makes a class unsatisfiable, with the reason", () => {
    const chosen = [
      mapping("m1", A + "Person", B + "Human", 0.95),
      mapping("m2", A + "Organization", B + "Company", 0.9),
      mapping("m3", A + "Agent", B + "Agent", 0.5),
    ];
    const { accepted, conflicts } = coherentSubset([mine, theirs], chosen);
    expect(accepted.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(conflicts.map((m) => m.id)).toEqual(["m2"]);
    expect(conflicts[0].conflict!.unsat).toContain(B + "Founder");
    expect(conflicts[0].conflict!.explanation.join(" | ")).toMatch(/disjoint/);
  });
});
