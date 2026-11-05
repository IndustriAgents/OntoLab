import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseTBox, mergeTBox } from "./tboxParser";
import { XSD, XSD_STRING } from "./iri";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;

const PREAMBLE = `
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const parse = (body: string, base?: string) => parseTBox(PREAMBLE + body, base);

describe("parseTBox — declarations", () => {
  it("collects classes and both property kinds", () => {
    const m = parse(`
      :Machine a owl:Class .
      :Part a owl:Class .
      :hasPart a owl:ObjectProperty ; rdfs:domain :Machine ; rdfs:range :Part .
      :serial a owl:DatatypeProperty ; rdfs:domain :Part ; rdfs:range xsd:string .
    `);
    expect(m.classes.map((c) => c.uri)).toEqual([C("Machine"), C("Part")]);
    expect(m.objectProps.map((p) => p.uri)).toEqual([C("hasPart")]);
    expect(m.dataProps.map((p) => p.uri)).toEqual([C("serial")]);
    expect(m.objectProps[0].domain).toEqual([C("Machine")]);
    expect(m.dataProps[0].range).toEqual([XSD_STRING]);
  });

  it("throws a descriptive error on invalid Turtle", () => {
    expect(() => parseTBox(":oops a owl:Class")).toThrow(/T-Box parse error/);
  });

  it("ignores standard-vocabulary terms as user classes", () => {
    const m = parse(`
      :Machine a owl:Class ; rdfs:subClassOf owl:Thing .
      owl:Thing a owl:Class .
    `);
    expect(m.classes.map((c) => c.uri)).toEqual([C("Machine")]);
  });
});

describe("parseTBox — blank nodes never leak as classes", () => {
  it("keeps anonymous class expressions out of `classes`", () => {
    const m = parse(`
      :Machine a owl:Class ;
        rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasPart ; owl:someValuesFrom :Part ] .
      :Part a owl:Class .
      :hasPart a owl:ObjectProperty .
      :flexible a owl:ObjectProperty ;
        rdfs:domain [ a owl:Class ; owl:unionOf ( :Machine :Part ) ] .
    `);
    for (const c of m.classes) {
      expect(c.uri.startsWith("http")).toBe(true);
      expect(c.uri).not.toMatch(/^n3-/);
      expect(c.uri).not.toMatch(/(^|[#/])n3-\d/);
    }
    expect(m.classes.map((c) => c.uri)).toEqual([C("Machine"), C("Part")]);
  });
});

describe("parseTBox — union domains / ranges", () => {
  it("flattens owl:unionOf in rdfs:domain into alternatives", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class . :C a owl:Class .
      :p a owl:ObjectProperty ;
        rdfs:domain [ a owl:Class ; owl:unionOf ( :A :B ) ] ;
        rdfs:range :C .
    `);
    expect(m.objectProps[0].domain.sort()).toEqual([C("A"), C("B")]);
    expect(m.objectProps[0].range).toEqual([C("C")]);
  });

  it("yields no domain for an opaque intersection expression", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class .
      :p a owl:ObjectProperty ; rdfs:domain [ a owl:Class ; owl:intersectionOf ( :A :B ) ] .
    `);
    expect(m.objectProps[0].domain).toEqual([]);
  });
});

describe("parseTBox — restrictions", () => {
  it("captures owl:Restriction on rdfs:subClassOf", () => {
    const m = parse(`
      :Station a owl:Class ;
        rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasPart ; owl:someValuesFrom :Part ] ,
                        [ a owl:Restriction ; owl:onProperty :serial ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
      :Part a owl:Class .
      :hasPart a owl:ObjectProperty .
      :serial a owl:DatatypeProperty ; rdfs:range xsd:string .
    `);
    expect(m.restrictions).toEqual(
      expect.arrayContaining([
        { onClass: C("Station"), onProperty: C("hasPart"), kind: "someValuesFrom", value: C("Part") },
        { onClass: C("Station"), onProperty: C("serial"), kind: "maxCardinality", n: 1, value: undefined },
      ]),
    );
    // the restriction blank node is not a superclass
    expect(m.subClassOf[C("Station")]).toBeUndefined();
  });

  it("reads qualified cardinalities and owl:equivalentClass restrictions", () => {
    const m = parse(`
      :Station a owl:Class ;
        owl:equivalentClass [ a owl:Restriction ; owl:onProperty :hasPart ;
                              owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass :Part ] .
      :Part a owl:Class .
      :hasPart a owl:ObjectProperty .
    `);
    expect(m.restrictions).toEqual([
      { onClass: C("Station"), onProperty: C("hasPart"), kind: "minCardinality", n: 2, value: C("Part") },
    ]);
  });

  it("drops restrictions whose property is unknown", () => {
    const m = parse(`
      :Station a owl:Class ;
        rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :ghost ; owl:someValuesFrom :Part ] .
      :Part a owl:Class .
    `);
    expect(m.restrictions).toBeUndefined();
  });

  it("pulls named parents out of a subClassOf intersection while keeping its restrictions", () => {
    const m = parse(`
      :Cylinder a owl:Class ; rdfs:subClassOf
        [ a owl:Class ; owl:intersectionOf ( :Actuator [ a owl:Restriction ; owl:onProperty :stroke ; owl:someValuesFrom xsd:decimal ] ) ] .
      :Actuator a owl:Class .
      :stroke a owl:DatatypeProperty ; rdfs:range xsd:decimal .
    `);
    expect(m.subClassOf[C("Cylinder")]).toEqual([C("Actuator")]);
    expect(m.restrictions).toEqual([
      { onClass: C("Cylinder"), onProperty: C("stroke"), kind: "someValuesFrom", value: XSD + "decimal" },
    ]);
  });
});

describe("parseTBox — property axioms", () => {
  it("records owl:FunctionalProperty", () => {
    const m = parse(`
      :Part a owl:Class .
      :serial a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:domain :Part ; rdfs:range xsd:string .
    `);
    expect(m.dataProps[0].functional).toBe(true);
  });

  it("records owl:inverseOf in BOTH directions", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class .
      :hasPart a owl:ObjectProperty ; rdfs:domain :A ; rdfs:range :B .
      :partOf a owl:ObjectProperty ; owl:inverseOf :hasPart ; rdfs:domain :B ; rdfs:range :A .
    `);
    const byUri = Object.fromEntries(m.objectProps.map((p) => [p.uri, p]));
    expect(byUri[C("partOf")].inverseOf).toBe(C("hasPart"));
    expect(byUri[C("hasPart")].inverseOf).toBe(C("partOf"));
  });

  it("inherits domain and range through rdfs:subPropertyOf", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class .
      :linked a owl:ObjectProperty ; rdfs:domain :A ; rdfs:range :B .
      :connected a owl:ObjectProperty ; rdfs:subPropertyOf :linked .
      :wired a owl:ObjectProperty ; rdfs:subPropertyOf :connected .
    `);
    const byUri = Object.fromEntries(m.objectProps.map((p) => [p.uri, p]));
    expect(byUri[C("connected")].domain).toEqual([C("A")]);
    expect(byUri[C("wired")].domain).toEqual([C("A")]);
    expect(byUri[C("wired")].range).toEqual([C("B")]);
    expect(byUri[C("wired")].subPropertyOf).toEqual([C("connected")]);
  });

  it("does not overwrite a property's own domain with an inherited one", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class . :Special a owl:Class .
      :linked a owl:ObjectProperty ; rdfs:domain :A ; rdfs:range :B .
      :connected a owl:ObjectProperty ; rdfs:subPropertyOf :linked ; rdfs:domain :Special .
    `);
    const connected = m.objectProps.find((p) => p.uri === C("connected"))!;
    expect(connected.domain).toEqual([C("Special")]);
    expect(connected.range).toEqual([C("B")]);
  });

  it("survives a subPropertyOf cycle", () => {
    const m = parse(`
      :p a owl:ObjectProperty ; rdfs:subPropertyOf :q .
      :q a owl:ObjectProperty ; rdfs:subPropertyOf :p .
    `);
    expect(m.objectProps.map((p) => p.domain)).toEqual([[], []]);
  });
});

describe("parseTBox — plain rdf:Property classification", () => {
  it("classifies by range: literal range → data property", () => {
    const m = parse(`
      :Part a owl:Class .
      :serial a rdf:Property ; rdfs:domain :Part ; rdfs:range xsd:string .
      :hasPart a rdf:Property ; rdfs:domain :Part ; rdfs:range :Part .
      :vague a rdf:Property ; rdfs:domain :Part .
    `);
    expect(m.dataProps.map((p) => p.uri)).toEqual([C("serial")]);
    expect(m.objectProps.map((p) => p.uri).sort()).toEqual([C("hasPart"), C("vague")].sort());
  });

  it("skips annotation properties", () => {
    const m = parse(`
      :note a owl:AnnotationProperty , rdf:Property ; rdfs:range xsd:string .
    `);
    expect(m.dataProps).toEqual([]);
    expect(m.objectProps).toEqual([]);
  });
});

describe("parseTBox — disjointness", () => {
  it("records owl:disjointWith symmetrically", () => {
    const m = parse(`
      :Sensor a owl:Class ; owl:disjointWith :Actuator .
      :Actuator a owl:Class .
    `);
    const byUri = Object.fromEntries(m.classes.map((c) => [c.uri, c]));
    expect(byUri[C("Sensor")].disjointWith).toEqual([C("Actuator")]);
    expect(byUri[C("Actuator")].disjointWith).toEqual([C("Sensor")]);
  });

  it("expands owl:AllDisjointClasses to every pair", () => {
    const m = parse(`
      :A a owl:Class . :B a owl:Class . :C a owl:Class .
      [] a owl:AllDisjointClasses ; owl:members ( :A :B :C ) .
    `);
    const byUri = Object.fromEntries(m.classes.map((c) => [c.uri, c]));
    expect(byUri[C("A")].disjointWith).toEqual([C("B"), C("C")]);
    expect(byUri[C("B")].disjointWith).toEqual([C("A"), C("C")]);
    expect(byUri[C("C")].disjointWith).toEqual([C("A"), C("B")]);
  });
});

describe("parseTBox — labels and comments", () => {
  it("prefers @en, then an untagged literal, then the first", () => {
    const m = parse(`
      :A a owl:Class ; rdfs:label "Ventil"@de , "Valve"@en , "plain" .
      :B a owl:Class ; rdfs:label "Zylinder"@de , "plain-b" .
      :Cc a owl:Class ; rdfs:label "Sensore"@it , "Kolben"@de .
    `);
    const byUri = Object.fromEntries(m.classes.map((c) => [c.uri, c]));
    expect(byUri[C("A")].label).toBe("Valve");
    expect(byUri[C("B")].label).toBe("plain-b");
    expect(byUri[C("Cc")].label).toBe("Sensore");
  });

  it("accepts regional English tags", () => {
    const m = parse(`:A a owl:Class ; rdfs:comment "Colour"@en-GB , "Farbe"@de .`);
    expect(m.classes[0].comment).toBe("Colour");
  });
});

describe("parseTBox — ontology header and base IRI", () => {
  it("reads the owl:Ontology IRI and owl:imports", () => {
    const m = parse(`
      <http://ex/onto> a owl:Ontology ; owl:imports <http://ex/upper> , <http://ex/upper> .
      :A a owl:Class .
    `);
    expect(m.ontologyIri).toBe("http://ex/onto");
    expect(m.imports).toEqual(["http://ex/upper"]);
  });

  it("defaults baseIri to a SEPARATE A-Box namespace, not the T-Box namespace", () => {
    const m = parse(`:A a owl:Class .`);
    expect(m.baseIri).toBe("http://ex/onto/abox#");
    expect(m.baseIri).not.toBe(NS);
  });

  it("honours an explicit base IRI override", () => {
    const m = parse(`:A a owl:Class .`, "http://other/abox#");
    expect(m.baseIri).toBe("http://other/abox#");
  });
});

describe("parseTBox — implicit classes", () => {
  it("keeps classes only declared through rdfs:subClassOf", () => {
    const m = parse(`:Child rdfs:subClassOf :Parent .`);
    expect(m.classes.map((c) => c.uri).sort()).toEqual([C("Child"), C("Parent")].sort());
    expect(m.subClassOf[C("Child")]).toEqual([C("Parent")]);
  });

  it("keeps classes only declared through owl:equivalentClass", () => {
    const m = parse(`:Left owl:equivalentClass :Right .`);
    expect(m.classes.map((c) => c.uri).sort()).toEqual([C("Left"), C("Right")].sort());
  });
});

describe("parseTBox — bundled mechatronic sample", () => {
  const ttl = readFileSync(new URL("../../../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
  const m = parseTBox(ttl);

  it("has 7 classes, 4 object properties and 5 data properties", () => {
    expect(m.classes).toHaveLength(7);
    expect(m.objectProps).toHaveLength(4);
    expect(m.dataProps).toHaveLength(5);
  });

  it("reads the hierarchy, header and A-Box namespace", () => {
    expect(m.subClassOf["http://ontolab.example/mechatronic#Motion"]).toEqual([
      "http://ontolab.example/mechatronic#Operation",
    ]);
    expect(m.ontologyIri).toBe("http://ontolab.example/mechatronic");
    expect(m.prefixes[""]).toBe("http://ontolab.example/mechatronic#");
    expect(m.baseIri).toBe("http://ontolab.example/mechatronic/abox#");
  });

  it("keeps class labels and typed data-property ranges", () => {
    const dur = m.dataProps.find((p) => p.uri.endsWith("#hasDuration"))!;
    expect(dur.label).toBe("has duration (s)");
    expect(dur.range).toEqual([XSD + "decimal"]);
    expect(dur.domain).toEqual(["http://ontolab.example/mechatronic#Operation"]);
  });
});

describe("mergeTBox", () => {
  const a = parse(`
    <http://ex/onto> a owl:Ontology ; owl:imports <http://ex/upper> .
    :Machine a owl:Class ; rdfs:label "Machine" .
    :Part a owl:Class ; owl:disjointWith :Machine .
    :hasPart a owl:ObjectProperty ; rdfs:domain :Machine ; rdfs:range :Part .
    :Machine rdfs:subClassOf :Thing .
    :Machine rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasPart ; owl:someValuesFrom :Part ] .
  `);
  const b = parseTBox(`
    @prefix : <http://ex/other#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    <http://ex/onto#Assembly> a owl:Class .
    <${C("hasPart")}> a owl:ObjectProperty ; rdfs:domain <http://ex/onto#Assembly> ; rdfs:range <http://ex/onto#Assembly> .
    <${C("Machine")}> rdfs:subClassOf <http://ex/onto#Assembly> .
  `);
  const merged = mergeTBox([a, b]);

  it("unions classes and property domain/range", () => {
    expect(merged.classes.map((c) => c.uri)).toContain(C("Assembly"));
    const hasPart = merged.objectProps.find((p) => p.uri === C("hasPart"))!;
    expect(hasPart.domain.sort()).toEqual([C("Assembly"), C("Machine")].sort());
    expect(hasPart.range.sort()).toEqual([C("Assembly"), C("Part")].sort());
  });

  it("unions subClassOf edges", () => {
    expect(merged.subClassOf[C("Machine")].sort()).toEqual([C("Assembly"), C("Thing")].sort());
  });

  it("keeps restrictions, disjointWith, the ontology IRI and imports", () => {
    expect(merged.restrictions).toEqual([
      { onClass: C("Machine"), onProperty: C("hasPart"), kind: "someValuesFrom", value: C("Part") },
    ]);
    expect(merged.classes.find((c) => c.uri === C("Part"))!.disjointWith).toEqual([C("Machine")]);
    expect(merged.ontologyIri).toBe("http://ex/onto");
    expect(merged.imports).toEqual(["http://ex/upper"]);
  });

  it("resolves a prefix clash first-wins", () => {
    expect(merged.prefixes[""]).toBe(NS);
  });

  it("does not mutate the input models", () => {
    expect(a.objectProps.find((p) => p.uri === C("hasPart"))!.domain).toEqual([C("Machine")]);
  });
});
