import { describe, it, expect } from "vitest";
import { applyTermEdit, tboxImpact, termUsage, moduleOfTerm } from "./tboxForm";
import { parseTBox } from "./tboxParser";
import { TTL, C, XSD } from "./manualEditing.fixture";
import type { ABoxResult } from "../../types/abox";

const mod = { id: "m1", name: "core.ttl", turtle: TTL };

describe("applyTermEdit", () => {
  it("adds a class with parent and disjointness", () => {
    const out = parseTBox(applyTermEdit(TTL, { upsert: { kind: "class", uri: C("Valve"), label: "Valve", parents: [C("Component")], disjointWith: [C("Sensor")] } }));
    expect(out.classes.find((c) => c.uri === C("Valve"))?.label).toBe("Valve");
    expect(out.subClassOf[C("Valve")]).toEqual([C("Component")]);
    expect(out.classes.find((c) => c.uri === C("Sensor"))?.disjointWith).toContain(C("Valve"));
  });

  it("replaces a term's declaration but keeps its restrictions and other terms", () => {
    const out = parseTBox(applyTermEdit(TTL, { upsert: { kind: "class", uri: C("Sensor"), parents: [C("Component")], disjointWith: [] } }));
    expect(out.classes.find((c) => c.uri === C("Sensor"))?.disjointWith ?? []).not.toContain(C("Actuator"));
    expect(out.classes.find((c) => c.uri === C("Actuator"))?.disjointWith ?? []).not.toContain(C("Sensor"));
    expect(out.restrictions?.some((r) => r.onClass === C("Sensor") && r.onProperty === C("partOf"))).toBe(true);
    expect(out.subClassOf[C("Actuator")]).toEqual([C("Component")]);
  });

  it("writes properties with a union domain, a datatype range and functionality", () => {
    const out = parseTBox(
      applyTermEdit(TTL, { upsert: { kind: "data", uri: C("serial"), domain: [C("Sensor"), C("Actuator")], range: [XSD + "string"], functional: true } }),
    );
    const p = out.dataProps.find((x) => x.uri === C("serial"))!;
    expect(p.domain.sort()).toEqual([C("Actuator"), C("Sensor")]);
    expect(p.range).toEqual([XSD + "string"]);
    expect(p.functional).toBe(true);
  });

  it("changes a property's range in place", () => {
    const out = parseTBox(applyTermEdit(TTL, { upsert: { kind: "object", uri: C("partOf"), domain: [C("Component")], range: [C("Component")] } }));
    expect(out.objectProps.find((x) => x.uri === C("partOf"))?.range).toEqual([C("Component")]);
  });

  it("removes and renames terms", () => {
    expect(parseTBox(applyTermEdit(TTL, { remove: C("Actuator") })).classes.some((c) => c.uri === C("Actuator"))).toBe(false);
    const renamed = parseTBox(applyTermEdit(TTL, { rename: { from: C("Station"), to: C("Plant") } }));
    expect(renamed.classes.some((c) => c.uri === C("Plant"))).toBe(true);
    expect(renamed.objectProps.find((p) => p.uri === C("partOf"))?.range).toEqual([C("Plant")]);
  });
});

describe("tboxImpact", () => {
  const abox: ABoxResult = {
    individuals: [
      { id: "L1", classUri: C("Station") },
      { id: "A1", classUri: C("Actuator"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] },
    ],
  };

  it("flags individuals that would use a removed class", () => {
    expect(termUsage(abox, C("Actuator"))).toEqual(["A1"]);
    const impact = tboxImpact([mod], { ...mod, turtle: applyTermEdit(TTL, { remove: C("Actuator") }) }, abox);
    expect(impact.ok).toBe(false);
    expect(impact.affected).toContain("A1");
    expect(impact.introduced.some((i) => i.code === "unknown-class")).toBe(true);
  });

  it("allows a deliberate removal or rename of an unused term", () => {
    const unused = { individuals: [{ id: "L1", classUri: C("Station") }] };
    const removed = { ...mod, turtle: applyTermEdit(TTL, { remove: C("Actuator") }) };
    expect(tboxImpact([mod], removed, unused).ok).toBe(false);
    expect(tboxImpact([mod], removed, unused, undefined, { intended: [C("Actuator")] }).ok).toBe(true);
    const renamed = { ...mod, turtle: applyTermEdit(TTL, { rename: { from: C("Actuator"), to: C("Motor") } }) };
    expect(tboxImpact([mod], renamed, unused, undefined, { intended: [C("Actuator")] }).ok).toBe(true);
  });

  it("is ok for a harmless addition", () => {
    const impact = tboxImpact([mod], { ...mod, turtle: applyTermEdit(TTL, { upsert: { kind: "class", uri: C("Valve"), parents: [C("Component")], disjointWith: [] } }) }, abox);
    expect(impact.ok).toBe(true);
    expect(impact.introduced).toEqual([]);
  });

  it("finds the module that declares a term", () => {
    expect(moduleOfTerm([{ id: "x", name: "x.ttl", turtle: "" }, mod], C("Sensor"))?.id).toBe("m1");
  });
});
