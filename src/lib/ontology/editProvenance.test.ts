import { describe, it, expect } from "vitest";
import { stampManual } from "./editProvenance";
import type { RevisionContent } from "../../types/project";
import { C } from "./manualEditing.fixture";

const at = "2026-10-27T10:00:00.000Z";
const opts = { at, by: "u1", label: "Edit individual" };
const base = (): RevisionContent => ({
  modules: [],
  baseIri: "",
  abox: {
    individuals: [
      { id: "L1", classUri: C("Station"), label: "Line 1" },
      {
        id: "S1",
        classUri: C("Sensor"),
        dataProperties: [{ propUri: C("pressure"), value: "2.5", review: { status: "candidate", by: "auto" } }],
        objectProperties: [{ propUri: C("partOf"), targetId: "L1" }],
      },
    ],
  },
});

describe("stampManual", () => {
  it("stamps an added value and logs it, leaving untouched facts alone", () => {
    const prev = base();
    const s1 = prev.abox!.individuals[1];
    const next = { individuals: [prev.abox!.individuals[0], { ...s1, dataProperties: [...s1.dataProperties!, { propUri: C("name"), value: "PT-1" }] }] };
    const out = stampManual(prev, next, opts);
    const dps = out.abox!.individuals[1].dataProperties!;
    expect(dps[0].review).toEqual({ status: "candidate", by: "auto" });
    expect(dps[1].review).toEqual({ status: "accepted", by: "user", at, editedBy: "u1" });
    expect(out.edits).toHaveLength(1);
    expect(out.edits![0]).toMatchObject({ kind: "add", by: "u1", label: "Edit individual", target: `S1#data:${C("name")}|PT-1||` });
  });

  it("treats a changed value as remove + add", () => {
    const prev = base();
    const s1 = prev.abox!.individuals[1];
    const next = { individuals: [prev.abox!.individuals[0], { ...s1, dataProperties: [{ ...s1.dataProperties![0], value: "3.0" }] }] };
    const out = stampManual(prev, next, opts);
    expect(out.abox!.individuals[1].dataProperties![0].review?.by).toBe("user");
    expect(out.edits!.map((e) => e.kind).sort()).toEqual(["add", "remove"]);
  });

  it("stamps a new individual with all its facts", () => {
    const prev = base();
    const next = { individuals: [...prev.abox!.individuals, { id: "S2", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] }] };
    const out = stampManual(prev, next, opts);
    const s2 = out.abox!.individuals[2];
    expect(s2.review?.by).toBe("user");
    expect(s2.objectProperties![0].review?.by).toBe("user");
    expect(out.edits).toEqual([expect.objectContaining({ kind: "add", target: "S2#type" })]);
  });

  it("logs a class change, a relabel and a removal", () => {
    const prev = base();
    const next = { individuals: [{ ...prev.abox!.individuals[0], label: "Line A" }, { ...prev.abox!.individuals[1], classUri: C("Actuator") }] };
    const changed = stampManual(prev, next, opts);
    expect(changed.abox!.individuals[1].review?.by).toBe("user");
    expect(changed.edits!.map((e) => e.target).sort()).toEqual(["L1#label", "S1#type"]);
    const removed = stampManual(prev, { individuals: [prev.abox!.individuals[0]] }, opts);
    expect(removed.edits).toEqual([expect.objectContaining({ kind: "remove", target: "S1#type" })]);
  });

  it("adds nothing to the log when nothing changed", () => {
    const prev = base();
    expect(stampManual(prev, prev.abox!, opts).edits).toBeUndefined();
  });
});
