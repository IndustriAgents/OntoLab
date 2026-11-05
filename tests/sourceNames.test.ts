import { expect, it } from "vitest";
import { groundEntityNames } from "../server/services/sourceNames.ts";
it("reduces unsupported full forms to source-present acronyms without changing identity or values", () => {
  const individual = {
    id: "eae",
    classUri: "urn:Tool",
    label: "EcoStruxure Automation Expert (EAE)",
    dataProperties: [{ propUri: "urn:version", value: "V21.2" }],
  };
  const out = groundEntityNames({ individuals: [individual] }, [{ name: "paper", text: "Schinder Electric EcoStruxure (EAE) V21.2" }]);
  expect(out.abox.individuals[0]).toEqual({ ...individual, label: "EAE" });
  expect(out.notes[0]).toContain(individual.label);
  expect(individual.label).toBe("EcoStruxure Automation Expert (EAE)");
});
it("preserves supported expansions and does not invent absent acronyms", () => {
  const make = (label: string) => ({ id: label, classUri: "urn:Tool", label });
  const individuals = [make("Finite State Machine (FSM)"), make("PIPE (Unsupported Name)"), make("Unsupported Name (XYZ)")];
  const out = groundEntityNames({ individuals }, [{ name: "paper", text: "A Finite State\nMachine (FSM) is created by PIPE." }]);
  expect(out.abox.individuals.map((i) => i.label)).toEqual(["Finite State Machine (FSM)", "PIPE", "Unsupported Name (XYZ)"]);
});
