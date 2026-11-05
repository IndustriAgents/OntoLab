import { describe, it, expect } from "vitest";
import { Parser, Store, type Term, type Literal } from "n3";
import { parseTBox } from "./tboxParser";
import { serializeABox, serializeABoxQuads, aboxOntologyIri, SOURCE_EVIDENCE_PREDICATE } from "./aboxSerializer";
import { RDF_TYPE, RDFS_LABEL, OWL, OWL_NAMED_INDIVIDUAL, XSD, XSD_STRING } from "./iri";
import type { ABoxResult } from "../../types/abox";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;
const ABOX = "http://ex/onto/abox#";

const TBOX_TTL = `
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://ex/onto> a owl:Ontology ; owl:imports <http://ex/upper> .
:Station a owl:Class .
:Component a owl:Class .
:Sensor a owl:Class ; rdfs:subClassOf :Component .
:partOf a owl:ObjectProperty ; rdfs:domain :Component ; rdfs:range :Station .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
:note a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:string .
:tag a owl:DatatypeProperty ; rdfs:domain :Component .
`;

const tbox = parseTBox(TBOX_TTL);

/** Parse the emitted Turtle back into a store — this alone proves it is valid Turtle. */
function storeOf(turtle: string): Store {
  return new Store(new Parser().parse(turtle));
}

/** Narrow a quad object to a Literal so datatype/language are typed. */
function asLiteral(t: Term): Literal {
  if (t.termType !== "Literal") throw new Error(`expected a Literal, got ${t.termType}`);
  return t;
}

describe("serializeABox — validity", () => {
  it("emits Turtle that re-parses even when datatype hints are sloppy", () => {
    const abox: ABoxResult = {
      individuals: [
        {
          id: "P1",
          classUri: C("Component"),
          dataProperties: [
            { propUri: C("pressure"), value: "600", datatype: "decimal" },
            { propUri: C("pressure"), value: "700", datatype: "xsd:decimal" },
            { propUri: C("pressure"), value: "800", datatype: XSD + "decimal" },
            { propUri: C("tag"), value: "unknown-type", datatype: "banana" },
          ],
        },
      ],
    };
    const { turtle } = serializeABox(abox, tbox);
    expect(() => new Parser().parse(turtle)).not.toThrow();

    const store = storeOf(turtle);
    const values = store.getObjects(ABOX + "P1", C("pressure"), null);
    expect(values).toHaveLength(3);
    for (const v of values) expect(asLiteral(v).datatype.value).toBe(XSD + "decimal");
    // an unrecognised hint degrades to a plain (xsd:string) literal rather than an invalid IRI
    const tag = asLiteral(store.getObjects(ABOX + "P1", C("tag"), null)[0]);
    expect(tag.value).toBe("unknown-type");
    expect(tag.datatype.value).toBe(XSD_STRING);
  });

  it("defaults an omitted datatype to the property's single declared range", () => {
    const { turtle } = serializeABox(
      { individuals: [{ id: "P1", classUri: C("Component"), dataProperties: [{ propUri: C("pressure"), value: "600" }] }] },
      tbox,
    );
    expect(turtle).toContain('"600"^^xsd:decimal');
  });

  it("leaves a value plain when the property declares no range", () => {
    const { turtle } = serializeABox(
      { individuals: [{ id: "P1", classUri: C("Component"), dataProperties: [{ propUri: C("tag"), value: "abc" }] }] },
      tbox,
    );
    expect(turtle).toContain('"abc"');
    expect(turtle).not.toMatch(/"abc"\^\^/);
  });

  it("emits language tags as \"x\"@de", () => {
    const { turtle } = serializeABox(
      {
        individuals: [
          { id: "P1", classUri: C("Component"), dataProperties: [{ propUri: C("note"), value: "Zylinder", lang: "de" }] },
        ],
      },
      tbox,
    );
    expect(turtle).toContain('"Zylinder"@de');
    const lit = asLiteral(storeOf(turtle).getObjects(ABOX + "P1", C("note"), null)[0]);
    expect(lit.language).toBe("de");
  });
});

describe("serializeABox — header, typing and provenance", () => {
  const abox: ABoxResult = {
    individuals: [
      {
        id: "S1",
        classUri: C("Sensor"),
        label: "Sensor 1",
        sourceEvidence: "p. 4: the inductive sensor B1",
        additionalTypes: [C("Component")],
      },
    ],
  };

  it("emits owl:NamedIndividual, the owl:Ontology header, owl:imports and dcterms:source by default", () => {
    const { turtle } = serializeABox(abox, tbox);
    const store = storeOf(turtle);
    const subj = ABOX + "S1";

    expect(store.getObjects(subj, RDF_TYPE, null).map((t) => t.value).sort()).toEqual(
      [C("Sensor"), C("Component"), OWL_NAMED_INDIVIDUAL].sort(),
    );
    expect(store.getObjects(subj, RDFS_LABEL, null)[0].value).toBe("Sensor 1");
    expect(store.getObjects(subj, SOURCE_EVIDENCE_PREDICATE, null)[0].value).toContain("inductive sensor B1");

    const ont = aboxOntologyIri(ABOX);
    expect(ont).toBe("http://ex/onto/abox");
    expect(store.getObjects(ont, RDF_TYPE, null).map((t) => t.value)).toEqual([OWL + "Ontology"]);
    expect(store.getObjects(ont, OWL + "imports", null).map((t) => t.value)).toEqual(["http://ex/onto"]);
  });

  it("suppresses each of them when the options turn them off", () => {
    const { turtle } = serializeABox(abox, tbox, undefined, { header: false, namedIndividuals: false, provenance: false });
    const store = storeOf(turtle);
    const subj = ABOX + "S1";

    expect(store.getObjects(subj, RDF_TYPE, null).map((t) => t.value).sort()).toEqual([C("Component"), C("Sensor")].sort());
    expect(store.getObjects(subj, SOURCE_EVIDENCE_PREDICATE, null)).toHaveLength(0);
    expect(store.getSubjects(RDF_TYPE, OWL + "Ontology", null)).toHaveLength(0);
    expect(turtle).not.toContain("owl:imports");
  });

  it("does not repeat a type listed both as classUri and additionalTypes", () => {
    const { quads } = serializeABoxQuads(
      { individuals: [{ id: "S1", classUri: C("Sensor"), additionalTypes: [C("Sensor")] }] },
      tbox,
      undefined,
      { header: false, namedIndividuals: false },
    );
    expect(quads.filter((q) => q.predicate.value === RDF_TYPE)).toHaveLength(1);
  });
});

describe("serializeABox — identity and references", () => {
  it("honours an explicit iri over minting from the base", () => {
    const { turtle, idToUri } = serializeABox(
      { individuals: [{ id: "S1", classUri: C("Sensor"), iri: "http://external/things#Sensor-One" }] },
      tbox,
    );
    expect(idToUri.get("S1")).toBe("http://external/things#Sensor-One");
    expect(turtle).toContain("http://external/things#Sensor-One");
    expect(turtle).not.toContain(ABOX + "S1");
  });

  it("resolves object-property targets through the same id→IRI map", () => {
    const { turtle } = serializeABox(
      {
        individuals: [
          { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "St1" }] },
          { id: "St1", classUri: C("Station"), iri: "http://external/plant#Line1" },
        ],
      },
      tbox,
    );
    const store = storeOf(turtle);
    expect(store.getObjects(ABOX + "S1", C("partOf"), null).map((t) => t.value)).toEqual(["http://external/plant#Line1"]);
  });

  it("never invents a node for a dangling object-property target", () => {
    const { turtle } = serializeABox(
      { individuals: [{ id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "ghost" }] }] },
      tbox,
    );
    expect(turtle).not.toContain("ghost");
    expect(storeOf(turtle).getQuads(null, C("partOf"), null, null)).toHaveLength(0);
  });

  it("exports a duplicated id exactly once (the first occurrence)", () => {
    const { turtle } = serializeABox(
      {
        individuals: [
          { id: "S1", classUri: C("Sensor"), label: "first" },
          { id: "S1", classUri: C("Station"), label: "second" },
        ],
      },
      tbox,
    );
    const store = storeOf(turtle);
    expect(store.getObjects(ABOX + "S1", RDFS_LABEL, null).map((t) => t.value)).toEqual(["first"]);
    expect(store.getObjects(ABOX + "S1", RDF_TYPE, null).map((t) => t.value)).not.toContain(C("Station"));
  });

  it("honours a base IRI override for minted individuals", () => {
    const { idToUri } = serializeABox({ individuals: [{ id: "S1", classUri: C("Sensor") }] }, tbox, "http://custom/data");
    expect(idToUri.get("S1")).toBe("http://custom/data#S1");
  });

  it("percent-encodes ids so an awkward label still yields parseable Turtle", () => {
    const { turtle, idToUri } = serializeABox({ individuals: [{ id: "Sensor B1 (50%)", classUri: C("Sensor") }] }, tbox);
    expect(idToUri.get("Sensor B1 (50%)")).toBe(ABOX + "Sensor-B1-%2850%25%29");
    expect(() => new Parser().parse(turtle)).not.toThrow();
  });
});

describe("serializeABox — reified provenance", () => {
  const PROVNS = "http://www.w3.org/ns/prov#";
  const OANS = "http://www.w3.org/ns/oa#";
  const RDFNS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const abox: ABoxResult = {
    individuals: [
      {
        id: "s1",
        classUri: C("Station"),
        evidence: [{ quote: "Station S1 sorts parts.", status: "verified", documentId: "d1", start: 10, end: 33, confidence: 0.91 }],
        review: { status: "accepted", by: "auto", runId: "run_1", confidence: 0.91 },
      },
      { id: "c1", classUri: C("Component") },
    ],
  };

  it("makes each evidenced claim a PROV-O statement with a Web Annotation of its quote", () => {
    const { turtle } = serializeABox(abox, tbox, undefined, { provenance: "reified" });
    const store = new Store(new Parser().parse(turtle));
    const stmts = store.getSubjects(RDF_TYPE, `${RDFNS}Statement`, null);
    expect(stmts).toHaveLength(1); // c1 has no evidence and no review: not reified
    const claim = stmts[0];
    expect(store.getObjects(claim, `${RDFNS}object`, null)[0].value).toBe(C("Station"));
    expect(store.getObjects(claim, `${PROVNS}wasGeneratedBy`, null)[0].value).toBe("urn:ontolab:run:run_1");
    expect(store.getObjects(claim, "https://w3id.org/ontolab/vocab#reviewStatus", null)[0].value).toBe("accepted");
    expect(store.getObjects(claim, "https://w3id.org/ontolab/vocab#confidence", null)[0].value).toBe("0.91");
    const ann = store.getObjects(claim, `${PROVNS}wasDerivedFrom`, null)[0];
    expect(store.getObjects(ann, `${OANS}hasSource`, null)[0].value).toBe("urn:ontolab:document:d1");
    const selectors = store.getObjects(ann, `${OANS}hasSelector`, null);
    const exact = selectors.flatMap((s) => store.getObjects(s, `${OANS}exact`, null));
    const start = selectors.flatMap((s) => store.getObjects(s, `${OANS}start`, null));
    expect(exact[0].value).toBe("Station S1 sorts parts.");
    expect(start[0].value).toBe("10");
  });

  it("emits no provenance in 'none' mode", () => {
    const withSource: ABoxResult = { individuals: [{ ...abox.individuals[0], sourceEvidence: "p. 3" }] };
    expect(serializeABox(withSource, tbox, undefined, { provenance: "none" }).turtle).not.toMatch(/dcterms:source|Statement/);
    expect(serializeABox(withSource, tbox).turtle).toMatch(/dcterms:source/);
  });
});
