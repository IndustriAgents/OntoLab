import type { ABoxResult } from "../../../types/abox";
import type { OntoModule } from "../../../types/validation";
import { addABoxAxioms, axiomsOfModules } from "./axioms";
import { runRL, type RLSession } from "./rl";

export * from "./types";
export { AxiomSet, addTBoxAxioms, addABoxAxioms, axiomsOfModules, describeAxiom, explanationLines } from "./axioms";
export { reasonRL, runRL, type RLInput, type RLSession } from "./rl";
export { entailmentDiff, type EntailmentDiff, type EntailmentChange } from "./diff";

/** Reason over ontology modules (and optionally an A-Box) with the in-process RL tier. */
export function reasonModules(
  modules: Pick<OntoModule, "name" | "turtle">[],
  opts: { abox?: ABoxResult; una?: boolean; maxFacts?: number } = {},
): RLSession {
  const set = axiomsOfModules(modules);
  if (opts.abox) addABoxAxioms(set, opts.abox);
  return runRL({ axioms: set.list, una: opts.una, maxFacts: opts.maxFacts });
}
