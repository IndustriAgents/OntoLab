import { describe, it, expect } from "vitest";
import { parseABoxTurtle } from "./aboxFromTurtle";
import { serializeABox } from "./aboxSerializer";
import { parseTBox } from "./tboxParser";
import { XSD } from "./iri";
import type { ABoxResult } from "../../types/abox";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;
const ABOX = "http://ex/onto/abox#";

const tbox = parseTBox(`
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
`);

const HEAD = `
@prefix : <${ABOX}> .
@prefix onto: <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
`;

describe("parseABoxTurtle", () => {
  it("throws on invalid Turtle", () => {
    expect(() => parseABoxTurtle("this is not turtle")).toThrow(/Turtle parse error/);
  });

  it("keeps the full IRI and preserves the id's case", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}Sensor-B1> a onto:Sensor ; rdfs:label "Sensor B1" .
    `);
    expect(individuals).toHaveLength(1);
    expect(individuals[0].iri).toBe(ABOX + "Sensor-B1");
    expect(individuals[0].id).toBe("Sensor-B1");
    expect(individuals[0].id).not.toBe("sensor-b1");
    expect(individuals[0].classUri).toBe(C("Sensor"));
    expect(individuals[0].label).toBe("Sensor B1");
  });

  it("decodes percent-encoded local names back into the id", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}Sensor-B1-%2850%25%29> a onto:Sensor .
    `);
    expect(individuals[0].id).toBe("Sensor-B1-(50%)");
  });

  it("skips the owl:Ontology header and schema subjects", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <http://ex/onto/abox> a owl:Ontology ; owl:imports <http://ex/onto> ; rdfs:comment "header" .
      onto:Sensor a owl:Class ; rdfs:label "Sensor" .
      onto:partOf a owl:ObjectProperty .
      <${ABOX}S1> a onto:Sensor .
    `);
    expect(individuals.map((i) => i.id)).toEqual(["S1"]);
  });

  it("does not turn a schema subject into an object-property target", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      onto:Station a owl:Class .
      <${ABOX}S1> a onto:Sensor ; onto:partOf onto:Station .
    `);
    expect(individuals).toHaveLength(1);
    expect(individuals[0].objectProperties).toEqual([]);
  });

  it("keeps datatypes and language tags, dropping the redundant xsd:string", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor ;
        onto:pressure "600"^^xsd:decimal ;
        onto:note "Zylinder"@de ;
        onto:note "plain" ;
        onto:note "typed"^^xsd:string .
    `);
    const dps = individuals[0].dataProperties!;
    expect(dps).toEqual(
      expect.arrayContaining([
        { propUri: C("pressure"), value: "600", datatype: XSD + "decimal" },
        { propUri: C("note"), value: "Zylinder", lang: "de" },
        { propUri: C("note"), value: "plain" },
        { propUri: C("note"), value: "typed" },
      ]),
    );
    expect(dps).toHaveLength(4);
  });

  it("maps dcterms:source back to sourceEvidence", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor ; dcterms:source "p. 4: the inductive sensor B1" .
    `);
    expect(individuals[0].sourceEvidence).toBe("p. 4: the inductive sensor B1");
    expect(individuals[0].dataProperties).toEqual([]);
  });

  it("puts extra rdf:types into additionalTypes and ignores owl:NamedIndividual", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor , owl:NamedIndividual , onto:Component .
    `);
    expect(individuals[0].classUri).toBe(C("Sensor"));
    expect(individuals[0].additionalTypes).toEqual([C("Component")]);
  });

  it("disambiguates two IRIs that share a local name into distinct ids", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <http://a/data#Pump> a onto:Component ; rdfs:label "A" .
      <http://b/data#Pump> a onto:Component ; rdfs:label "B" .
    `);
    expect(individuals.map((i) => i.id)).toEqual(["Pump", "Pump-2"]);
    expect(individuals.map((i) => i.iri)).toEqual(["http://a/data#Pump", "http://b/data#Pump"]);
    expect(individuals.map((i) => i.label)).toEqual(["A", "B"]);
  });

  it("does not keep a bare object-property target as an individual (the link dangles)", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor ; onto:partOf <${ABOX}Line1> .
    `);
    // Line1 has no statements of its own, so it is filtered out; the reference
    // survives on S1 and is reported by validateABox as a dangling target.
    expect(individuals.map((i) => i.id)).toEqual(["S1"]);
    expect(individuals[0].objectProperties).toEqual([{ propUri: C("partOf"), targetId: "Line1" }]);
  });

  it("keeps a target that has statements of its own", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor ; onto:partOf <${ABOX}Line1> .
      <${ABOX}Line1> a onto:Station .
    `);
    expect(individuals.map((i) => i.id)).toEqual(["S1", "Line1"]);
    expect(individuals[0].objectProperties).toEqual([{ propUri: C("partOf"), targetId: "Line1" }]);
  });

  it("drops subjects with no type, properties or label", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}Empty> rdfs:label "only a label" .
      <${ABOX}S1> a onto:Sensor .
    `);
    expect(individuals.map((i) => i.id)).toEqual(["S1"]);
  });

  it("prefers an @en label over other tags", () => {
    const { individuals } = parseABoxTurtle(`${HEAD}
      <${ABOX}S1> a onto:Sensor ; rdfs:label "Sensor"@de , "The sensor"@en .
    `);
    expect(individuals[0].label).toBe("The sensor");
  });
});

describe("serializeABox → parseABoxTurtle → serializeABox round-trip", () => {
  const abox: ABoxResult = {
    individuals: [
      {
        id: "S1",
        classUri: C("Sensor"),
        label: "Sensor B1",
        additionalTypes: [C("Component")],
        sourceEvidence: "p. 4: the inductive sensor B1",
        dataProperties: [
          { propUri: C("pressure"), value: "600", datatype: "decimal" },
          { propUri: C("note"), value: "Zylinder", lang: "de" },
          { propUri: C("note"), value: "plain text" },
        ],
        objectProperties: [{ propUri: C("partOf"), targetId: "Line 1" }],
      },
      { id: "Line 1", classUri: C("Station"), label: "Line 1" },
    ],
  };

  const first = serializeABox(abox, tbox).turtle;
  const reparsed = parseABoxTurtle(first);
  const second = serializeABox(reparsed, tbox).turtle;

  it("produces byte-identical Turtle on the second pass", () => {
    expect(second).toBe(first);
  });

  it("preserves the individuals, their IRIs and their values", () => {
    // The IRI is the identity that survives; the id is re-derived from the local
    // name, so "Line 1" comes back as "Line-1" — harmless because the IRI is stable.
    expect(reparsed.individuals.map((i) => i.id)).toEqual(["S1", "Line-1"]);
    expect(reparsed.individuals[0].iri).toBe(ABOX + "S1");
    expect(reparsed.individuals[1].iri).toBe(ABOX + "Line-1");
    expect(reparsed.individuals[0].sourceEvidence).toBe("p. 4: the inductive sensor B1");
    expect(reparsed.individuals[0].dataProperties).toEqual([
      { propUri: C("pressure"), value: "600", datatype: XSD + "decimal" },
      { propUri: C("note"), value: "Zylinder", lang: "de" },
      { propUri: C("note"), value: "plain text" },
    ]);
    expect(reparsed.individuals[0].objectProperties).toEqual([{ propUri: C("partOf"), targetId: "Line-1" }]);
  });

  it("is stable for a third pass too", () => {
    expect(serializeABox(parseABoxTurtle(second), tbox).turtle).toBe(first);
  });
});
