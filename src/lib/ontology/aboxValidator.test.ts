import { describe, it, expect } from "vitest";
import { validateABox } from "./aboxValidator";
import { parseTBox } from "./tboxParser";
import type { ABoxResult, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;
const ABOX = "http://ex/onto/abox#";

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
:hasSignal a owl:ObjectProperty , owl:FunctionalProperty ; rdfs:domain :Sensor ; rdfs:range :Signal .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
:serial a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:domain :Component ; rdfs:range xsd:string .
:free a owl:DatatypeProperty ; rdfs:domain :Component .
:Station rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasCount ; owl:maxCardinality "2"^^xsd:nonNegativeInteger ] .
:Sensor rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Station ] .
:hasCount a owl:DatatypeProperty ; rdfs:domain :Station ; rdfs:range xsd:integer .
`);

const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const of = (issues: ValidationIssue[], code: string) => issues.filter((i) => i.code === code);

/** A Sensor that satisfies its someValuesFrom restriction, so tests stay focused. */
const goodStation = { id: "Line1", classUri: C("Station") };
const sensor = (over: Partial<ABoxResult["individuals"][number]> = {}) => ({
  id: "S1",
  classUri: C("Sensor"),
  objectProperties: [{ propUri: C("partOf"), targetId: "Line1" }],
  ...over,
});

describe("validateABox — identity errors", () => {
  it("reports duplicate-id", () => {
    const issues = validateABox({ individuals: [goodStation, sensor(), sensor()] }, tbox);
    expect(of(issues, "duplicate-id")).toHaveLength(1);
    expect(of(issues, "duplicate-id")[0].severity).toBe("error");
  });

  it("reports iri-collision when two different ids mint the same IRI", () => {
    const issues = validateABox(
      { individuals: [{ id: "Sensor B1", classUri: C("Station") }, { id: "Sensor-B1", classUri: C("Station") }] },
      tbox,
    );
    const hit = of(issues, "iri-collision");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
    expect(hit[0].message).toContain(ABOX + "Sensor-B1");
  });

  it("does not report iri-collision for a repeated id (that is duplicate-id)", () => {
    const issues = validateABox({ individuals: [goodStation, goodStation] }, tbox);
    expect(codes(issues)).toContain("duplicate-id");
    expect(of(issues, "iri-collision")).toHaveLength(0);
  });

  it("reports tbox-collision when an individual IRI is already a T-Box term", () => {
    const issues = validateABox({ individuals: [{ id: "Sensor", classUri: C("Station") }] }, tbox, NS);
    const hit = of(issues, "tbox-collision");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
  });

  it("does not report tbox-collision with the default separate A-Box namespace", () => {
    const issues = validateABox({ individuals: [{ id: "Sensor", classUri: C("Station") }] }, tbox);
    expect(of(issues, "tbox-collision")).toHaveLength(0);
  });
});

describe("validateABox — schema errors", () => {
  it("reports unknown-class as an error for the primary type", () => {
    const issues = validateABox({ individuals: [{ id: "X", classUri: C("Ghost") }] }, tbox);
    const hit = of(issues, "unknown-class");
    expect(hit[0].severity).toBe("error");
    expect(hit[0].message).toContain("Ghost");
  });

  it("reports an unknown additional type as a warning only", () => {
    const issues = validateABox(
      { individuals: [{ id: "X", classUri: C("Station"), additionalTypes: [C("Ghost")] }] },
      tbox,
    );
    expect(of(issues, "unknown-class")).toHaveLength(1);
    expect(of(issues, "unknown-class")[0].severity).toBe("warn");
  });

  it("reports unknown-property for both data and object properties", () => {
    const issues = validateABox(
      {
        individuals: [
          {
            id: "X",
            classUri: C("Station"),
            dataProperties: [{ propUri: C("nope"), value: "1" }],
            objectProperties: [{ propUri: C("neither"), targetId: "X" }],
          },
        ],
      },
      tbox,
    );
    expect(of(issues, "unknown-property")).toHaveLength(2);
    expect(of(issues, "unknown-property").every((i) => i.severity === "error")).toBe(true);
  });

  it("reports dangling-target", () => {
    const issues = validateABox(
      { individuals: [{ id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "nope" }] }] },
      tbox,
    );
    const hit = of(issues, "dangling-target");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
  });

  it("reports disjoint typing once, as an error", () => {
    const issues = validateABox(
      { individuals: [goodStation, sensor({ additionalTypes: [C("Actuator")] })] },
      tbox,
    );
    const hit = of(issues, "disjoint");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
    expect(hit[0].message).toMatch(/Sensor.*Actuator|Actuator.*Sensor/);
  });
});

describe("validateABox — schema warnings", () => {
  it("warns on a domain mismatch", () => {
    const issues = validateABox(
      { individuals: [{ id: "Sig", classUri: C("Signal"), dataProperties: [{ propUri: C("pressure"), value: "1.0" }] }] },
      tbox,
    );
    const hit = of(issues, "domain");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("warn");
  });

  it("accepts a subclass as the domain (hierarchy aware)", () => {
    const issues = validateABox(
      { individuals: [goodStation, sensor({ dataProperties: [{ propUri: C("pressure"), value: "1.0" }] })] },
      tbox,
    );
    expect(of(issues, "domain")).toHaveLength(0);
  });

  it("warns on an object-property range mismatch", () => {
    const issues = validateABox(
      {
        individuals: [
          { id: "Sig", classUri: C("Signal") },
          sensor({ objectProperties: [{ propUri: C("partOf"), targetId: "Sig" }] }),
        ],
      },
      tbox,
    );
    expect(of(issues, "range").map((i) => i.severity)).toEqual(["warn"]);
  });

  it("warns on a data-property range mismatch", () => {
    const issues = validateABox(
      { individuals: [{ id: "St", classUri: C("Station"), dataProperties: [{ propUri: C("hasCount"), value: "abc", datatype: "string" }] }] },
      tbox,
    );
    expect(codes(issues)).toContain("range");
  });

  it("warns on an unrecognised datatype hint", () => {
    const issues = validateABox(
      { individuals: [{ id: "St", classUri: C("Station"), dataProperties: [{ propUri: C("hasCount"), value: "1", datatype: "banana" }] }] },
      tbox,
    );
    const hit = of(issues, "datatype");
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain("banana");
  });

  it("warns when a language tag is used on a non-text range", () => {
    const issues = validateABox(
      { individuals: [{ id: "St", classUri: C("Station"), dataProperties: [{ propUri: C("hasCount"), value: "eins", lang: "de" }] }] },
      tbox,
    );
    expect(codes(issues)).toContain("range");
  });

  it("accepts a language tag on an xsd:string range", () => {
    const issues = validateABox(
      { individuals: [goodStation, sensor({ dataProperties: [{ propUri: C("serial"), value: "Zylinder", lang: "de" }] })] },
      tbox,
    );
    expect(issues).toEqual([]);
  });

  it("warns on an ill-formed literal (lexical)", () => {
    const issues = validateABox(
      { individuals: [goodStation, sensor({ dataProperties: [{ propUri: C("pressure"), value: "six hundred" }] })] },
      tbox,
    );
    const hit = of(issues, "lexical");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("warn");
    expect(hit[0].message).toContain("decimal");
  });

  it("checks the lexical form against the DECLARED range when no datatype is given", () => {
    const issues = validateABox(
      { individuals: [{ id: "St", classUri: C("Station"), dataProperties: [{ propUri: C("hasCount"), value: "1.5" }] }] },
      tbox,
    );
    expect(of(issues, "lexical")).toHaveLength(1);
  });

  it("skips the lexical check for a blank value and for a range-less property", () => {
    const issues = validateABox(
      {
        individuals: [
          goodStation,
          sensor({
            dataProperties: [
              { propUri: C("pressure"), value: "  " },
              { propUri: C("free"), value: "anything at all" },
            ],
          }),
        ],
      },
      tbox,
    );
    expect(of(issues, "lexical")).toHaveLength(0);
  });

  it("warns when a functional property has more than one value", () => {
    const issues = validateABox(
      {
        individuals: [
          goodStation,
          { id: "Sig", classUri: C("Signal") },
          sensor({
            dataProperties: [
              { propUri: C("serial"), value: "A" },
              { propUri: C("serial"), value: "B" },
            ],
            objectProperties: [
              { propUri: C("partOf"), targetId: "Line1" },
              { propUri: C("hasSignal"), targetId: "Sig" },
              { propUri: C("hasSignal"), targetId: "Sig" },
            ],
          }),
        ],
      },
      tbox,
    );
    const hit = of(issues, "functional");
    expect(hit).toHaveLength(2); // one data, one object
    expect(hit.every((i) => i.severity === "warn")).toBe(true);
    expect(hit.map((i) => i.message).join(" ")).toMatch(/serial/);
    expect(hit.map((i) => i.message).join(" ")).toMatch(/hasSignal/);
  });
});

describe("validateABox — owl:Restrictions", () => {
  it("warns when someValuesFrom is unmet", () => {
    const issues = validateABox({ individuals: [{ id: "S1", classUri: C("Sensor") }] }, tbox);
    const hit = of(issues, "restriction");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("warn");
    expect(hit[0].message).toContain("partOf");
  });

  it("is satisfied when the required value is present", () => {
    const issues = validateABox({ individuals: [goodStation, sensor()] }, tbox);
    expect(of(issues, "restriction")).toHaveLength(0);
  });

  it("warns when maxCardinality is exceeded", () => {
    const issues = validateABox(
      {
        individuals: [
          {
            id: "Line1",
            classUri: C("Station"),
            dataProperties: [
              { propUri: C("hasCount"), value: "1" },
              { propUri: C("hasCount"), value: "2" },
              { propUri: C("hasCount"), value: "3" },
            ],
          },
        ],
      },
      tbox,
    );
    const hit = of(issues, "restriction");
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain("at most 2");
  });

  it("applies an inherited restriction to a subclass instance", () => {
    const sub = parseTBox(`
      @prefix : <${NS}> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      :Component a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Station ] .
      :Sensor a owl:Class ; rdfs:subClassOf :Component .
      :Station a owl:Class .
      :partOf a owl:ObjectProperty ; rdfs:domain :Component ; rdfs:range :Station .
    `);
    const issues = validateABox({ individuals: [{ id: "S1", classUri: C("Sensor") }] }, sub);
    expect(of(issues, "restriction")).toHaveLength(1);
  });
});

describe("validateABox — no false positives", () => {
  it("stays silent for a fully conforming A-Box", () => {
    const abox: ABoxResult = {
      individuals: [
        goodStation,
        { id: "Sig", classUri: C("Signal") },
        sensor({
          label: "Sensor B1",
          dataProperties: [
            { propUri: C("pressure"), value: "600.5", datatype: "xsd:decimal" },
            { propUri: C("serial"), value: "SME-8M" },
          ],
          objectProperties: [
            { propUri: C("partOf"), targetId: "Line1" },
            { propUri: C("hasSignal"), targetId: "Sig" },
          ],
        }),
      ],
    };
    expect(validateABox(abox, tbox)).toEqual([]);
  });

  it("does not flag a CURIE datatype that normalises to the declared range", () => {
    for (const datatype of ["xsd:decimal", "decimal", "DECIMAL", "http://www.w3.org/2001/XMLSchema#decimal", "number"]) {
      const issues = validateABox(
        { individuals: [goodStation, sensor({ dataProperties: [{ propUri: C("pressure"), value: "600", datatype }] })] },
        tbox,
      );
      expect(issues, `datatype hint ${datatype}`).toEqual([]);
    }
  });

  it("accepts any datatype when the property declares no range", () => {
    const issues = validateABox(
      { individuals: [goodStation, sensor({ dataProperties: [{ propUri: C("free"), value: "2024-01-31", datatype: "date" }] })] },
      tbox,
    );
    expect(issues).toEqual([]);
  });
});

describe("validateABox — issue shape", () => {
  it("carries the individual's id and a human `where`", () => {
    const issues = validateABox({ individuals: [{ id: "S1", classUri: C("Ghost"), label: "Sensor B1" }] }, tbox);
    expect(issues[0].id).toBe("S1");
    expect(issues[0].where).toBe("Sensor B1 (S1)");
  });

  it("falls back to the id when there is no label", () => {
    const issues = validateABox({ individuals: [{ id: "S1", classUri: C("Ghost") }] }, tbox);
    expect(issues[0].where).toBe("S1");
  });

  it("honours a baseIri override when minting IRIs for collision checks", () => {
    const empty: TBoxModel = { ...tbox, classes: [], objectProps: [], dataProps: [] };
    const issues = validateABox({ individuals: [{ id: "a", classUri: "" }] }, empty, "http://other#");
    expect(of(issues, "tbox-collision")).toHaveLength(0);
  });
});
