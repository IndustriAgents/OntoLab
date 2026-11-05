import type { Axiom, Entailment, ReasonerReport } from "./types";

export interface EntailmentChange extends Entailment {
  /** asserted axioms behind an added entailment (empty for removed ones) */
  explanation?: Axiom[];
}

export interface EntailmentDiff {
  added: EntailmentChange[];
  removed: EntailmentChange[];
  /** added/removed entailments between terms that both existed before the change — the ones a reviewer should look at */
  unintended: EntailmentChange[];
  /** classes that were satisfiable before and are not after */
  newlyUnsat: string[];
  /** classes that were unsatisfiable before and are fine after */
  fixedUnsat: string[];
}

const key = (e: Entailment) => `${e.kind}|${e.args.join("|")}`;

/**
 * Compare what two reasoner runs entail (class and property subsumptions,
 * satisfiability). `baseTerms` are the terms of the ontology before the change:
 * an entailment that only mentions new terms is the point of the change, while
 * one between two existing terms changes what the existing ontology means.
 */
export function entailmentDiff(
  before: ReasonerReport,
  after: ReasonerReport,
  baseTerms: Set<string>,
  explainAfter?: (sub: string, sup: string) => Axiom[],
): EntailmentDiff {
  const list = (r: ReasonerReport) => [...r.subsumptions, ...r.propertySubsumptions];
  const b = new Map(list(before).map((e) => [key(e), e]));
  const a = new Map(list(after).map((e) => [key(e), e]));
  const afterTerms = new Set<string>();
  for (const e of list(after)) for (const t of e.args) afterTerms.add(t);

  const added: EntailmentChange[] = [];
  const removed: EntailmentChange[] = [];
  for (const [k, e] of a) {
    if (b.has(k)) continue;
    const change: EntailmentChange = { ...e };
    if (explainAfter && e.kind === "subClassOf") change.explanation = explainAfter(e.args[0], e.args[1]);
    added.push(change);
  }
  for (const [k, e] of b) if (!a.has(k)) removed.push({ ...e });

  const old = (e: Entailment) => e.args.every((t) => baseTerms.has(t));
  const unintended = [...added.filter(old), ...removed.filter((e) => old(e) && e.args.every((t) => afterTerms.has(t)))];

  const ub = new Set(before.unsatisfiable.map((u) => u.cls));
  const ua = new Set(after.unsatisfiable.map((u) => u.cls));
  return {
    added,
    removed,
    unintended,
    newlyUnsat: [...ua].filter((c) => !ub.has(c)).sort(),
    fixedUnsat: [...ub].filter((c) => !ua.has(c)).sort(),
  };
}
