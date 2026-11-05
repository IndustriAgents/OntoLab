// Modular-ontology validation model. A change (a new or edited .ttl module) is
// validated against the committed base ontology before it can be merged in:
// structural checks (syntax, references, hierarchy, typing) plus a regression
// diff that confirms the change does not break what already existed.

/** One uploaded/authored ontology module (a single .ttl file's worth of triples). */
export interface OntoModule {
  id: string;
  name: string;
  turtle: string;
}

export type IssueCode =
  | "parse-error"
  | "unresolved-import"
  | "dangling-ref"
  | "subclass-cycle"
  | "type-conflict"
  | "removed-term"
  | "modified-term"
  | "unsatisfiable-class"
  | "entailment-changed";

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  code: IssueCode;
  message: string;
  /** module the issue originates from (name) */
  module?: string;
  /** URI the issue is about */
  subject?: string;
  /** the asserted axioms behind a reasoner finding, as readable lines */
  explanation?: string[];
}

export interface OntoDiff {
  added: { classes: string[]; objectProps: string[]; dataProps: string[] };
  removed: { classes: string[]; objectProps: string[]; dataProps: string[] };
  /** URIs that exist in the base and whose axioms (parents/domain/range) changed */
  modified: string[];
}

export interface ValidationReport {
  /** true when there are no "error"-severity issues */
  ok: boolean;
  issues: ValidationIssue[];
  /** base → (base + change) */
  diff: OntoDiff;
  /** what the reasoner found (absent when reasoning was turned off) */
  reasoning?: {
    /** every unsatisfiable class after the change */
    unsatisfiable: string[];
    /** of those, the ones this change made unsatisfiable */
    newlyUnsat: string[];
    /** entailments added / removed by the change */
    added: number;
    removed: number;
    /** changed entailments between terms that both existed before */
    unintended: number;
    incomplete: string[];
  };
}
