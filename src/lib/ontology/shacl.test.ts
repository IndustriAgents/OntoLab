import { describe, it, expect } from "vitest";
import { validateShacl } from "./shaclValidator";
import { tboxToShapes, classShapeIri, propertyShapeIri } from "./shaclShapes";
import { parseTBox } from "./tboxParser";
import { SH, RDF_TYPE } from "./iri";
import type { ABoxResult, ValidationIssue } from "../../types/abox";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;

const tbox = parseTBox(`
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Station a owl:Class .
:Component a owl:Class .
:Sensor a owl:Class ; rdfs:subClassOf :Component ; owl:disjointWith :Actuator .
:Actuator a owl:Class ; rdfs:subClassOf :Component .
:Signal a owl:Class .
:partOf a owl:ObjectProperty ; rdfs:domain :Component ; rdfs:range :Station .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
:note a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:string .
:serial a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:domain :Component ; rdfs:range xsd:string .
:free a owl:DatatypeProperty ; rdfs:domain :Component .
`);

const mentions = (issues: ValidationIssue[], term: string) => issues.filter((i) => i.message.includes(term));

describe("validateShacl", () => {
  it("returns nothing for an empty A-Box", async () => {
    expect(await validateShacl({ individuals: [] }, tbox)).toEqual([]);
  });

  it("does NOT flag a range-less data property (it only gets sh:nodeKind sh:Literal)", async () => {
    const abox: ABoxResult = {
      individuals: [{ id: "C1", classUri: C("Component"), dataProperties: [{ propUri: C("free"), value: "anything" }] }],
    };
    const issues = await validateShacl(abox, tbox);
    expect(mentions(issues, "free")).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("accepts a language-tagged literal on an xsd:string range", async () => {
    const abox: ABoxResult = {
      individuals: [
        { id: "C1", classUri: C("Component"), dataProperties: [{ propUri: C("note"), value: "Zylinder", lang: "de" }] },
      ],
    };
    expect(await validateShacl(abox, tbox)).toEqual([]);
  });

  it("flags a value that is not a valid decimal", async () => {
    const abox: ABoxResult = {
      individuals: [
        { id: "C1", classUri: C("Component"), dataProperties: [{ propUri: C("pressure"), value: "six hundred" }] },
      ],
    };
    const issues = await validateShacl(abox, tbox);
    expect(mentions(issues, "pressure").length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === "shacl")).toBe(true);
    expect(issues[0].id).toBe("C1");
  });

  it("flags a functional property carrying two values", async () => {
    const abox: ABoxResult = {
      individuals: [
        {
          id: "C1",
          classUri: C("Component"),
          dataProperties: [
            { propUri: C("serial"), value: "A" },
            { propUri: C("serial"), value: "B" },
          ],
        },
      ],
    };
    const issues = await validateShacl(abox, tbox);
    const hit = mentions(issues, "serial");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.map((i) => i.message)).toEqual(["serial: More than 1 values"]);
    expect(hit[0].severity).toBe("warn");
  });

  it("flags disjoint typing as a hard error", async () => {
    const abox: ABoxResult = {
      individuals: [{ id: "S1", classUri: C("Sensor"), additionalTypes: [C("Actuator")] }],
    };
    const issues = await validateShacl(abox, tbox);
    const disjoint = issues.filter((i) => i.severity === "error");
    expect(disjoint.length).toBeGreaterThan(0);
    expect(disjoint.some((i) => i.message.includes("disjoint"))).toBe(true);
  });

  it("lets a subclass instance satisfy a superclass sh:class constraint", async () => {
    // :partOf has range :Station; the target is a subclass instance of the
    // property's domain, and the domain shape targets :Component.
    const abox: ABoxResult = {
      individuals: [
        { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] },
        { id: "L1", classUri: C("Station") },
      ],
    };
    expect(await validateShacl(abox, tbox)).toEqual([]);
  });

  it("still flags an object-property target of the wrong class", async () => {
    const abox: ABoxResult = {
      individuals: [
        { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "Sig" }] },
        { id: "Sig", classUri: C("Signal") },
      ],
    };
    const issues = await validateShacl(abox, tbox);
    expect(mentions(issues, "partOf").length).toBeGreaterThan(0);
  });

  it("flags a subject of a property whose domain it does not satisfy", async () => {
    const abox: ABoxResult = {
      individuals: [{ id: "Sig", classUri: C("Signal"), dataProperties: [{ propUri: C("pressure"), value: "1.0" }] }],
    };
    const issues = await validateShacl(abox, tbox);
    expect(issues.some((i) => i.message.includes("must be a"))).toBe(true);
    expect(issues.every((i) => i.severity === "warn")).toBe(true);
  });

  it("attributes findings to the right individual, with its label", async () => {
    const abox: ABoxResult = {
      individuals: [
        { id: "C1", classUri: C("Component"), label: "Cylinder 1", dataProperties: [{ propUri: C("pressure"), value: "nope" }] },
      ],
    };
    const issues = await validateShacl(abox, tbox);
    expect(issues[0].where).toBe("Cylinder 1 (C1)");
  });
});

describe("tboxToShapes — shape count does not explode", () => {
  const many = parseTBox(`
    @prefix : <${NS}> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    ${Array.from({ length: 25 }, (_, i) => `:C${i} a owl:Class .`).join("\n")}
    :loose a owl:DatatypeProperty ; rdfs:range xsd:string .
  `);
  const shapes = tboxToShapes(many);

  it("attaches a domain-less property once, via sh:targetSubjectsOf", () => {
    expect(many.classes).toHaveLength(25);
    const paths = shapes.filter((q) => q.predicate.value === SH + "path" && q.object.value === C("loose"));
    expect(paths).toHaveLength(1);

    const targets = shapes.filter((q) => q.predicate.value === SH + "targetSubjectsOf" && q.object.value === C("loose"));
    expect(targets).toHaveLength(1);
    expect(targets[0].subject.value).toBe(propertyShapeIri(C("loose")));
  });

  it("emits exactly one NodeShape per class plus one per property", () => {
    const nodeShapes = shapes.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === SH + "NodeShape");
    expect(nodeShapes).toHaveLength(25 + 1);
    expect(nodeShapes.map((q) => q.subject.value)).toContain(classShapeIri(C("C0")));
  });
});

describe("tboxToShapes — constraint shape", () => {
  const shapes = tboxToShapes(tbox);
  const has = (s: string, p: string, o: string) =>
    shapes.some((q) => q.subject.value === s && q.predicate.value === p && q.object.value === o);

  it("targets each class shape at its class", () => {
    expect(has(classShapeIri(C("Sensor")), SH + "targetClass", C("Sensor"))).toBe(true);
  });

  it("gives an xsd:string range an sh:or over xsd:string and rdf:langString", () => {
    const orQuads = shapes.filter((q) => q.predicate.value === SH + "or");
    expect(orQuads.length).toBeGreaterThan(0);
    const datatypes = shapes.filter((q) => q.predicate.value === SH + "datatype").map((q) => q.object.value);
    expect(datatypes).toContain("http://www.w3.org/1999/02/22-rdf-syntax-ns#langString");
  });

  it("marks range/cardinality constraints as warnings, and disjointness as a violation", () => {
    const warned = shapes.filter((q) => q.predicate.value === SH + "severity" && q.object.value === SH + "Warning");
    expect(warned.length).toBeGreaterThan(0);
    const notQuads = shapes.filter((q) => q.predicate.value === SH + "not");
    expect(notQuads.length).toBeGreaterThan(0);
    // the sh:not blank nodes carry no severity → default sh:Violation
    for (const n of notQuads) {
      expect(shapes.some((q) => q.subject.value === n.object.value && q.predicate.value === SH + "severity")).toBe(false);
    }
  });

  it("adds sh:maxCount 1 for a functional property", () => {
    const maxCounts = shapes.filter((q) => q.predicate.value === SH + "maxCount");
    expect(maxCounts.length).toBeGreaterThan(0);
    expect(maxCounts.every((q) => q.object.value === "1")).toBe(true);
  });
});
