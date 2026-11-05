import { describe, it, expect } from "vitest";
import { Parser } from "n3";
import { serializeTBoxStructured, toTermLocalName, type RawTBox } from "./tboxSerializer";
import { parseTBox } from "./tboxParser";
import { XSD, XSD_STRING } from "./iri";

const BASE = "http://ex/onto#";
const C = (n: string) => BASE + n;

const raw: RawTBox = {
  classes: [
    { name: "Station", label: "Station", comment: "A production station." },
    { name: "Component" },
    { name: "Sensor", parents: ["Component"] },
  ],
  objectProperties: [
    { name: "hasComponent", label: "has component", domain: ["Station"], range: ["Component"] },
    { name: "primarySensor", domain: ["Station"], range: ["Sensor"], functional: true },
  ],
  dataProperties: [
    { name: "partNumber", domain: ["Component"], datatype: "string" },
    { name: "operatingPressure", domain: ["Component"], datatype: "number", functional: true },
    { name: "description", domain: ["Component"], datatype: "text" },
    { name: "installedOn", domain: ["Component"] },
  ],
};

describe("toTermLocalName", () => {
  it("preserves PascalCase and camelCase", () => {
    expect(toTermLocalName("Station")).toBe("Station");
    expect(toTermLocalName("hasComponent")).toBe("hasComponent");
  });

  it("strips characters that are illegal in a local name", () => {
    expect(toTermLocalName("operating pressure (kPa)")).toBe("operatingpressurekPa");
    expect(toTermLocalName("part-number_1")).toBe("part-number_1");
  });

  it("drops a leading digit so the result is an NCName", () => {
    expect(toTermLocalName("3Phase")).toBe("Phase");
    expect(toTermLocalName("_private")).toBe("_private");
  });

  it("falls back to X for an empty or unusable name", () => {
    expect(toTermLocalName("")).toBe("X");
    expect(toTermLocalName("!!!")).toBe("X");
    expect(toTermLocalName(undefined as unknown as string)).toBe("X");
  });
});

describe("serializeTBoxStructured", () => {
  const turtle = serializeTBoxStructured(raw, BASE);

  it("emits parseable Turtle", () => {
    expect(() => new Parser().parse(turtle)).not.toThrow();
  });

  it("round-trips through parseTBox", () => {
    const m = parseTBox(turtle);
    expect(m.classes.map((c) => c.uri).sort()).toEqual([C("Component"), C("Sensor"), C("Station")]);
    expect(m.objectProps.map((p) => p.uri).sort()).toEqual([C("hasComponent"), C("primarySensor")]);
    expect(m.dataProps.map((p) => p.uri).sort()).toEqual(
      [C("description"), C("installedOn"), C("operatingPressure"), C("partNumber")].sort(),
    );
    expect(m.subClassOf[C("Sensor")]).toEqual([C("Component")]);

    const hasComponent = m.objectProps.find((p) => p.uri === C("hasComponent"))!;
    expect(hasComponent.domain).toEqual([C("Station")]);
    expect(hasComponent.range).toEqual([C("Component")]);
    expect(hasComponent.label).toBe("has component");
    expect(m.classes.find((c) => c.uri === C("Station"))!.comment).toBe("A production station.");
  });

  it("preserves PascalCase / camelCase names in the minted URIs", () => {
    expect(turtle).toContain(":Station");
    expect(turtle).toContain(":hasComponent");
    expect(turtle).toContain(":operatingPressure");
    expect(turtle).not.toContain(":station ");
  });

  it("maps an unknown datatype hint to xsd:string, never xsd:text", () => {
    const m = parseTBox(turtle);
    expect(turtle).not.toContain("xsd:text");
    expect(m.dataProps.find((p) => p.uri === C("description"))!.range).toEqual([XSD_STRING]);
    // an alias still resolves to the right XSD type
    expect(m.dataProps.find((p) => p.uri === C("operatingPressure"))!.range).toEqual([XSD + "decimal"]);
    // an omitted datatype defaults to xsd:string
    expect(m.dataProps.find((p) => p.uri === C("installedOn"))!.range).toEqual([XSD_STRING]);
  });

  it("emits the functional flag for both property kinds", () => {
    const m = parseTBox(turtle);
    expect(m.dataProps.find((p) => p.uri === C("operatingPressure"))!.functional).toBe(true);
    expect(m.objectProps.find((p) => p.uri === C("primarySensor"))!.functional).toBe(true);
    expect(m.dataProps.find((p) => p.uri === C("partNumber"))!.functional).toBeUndefined();
  });

  it("normalises a base IRI that lacks a separator and defaults when absent", () => {
    expect(serializeTBoxStructured({ classes: [{ name: "A" }] }, "http://ex/onto")).toContain("<http://ex/onto#>");
    expect(serializeTBoxStructured({ classes: [{ name: "A" }] })).toContain("http://ontolab.example/onto#");
  });

  it("skips nameless entries instead of minting junk terms", () => {
    const m = parseTBox(
      serializeTBoxStructured(
        {
          classes: [{ name: "A" }, { name: "" } as { name: string }],
          dataProperties: [{ name: "", datatype: "string" } as { name: string; datatype: string }],
        },
        BASE,
      ),
    );
    expect(m.classes.map((c) => c.uri)).toEqual([C("A")]);
    expect(m.dataProps).toEqual([]);
  });

  it("is deterministic", () => {
    expect(serializeTBoxStructured(raw, BASE)).toBe(turtle);
  });
});

describe("serializeTBoxStructured — OWL axioms", () => {
  const axiomatic: RawTBox = {
    classes: [
      { name: "Person", disjointWith: ["Organization"] },
      { name: "Organization" },
      { name: "Human", equivalentTo: ["Person"] },
      {
        name: "ResearchProject",
        restrictions: [
          { property: "hasPrincipalInvestigator", kind: "minCardinality", n: 1, value: "Person" },
          { property: "hasPrincipalInvestigator", kind: "maxCardinality", n: 2 },
          { property: "title", kind: "someValuesFrom", value: "string" },
        ],
      },
      { name: "University", parents: ["Organization"] },
      { name: "Company", parents: ["Organization"] },
    ],
    objectProperties: [
      { name: "hasPrincipalInvestigator", domain: ["ResearchProject"], range: ["Person"], parents: ["hasMember"] },
      { name: "hasMember", inverseOf: "memberOf" },
      { name: "memberOf" },
      { name: "partOf", characteristics: ["transitive", "asymmetric"] },
    ],
    dataProperties: [{ name: "title", domain: ["ResearchProject"], datatype: "string" }],
    disjointGroups: [["University", "Company"]],
  };

  it("round-trips disjointness, equivalence, restrictions, inverses and characteristics through parseTBox", () => {
    const m = parseTBox(serializeTBoxStructured(axiomatic, BASE));
    expect(m.classes.find((c) => c.uri === C("Person"))?.disjointWith).toEqual([C("Organization")]);
    expect(m.classes.find((c) => c.uri === C("University"))?.disjointWith).toEqual([C("Company")]);
    expect(m.classes.find((c) => c.uri === C("Human"))?.equivalentTo).toEqual([C("Person")]);
    expect(m.restrictions).toEqual(
      expect.arrayContaining([
        { onClass: C("ResearchProject"), onProperty: C("hasPrincipalInvestigator"), kind: "minCardinality", n: 1, value: C("Person") },
        { onClass: C("ResearchProject"), onProperty: C("hasPrincipalInvestigator"), kind: "maxCardinality", n: 2, value: undefined },
        { onClass: C("ResearchProject"), onProperty: C("title"), kind: "someValuesFrom", value: XSD + "string" },
      ]),
    );
    const op = (n: string) => m.objectProps.find((p) => p.uri === C(n));
    expect(op("hasMember")?.inverseOf).toBe(C("memberOf"));
    expect(op("hasPrincipalInvestigator")?.subPropertyOf).toEqual([C("hasMember")]);
    expect(op("partOf")?.characteristics).toEqual(["asymmetric", "transitive"]);
  });
});
