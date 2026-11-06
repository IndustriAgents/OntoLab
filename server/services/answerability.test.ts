import { describe, it, expect } from "vitest";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import { applyRenames, assessSchema, lexicalMentions, schemaPath, sparqlIris, staleIris } from "./answerability.ts";
import { markDuplicates, samplePaths } from "./requirements.ts";
import type { CompetencyQuestion } from "../../src/types/project.ts";

const NS = "http://ex/u#";
const U = (n: string) => NS + n;
const TBOX = parseTBox(`
@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Person a owl:Class . :Researcher rdfs:subClassOf :Person ; rdfs:label "researcher" .
:Organization a owl:Class . :University rdfs:subClassOf :Organization .
:ResearchProject a owl:Class ; rdfs:label "research project" .
:Funder a owl:Class .
:worksAt a owl:ObjectProperty ; rdfs:domain :Person ; rdfs:range :Organization .
:participatesIn a owl:ObjectProperty ; rdfs:domain :Researcher ; rdfs:range :ResearchProject .
:title a owl:DatatypeProperty ; rdfs:domain :ResearchProject ; rdfs:range xsd:string .
:relatedTo a owl:ObjectProperty .
`);

describe("schemaPath", () => {
  it("links classes through properties, inheriting along subclass edges", () => {
    // Researcher worksAt (declared on Person) a University (a subclass of Organization)
    const r = schemaPath([U("Researcher"), U("worksAt"), U("University")], TBOX);
    expect(r.connected).toBe(true);
    expect(r.path).toEqual(expect.arrayContaining([U("Researcher"), U("Person"), U("worksAt"), U("Organization"), U("University")]));
  });

  it("reports terms that nothing links", () => {
    const r = schemaPath([U("ResearchProject"), U("Funder")], TBOX);
    expect(r.connected).toBe(false);
    expect(r.disconnected).toEqual([U("Funder")]);
  });

  it("lets a property without domain/range bridge only the classes the question names", () => {
    expect(schemaPath([U("Funder"), U("relatedTo"), U("ResearchProject")], TBOX).connected).toBe(true);
    // relatedTo is not mentioned, so it does not make Funder reachable
    expect(schemaPath([U("Funder"), U("University")], TBOX).connected).toBe(false);
  });
});

describe("assessSchema and lexical mentions", () => {
  it("maps names and labels, preferring the longer match", () => {
    const m = lexicalMentions("Which researchers participate in each research project?", TBOX);
    // "research project" wins over a bare "project"; "participate in" matches participatesIn
    expect(m.map((x) => x.uri).sort()).toEqual([U("ResearchProject"), U("Researcher"), U("participatesIn")]);
  });

  it("separates answerable, partial and unsupported questions", () => {
    expect(assessSchema([{ text: "researcher", role: "class", uri: U("Researcher") }, { text: "research project", role: "class", uri: U("ResearchProject") }], TBOX).schema).toBe("answerable");
    const partial = assessSchema([{ text: "research project", role: "class", uri: U("ResearchProject") }, { text: "grant", role: "class" }], TBOX);
    expect(partial).toMatchObject({ schema: "partial", missing: ["grant"] });
    expect(assessSchema([{ text: "grant", role: "class" }], TBOX).schema).toBe("unsupported");
    // a term that does not exist (any more) counts as missing
    expect(assessSchema([{ text: "lab", role: "class", uri: U("Lab") }], TBOX).missing).toEqual(["lab"]);
  });
});

describe("stored SPARQL", () => {
  const q = `PREFIX u: <${NS}>
SELECT ?r WHERE { ?r a u:Researcher ; u:memberOf ?o . ?o a <${NS}Organization> }`;

  it("finds IRIs the ontology no longer declares, in its own namespace only", () => {
    expect(sparqlIris(q)).toEqual(expect.arrayContaining([U("Researcher"), U("memberOf"), U("Organization")]));
    expect(staleIris(q, TBOX)).toEqual([U("memberOf")]);
  });

  it("treats punctuation in renamed terms literally", () => {
    const input = "PREFIX ex: <https://example.org/> SELECT * WHERE { ?s ex:old.name ?o . ?s ex:oldXname ?v }";
    const result = applyRenames(input, [{ from: "https://example.org/old.name", to: "https://example.org/new.name" }]);
    expect(result).toBe(input.replace("ex:old.name", "ex:new.name"));
  });

  it("rewrites renamed terms in both prefixed and full form", () => {
    const out = applyRenames(q, [
      { from: U("memberOf"), to: U("worksAt") },
      { from: U("Organization"), to: U("University") },
    ]);
    expect(out).toContain("u:worksAt ?o");
    expect(out).toContain(`<${NS}University>`);
    expect(staleIris(out, TBOX)).toEqual([]);
  });
});

describe("questions from the ontology", () => {
  it("samples schema paths across properties", () => {
    const paths = samplePaths(TBOX);
    expect(paths).toContain("Person —worksAt→ Organization");
    expect(paths).toContain("ResearchProject has title");
  });

  it("marks semantic duplicates (lexical fallback without embeddings)", async () => {
    const cq = (id: string, text: string): CompetencyQuestion => ({ id, text, status: "proposed", source: "generated" });
    const out = await markDuplicates([cq("b", "Which researchers work at a university?"), cq("c", "Which researchers work at a University"), cq("d", "Who funds projects?")], [cq("a", "Which researchers work at a university?!")], null);
    expect(out.map((x) => x.dupOf)).toEqual(["a", "a", undefined]);
  });
});

describe("NLI premise context", () => {
  it("widens a quote to the sentence before and after it", async () => {
    const { contextAround } = await import("./verification.ts");
    const text = "Intro line. The pump P-101 feeds tank T1. It runs at 3 bar. Unrelated closing words here.";
    const start = text.indexOf("It runs");
    const out = contextAround(text, start, start + "It runs at 3 bar.".length);
    expect(out).toBe("The pump P-101 feeds tank T1. It runs at 3 bar. Unrelated closing words here.");
    // too long a window falls back to the quote itself
    expect(contextAround(text, start, start + 16, 10)).toBe("It runs at 3 bar");
  });
});
