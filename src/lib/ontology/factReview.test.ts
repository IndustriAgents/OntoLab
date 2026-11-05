import { describe, it, expect } from "vitest";
import type { ABoxResult, EvidenceRef, ValidationIssue } from "../../types/abox";
import { applyDecisions, autoReview, countFacts, effectiveAbox, factKey, listFacts, mergeReview, withoutReviews } from "./factReview";

const ev = (confidence: number, extra: Partial<EvidenceRef> = {}): EvidenceRef[] => [{ quote: "q", status: "verified", confidence, ...extra }];

const ABOX: ABoxResult = {
  individuals: [
    {
      id: "acme",
      classUri: "http://ex/o#Supplier",
      evidence: ev(0.95),
      dataProperties: [
        { propUri: "http://ex/o#name", value: "Acme", evidence: ev(0.9) },
        { propUri: "http://ex/o#vat", value: "DE1", evidence: ev(0.4) },
      ],
      objectProperties: [{ propUri: "http://ex/o#supplies", targetId: "plant", evidence: ev(0.99) }],
    },
    { id: "plant", classUri: "http://ex/o#Site", evidence: ev(0.85), objectProperties: [{ propUri: "http://ex/o#locatedIn", targetId: "acme" }] },
  ],
};

describe("autoReview", () => {
  it("trusts facts whose evidence passed, and holds the rest as candidates with a reason", () => {
    const { abox, counts } = autoReview(ABOX, [], { gate: "auto-accept", acceptAt: 0.8, runId: "r1" });
    const rows = new Map(listFacts(abox).map((f) => [f.key, f]));
    expect(rows.get("acme#type")).toMatchObject({ status: "accepted", by: "auto", confidence: 0.95 });
    expect(rows.get("acme#data:http://ex/o#vat|DE1||")).toMatchObject({ status: "candidate", reason: "evidence entailment 0.40 below 0.8" });
    expect(rows.get("plant#link:http://ex/o#locatedIn|acme")).toMatchObject({ status: "candidate", reason: "no verified evidence" });
    expect(counts).toEqual({ accepted: 4, candidate: 2, rejected: 0 });
    expect(abox.individuals[0].review?.runId).toBe("r1");
  });

  it("holds facts that a validation finding points at", () => {
    const issues: ValidationIssue[] = [
      { severity: "warn", code: "range", message: "", where: "", id: "acme", prop: "http://ex/o#supplies" },
      { severity: "error", code: "unknown-class", message: "", where: "", id: "plant" },
    ];
    const rows = new Map(listFacts(autoReview(ABOX, issues, { gate: "auto-accept" }).abox).map((f) => [f.key, f.status]));
    expect(rows.get("acme#link:http://ex/o#supplies|plant")).toBe("candidate");
    expect(rows.get("acme#type")).toBe("accepted");
    expect(rows.get("plant#type")).toBe("candidate");
  });

  it("never overrides a person's decision, skips facts it is told to, and can flag everything", () => {
    const decided = applyDecisions(ABOX, [{ key: "acme#type", status: "rejected", reason: "not a supplier" }], "2026-10-15T00:00:00Z").abox;
    const out = autoReview(decided, [], { gate: "auto-accept", skip: new Set(["plant#type"]) }).abox;
    expect(out.individuals[0].review).toMatchObject({ status: "rejected", by: "user", reason: "not a supplier" });
    expect(out.individuals[1].review).toBeUndefined();
    const flagged = countFacts(autoReview(ABOX, [], { gate: "flag" }).abox);
    expect(flagged).toEqual({ accepted: 0, candidate: 6, rejected: 0 });
    expect(countFacts(autoReview(ABOX, [], { gate: "auto-accept", rejectBelow: 0.5 }).abox).rejected).toBe(1);
  });
});

describe("effectiveAbox", () => {
  const reviewed = applyDecisions(
    autoReview(ABOX, [], { gate: "auto-accept" }).abox,
    [
      { key: "plant#type", status: "rejected" },
      { key: factKey("acme", "data", { propUri: "http://ex/o#name", value: "Acme" }), status: "rejected" },
    ],
    "t",
  ).abox;

  it("leaves rejected facts out, and links to a rejected individual with it", () => {
    const g = effectiveAbox(reviewed, "exclude-rejected");
    expect(g.individuals.map((i) => i.id)).toEqual(["acme"]);
    expect(g.individuals[0].objectProperties).toEqual([]);
    expect(g.individuals[0].dataProperties?.map((d) => d.value)).toEqual(["DE1"]);
  });

  it("keeps only accepted facts under accepted-only, and everything under all", () => {
    expect(effectiveAbox(reviewed, "accepted-only").individuals[0].dataProperties).toEqual([]);
    expect(effectiveAbox(reviewed, "all")).toBe(reviewed);
    // data from before review existed is unchanged (same object)
    expect(effectiveAbox(ABOX, "exclude-rejected")).toBe(ABOX);
  });
});

describe("merging and hashing reviews", () => {
  it("lets a person's decision win, then trust over doubt", () => {
    const user = { status: "rejected" as const, by: "user" as const, at: "2" };
    const cand = { status: "candidate" as const, by: "auto" as const };
    expect(mergeReview(cand, user)).toBe(user);
    expect(mergeReview(undefined, cand)).toBeUndefined(); // the committed fact (no review = accepted) stays trusted
    expect(mergeReview(cand, { status: "accepted", by: "auto" })?.status).toBe("accepted");
  });

  it("strips review metadata for content hashing", () => {
    const stripped = withoutReviews(autoReview(ABOX, [], { gate: "auto-accept" }).abox);
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(ABOX));
  });
});
