import { describe, it, expect } from "vitest";
import { checkChange } from "./changeCheck";
import { tbox, C } from "./manualEditing.fixture";
import type { ABoxResult } from "../../types/abox";

const prev: ABoxResult = {
  individuals: [
    { id: "L1", classUri: C("Station") },
    { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] },
  ],
};

describe("checkChange", () => {
  it("is clean for a valid edit", () => {
    const next = { individuals: [prev.individuals[0], { ...prev.individuals[1], dataProperties: [{ propUri: C("pressure"), value: "2.5" }] }] };
    const r = checkChange(prev, next, tbox);
    expect(r.introduced).toEqual([]);
    expect(r.blocking).toEqual([]);
    expect(r.touched).toEqual(["S1"]);
  });

  it("blocks when deleting an individual leaves a link dangling", () => {
    const r = checkChange(prev, { individuals: [prev.individuals[1]] }, tbox);
    expect(r.blocking.map((i) => i.code)).toEqual(["dangling-target"]);
    expect(r.touched).toEqual(["L1"]);
  });

  it("counts a warning as introduced but not blocking", () => {
    const next = { individuals: [prev.individuals[0], { ...prev.individuals[1], dataProperties: [{ propUri: C("pressure"), value: "high" }] }] };
    const r = checkChange(prev, next, tbox);
    expect(r.introduced.map((i) => i.code)).toEqual(["lexical"]);
    expect(r.blocking).toEqual([]);
  });

  it("reports a fixed finding as resolved", () => {
    const broken = { individuals: [prev.individuals[0], { id: "S1", classUri: C("Sensor") }] };
    const r = checkChange(broken, prev, tbox);
    expect(r.resolved.map((i) => i.code)).toEqual(["restriction"]);
    expect(r.introduced).toEqual([]);
  });
});
