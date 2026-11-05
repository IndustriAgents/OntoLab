import { describe, it, expect } from "vitest";
import { ancestorsOf, typeClosure, satisfies, childrenMap } from "./hierarchy";
import type { TBoxModel } from "../../types/tbox";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;

const tbox = {
  subClassOf: {
    [C("Actuator")]: [C("Component")],
    [C("Cylinder")]: [C("Actuator")],
    [C("Sensor")]: [C("Component")],
    [C("Component")]: [C("Thing")],
    // multiple inheritance
    [C("SmartCylinder")]: [C("Cylinder"), C("Sensor")],
  },
} as Pick<TBoxModel, "subClassOf">;

const cyclic = {
  subClassOf: { [C("A")]: [C("B")], [C("B")]: [C("C")], [C("C")]: [C("A")] },
} as Pick<TBoxModel, "subClassOf">;

describe("ancestorsOf", () => {
  it("includes the class itself and all transitive parents", () => {
    expect([...ancestorsOf(tbox, C("Cylinder"))].sort()).toEqual(
      [C("Actuator"), C("Component"), C("Cylinder"), C("Thing")].sort(),
    );
  });

  it("follows every branch of multiple inheritance", () => {
    const anc = ancestorsOf(tbox, C("SmartCylinder"));
    expect(anc.has(C("Actuator"))).toBe(true);
    expect(anc.has(C("Sensor"))).toBe(true);
    expect(anc.has(C("Thing"))).toBe(true);
  });

  it("returns just the class when it has no declared parents", () => {
    expect([...ancestorsOf(tbox, C("Unknown"))]).toEqual([C("Unknown")]);
  });

  it("returns an empty set for an undefined class", () => {
    expect(ancestorsOf(tbox, undefined).size).toBe(0);
  });

  it("terminates on a subClassOf cycle", () => {
    expect([...ancestorsOf(cyclic, C("A"))].sort()).toEqual([C("A"), C("B"), C("C")]);
  });
});

describe("typeClosure", () => {
  it("unions the ancestors of every type and ignores undefined entries", () => {
    const closure = typeClosure(tbox, [C("Cylinder"), undefined, C("Sensor")]);
    expect(closure.has(C("Cylinder"))).toBe(true);
    expect(closure.has(C("Sensor"))).toBe(true);
    expect(closure.has(C("Component"))).toBe(true);
    expect(closure.has(C("SmartCylinder"))).toBe(false);
  });
});

describe("satisfies", () => {
  it("treats an empty allowed list as \"anything goes\"", () => {
    expect(satisfies(tbox, [], [C("Cylinder")])).toBe(true);
    expect(satisfies(tbox, [], [undefined])).toBe(true);
  });

  it("accepts a subclass of an allowed class", () => {
    expect(satisfies(tbox, [C("Component")], [C("Cylinder")])).toBe(true);
  });

  it("rejects an unrelated class", () => {
    expect(satisfies(tbox, [C("Signal")], [C("Cylinder")])).toBe(false);
  });

  it("accepts when any of several allowed alternatives matches (union domains)", () => {
    expect(satisfies(tbox, [C("Signal"), C("Sensor")], [C("Sensor")])).toBe(true);
  });

  it("accepts when any of the individual's own types matches", () => {
    expect(satisfies(tbox, [C("Signal")], [C("Cylinder"), C("Signal")])).toBe(true);
  });
});

describe("childrenMap", () => {
  const model = {
    subClassOf: tbox.subClassOf,
    classes: [C("Component"), C("Actuator"), C("Cylinder"), C("Sensor"), C("SmartCylinder")].map((uri) => ({ uri })),
  } as Pick<TBoxModel, "subClassOf" | "classes">;

  it("inverts subClassOf into direct children", () => {
    const kids = childrenMap(model);
    expect(kids.get(C("Component"))!.sort()).toEqual([C("Actuator"), C("Sensor")].sort());
    expect(kids.get(C("Actuator"))).toEqual([C("Cylinder")]);
  });

  it("gives every declared class an entry, even leaves", () => {
    const kids = childrenMap(model);
    expect(kids.get(C("SmartCylinder"))).toEqual([]);
  });

  it("creates entries for undeclared parents referenced by subClassOf", () => {
    const kids = childrenMap(model);
    expect(kids.get(C("Thing"))).toEqual([C("Component")]);
  });
});
