import { expect, it } from "vitest";
import { selectKnownEntities } from "../src/lib/ontology/knownEntities";
it("finds explicitly named entities beyond the former 300-entity window", () => {
  const individuals = Array.from({ length: 1000 }, (_, n) => ({ id: `pump-${n}`, classUri: "Pump", label: `Factory pump ${n}` }));
  const selected = selectKnownEntities([{ individuals }], "Factory pump 998 reports damage", 500, new Set(["Pump"]));
  expect(selected.individuals[0].id).toBe("pump-998");
});
it("packs complete records and never truncates a known entity or its evidence", () => {
  const huge = { id: "large", classUri: "Pump", label: "Large pump", sourceEvidence: "x".repeat(10000) },
    small = { id: "small", classUri: "Pump", label: "Small pump" };
  const selected = selectKnownEntities([{ individuals: [huge, small] }], "Large pump, small pump", 200, new Set(["Pump"]));
  expect(selected.individuals).toEqual([small]);
});
it("keeps source-rich identities in the compact index used by chunk extraction", () => {
  const study = {
    id: "study",
    classUri: "Study",
    label: "Full paper title",
    evidence: [{ quote: "x".repeat(10000), status: "verified" as const }],
  };
  const selected = selectKnownEntities([{ individuals: [study] }], "this study", 200, new Set(["Study"]), true);
  expect(selected.individuals).toEqual([study]);
  expect(selected.individuals[0].evidence?.[0].quote.length).toBe(10000);
});
