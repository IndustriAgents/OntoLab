import { describe, it, expect } from "vitest";
import { applicableProps, rangeTargets, missingSlots, inputKindFor, defaultDatatype, effectiveDomain } from "./schemaGuide";
import { tbox, C, XSD } from "./manualEditing.fixture";

const uris = (ps: { uri: string }[]) => ps.map((p) => p.uri).sort();

describe("applicableProps", () => {
  it("offers properties whose domain covers the class or an ancestor, plus domain-less ones", () => {
    const { data, object } = applicableProps(tbox, [C("Sensor")]);
    expect(uris(data)).toEqual([C("name"), C("pressure")]);
    expect(uris(object)).toEqual([C("locatedIn"), C("partOf")]);
  });
  it("leaves out properties for other classes", () => {
    const { data, object } = applicableProps(tbox, [C("Station")]);
    expect(uris(data)).toEqual([C("capacity"), C("name")]);
    expect(object).toEqual([]);
  });
  it("inherits the domain of a super-property", () => {
    expect(effectiveDomain(tbox, tbox.objectProps.find((p) => p.uri === C("locatedIn"))!)).toEqual([C("Component")]);
  });
});

describe("rangeTargets", () => {
  it("keeps only individuals that fit the range", () => {
    const abox = { individuals: [{ id: "L1", classUri: C("Station") }, { id: "S1", classUri: C("Sensor") }] };
    expect(rangeTargets(tbox, abox, C("partOf")).map((i) => i.id)).toEqual(["L1"]);
  });
});

describe("missingSlots", () => {
  it("reports an unmet someValuesFrom restriction", () => {
    const slots = missingSlots(tbox, { id: "S1", classUri: C("Sensor") });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ propUri: C("partOf"), kind: "object", need: 1, filler: C("Station") });
  });
  it("is empty once the value is present", () => {
    expect(missingSlots(tbox, { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] })).toEqual([]);
  });
});

describe("datatype inputs", () => {
  it("maps datatypes to input kinds", () => {
    expect(inputKindFor(XSD + "integer")).toBe("integer");
    expect(inputKindFor("xsd:decimal")).toBe("number");
    expect(inputKindFor(XSD + "date")).toBe("date");
    expect(inputKindFor(XSD + "boolean")).toBe("boolean");
    expect(inputKindFor(undefined)).toBe("text");
  });
  it("uses the single declared range as the default datatype", () => {
    expect(defaultDatatype(tbox, C("pressure"))).toBe(XSD + "decimal");
    expect(defaultDatatype(tbox, C("name"))).toBeUndefined();
  });
});
