import { describe, it, expect } from "vitest";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import type { RevisionContent, TermProposal } from "../../src/types/project.ts";
import type { Embedder } from "../ml/embeddings.ts";
import { classifyProposals, proposalsToContent } from "./proposals.ts";

const NS = "http://ex/p#";
const TTL = `@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Organization a owl:Class ; rdfs:comment "A company or institution that employs people." .
:Researcher a owl:Class ; rdfs:comment "A person who does research." .
:owner a owl:ObjectProperty .`;
const TBOX = parseTBox(TTL);

const proposal = (name: string, kind: TermProposal["kind"], extra: Partial<TermProposal> = {}): TermProposal => ({
  id: name,
  kind,
  name,
  definition: "",
  count: 1,
  variants: [],
  examples: [],
  status: "open",
  ...extra,
});

/** A stand-in embedder: texts sharing the word "employ" are the same idea. */
const fake: Embedder = {
  id: "fake",
  backend: "hash",
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(3);
      if (/employ/i.test(t)) v[0] = 1;
      else if (/research/i.test(t)) v[1] = 1;
      else v[2] = 1;
      return v;
    });
  },
};

describe("classifyProposals", () => {
  it("tells synonyms, specialisations, clashes and new terms apart", async () => {
    const out = await classifyProposals(
      [
        proposal("Employer", "class", { definition: "A company that employs staff." }),
        proposal("DoctoralResearcher", "class", { definition: "A doctoral student doing research." }),
        proposal("Owner", "class", { definition: "Someone who owns a thing." }),
        proposal("Grant", "class", { definition: "Money awarded for a project." }),
        proposal("Lab", "class", { parent: "Organization", definition: "A place." }),
      ],
      TBOX,
      fake,
    );
    expect(out.map((p) => [p.name, p.relation, p.match?.uri.replace(NS, "")])).toEqual([
      ["Employer", "synonym", "Organization"],
      ["DoctoralResearcher", "specialization", "Researcher"],
      ["Owner", "conflict", "owner"],
      ["Grant", "new", "Organization"],
      ["Lab", "specialization", "Organization"],
    ]);
    expect(out[1].parent).toBe("Researcher");
  });
});

describe("proposalsToContent", () => {
  it("adds a synonym as an alternative label instead of a duplicate class", () => {
    const base: RevisionContent = { modules: [{ id: "m1", name: "core.ttl", turtle: TTL }], abox: null, baseIri: "" };
    const { content } = proposalsToContent(base, TBOX, [
      proposal("Employer", "class", { relation: "synonym", match: { uri: NS + "Organization", score: 0.95 } }),
      proposal("DoctoralResearcher", "class", { relation: "specialization", parent: "Researcher", match: { uri: NS + "Researcher", score: 0.8 } }),
    ]);
    const ext = content.modules.find((m) => m.name === "extensions.ttl")!.turtle;
    expect(ext).toMatch(/altLabel "Employer"/);
    const m = parseTBox(ext);
    expect(m.classes.map((c) => c.uri)).toContain(NS + "DoctoralResearcher");
    expect(m.classes.map((c) => c.uri)).not.toContain(NS + "Employer");
    expect(m.subClassOf[NS + "DoctoralResearcher"]).toEqual([NS + "Researcher"]);
  });
});
