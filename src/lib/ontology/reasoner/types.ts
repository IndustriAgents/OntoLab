// Shared shapes for the reasoning tiers. The in-process OWL 2 RL engine (rl.ts)
// and the optional DL sidecar (server/services/reasoner.ts) both report in these
// terms, so validation, alignment and impact analysis never care which ran.

export type AxiomKind =
  | "subClassOf"
  | "equivalentClass"
  | "disjointWith"
  | "domain"
  | "range"
  | "subPropertyOf"
  | "equivalentProperty"
  | "inverseOf"
  | "functional"
  | "characteristic"
  | "propertyDisjointWith"
  | "restriction"
  | "type"
  | "link"
  | "data"
  | "sameAs"
  | "differentFrom"
  /** an axiom the DL tier reports that has no shape here; args[0] is its rendering */
  | "other";

/**
 * One asserted axiom. `args` by kind:
 * subClassOf/equivalentClass/disjointWith [c, d] · domain/range [p, c]
 * subPropertyOf/equivalentProperty/inverseOf/propertyDisjointWith [p, q]
 * functional [p] · characteristic [p, name]
 * restriction [cls, prop, kind, value?, n?] (n as a decimal string)
 * type [ind, cls] · link [ind, prop, ind] · data [ind, prop, value, datatype?]
 * sameAs/differentFrom [ind, ind-or-iri] · other [rendered text]
 */
export interface Axiom {
  id: string;
  kind: AxiomKind;
  args: string[];
  /** module (file) the axiom comes from, for T-Box axioms */
  module?: string;
  /** individual the axiom is about, for A-Box axioms */
  individualId?: string;
}

export type EntailmentKind = "subClassOf" | "equivalentClass" | "subPropertyOf" | "type" | "link";

export interface Entailment {
  kind: EntailmentKind;
  args: string[];
}

export type ClashCode =
  /** reported by the DL tier when it can only say that the whole is inconsistent */
  | "inconsistent"
  | "disjoint-types"
  | "unsat-type"
  | "different-same"
  | "functional-clash"
  | "inverse-functional-clash"
  | "irreflexive"
  | "asymmetric"
  | "disjoint-properties"
  | "max-card";

/** An A-Box inconsistency, with the asserted axioms that produce it. */
export interface Clash {
  code: ClashCode;
  message: string;
  /** individual ids involved */
  subjects: string[];
  explanation: Axiom[];
}

export interface UnsatClass {
  cls: string;
  reason: string;
  explanation: Axiom[];
}

export interface ReasonerReport {
  tier: "rl" | "dl";
  /** e.g. "ontolab-rl", "hermit", "elk" */
  reasoner: string;
  /** false when any clash was found (an unsatisfiable class alone keeps the ontology consistent) */
  consistent: boolean;
  clashes: Clash[];
  unsatisfiable: UnsatClass[];
  /** every named subsumption C ⊑ D (C ≠ D, owl:Thing left out), asserted or inferred */
  subsumptions: Entailment[];
  /** named property subsumptions p ⊑ q */
  propertySubsumptions: Entailment[];
  /** individual id -> classes it belongs to beyond what was asserted */
  inferredTypes: Record<string, string[]>;
  /** links derived by the rules (not asserted) */
  inferredLinks: Entailment[];
  /** groups of individual ids that denote the same thing (owl:sameAs, shared external ids, or functional properties without UNA) */
  sameAs: string[][];
  /** what this tier could not check (open-world features it does not model, caps hit, sidecar down) */
  incomplete: string[];
  stats: { axioms: number; facts: number; ms: number };
}
