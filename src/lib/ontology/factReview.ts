// Per-fact review (Research Areas 7–8): every extracted assertion is a
// candidate until evidence and validation say it can be trusted, or a person
// decides. Candidates, accepted and rejected facts live side by side in the
// A-Box, so nothing is silently dropped, while the effective graph — what is
// exported, queried and reasoned over — follows the project's review policy.

import type { ABoxDataProp, ABoxIndividual, ABoxObjectProp, ABoxResult, EvidenceRef, FactReview, FactStatus, ValidationIssue } from "../../types/abox";

export type ReviewPolicy = "all" | "exclude-rejected" | "accepted-only";
export type FactKind = "type" | "data" | "link";

/** A fact without a review predates review and counts as accepted. */
export const statusOf = (r?: FactReview): FactStatus => r?.status ?? "accepted";

export const dataKey = (d: Pick<ABoxDataProp, "propUri" | "value" | "datatype" | "lang">) => `${d.propUri}|${d.value}|${d.datatype ?? ""}|${d.lang ?? ""}`;
export const linkKey = (o: Pick<ABoxObjectProp, "propUri" | "targetId">) => `${o.propUri}|${o.targetId}`;

/** Stable address of one assertion: `<id>#type`, `<id>#data:<prop|value|…>`, `<id>#link:<prop|target>`. */
export function factKey(individualId: string, kind: FactKind, a?: ABoxDataProp | ABoxObjectProp): string {
  if (kind === "type" || !a) return `${individualId}#type`;
  return kind === "data" ? `${individualId}#data:${dataKey(a as ABoxDataProp)}` : `${individualId}#link:${linkKey(a as ABoxObjectProp)}`;
}

export interface FactRow {
  key: string;
  individualId: string;
  label?: string;
  kind: FactKind;
  classUri?: string;
  propUri?: string;
  value?: string;
  targetId?: string;
  status: FactStatus;
  by?: FactReview["by"];
  reason?: string;
  confidence?: number;
  evidence: EvidenceRef[];
}

/** Every assertion as a row (for review queues and counts). */
export function listFacts(abox: ABoxResult): FactRow[] {
  const rows: FactRow[] = [];
  for (const ind of abox.individuals) {
    const base = { individualId: ind.id, ...(ind.label ? { label: ind.label } : {}) };
    const row = (kind: FactKind, review: FactReview | undefined, evidence: EvidenceRef[] | undefined, extra: Partial<FactRow>, a?: ABoxDataProp | ABoxObjectProp): FactRow => ({
      ...base,
      key: factKey(ind.id, kind, a),
      kind,
      status: statusOf(review),
      ...(review?.by ? { by: review.by } : {}),
      ...(review?.reason ? { reason: review.reason } : {}),
      ...(review?.confidence != null ? { confidence: review.confidence } : bestConfidence(evidence) != null ? { confidence: bestConfidence(evidence)! } : {}),
      evidence: evidence ?? [],
      ...extra,
    });
    rows.push(row("type", ind.review, ind.evidence, { classUri: ind.classUri }));
    for (const d of ind.dataProperties ?? []) rows.push(row("data", d.review, d.evidence, { propUri: d.propUri, value: d.value }, d));
    for (const o of ind.objectProperties ?? []) rows.push(row("link", o.review, o.evidence, { propUri: o.propUri, targetId: o.targetId }, o));
  }
  return rows;
}

export function countFacts(abox: ABoxResult): Record<FactStatus, number> {
  const out: Record<FactStatus, number> = { candidate: 0, accepted: 0, rejected: 0 };
  for (const r of listFacts(abox)) out[r.status]++;
  return out;
}

/** The strongest verified support among a fact's evidence (undefined when nothing was checked). */
function bestConfidence(evidence: EvidenceRef[] | undefined): number | undefined {
  let best: number | undefined;
  for (const e of evidence ?? []) if (e.status === "verified" && e.confidence != null) best = Math.max(best ?? 0, e.confidence);
  return best;
}

export interface AutoReviewOptions {
  /**
   * off — no review states (everything trusted, as before review existed)
   * flag — every fact is a candidate for a person
   * auto-accept — trusted when the evidence gate passed with confidence ≥ acceptAt and no validation finding points at it
   */
  gate: "off" | "flag" | "auto-accept";
  /** default 0.8 */
  acceptAt?: number;
  /** below this confidence a fact is rejected automatically (off unless set: entailment models have false negatives) */
  rejectBelow?: number;
  runId?: string;
  at?: string;
  /** fact keys to leave exactly as they are (e.g. facts of the committed graph an incremental run builds on) */
  skip?: Set<string>;
}

/**
 * Set review states on facts that have no human decision. Validation findings
 * block auto-acceptance: an error on an individual holds all its facts, a
 * finding about a property holds that property's assertions, and any other
 * finding on an individual holds its type.
 */
export function autoReview(abox: ABoxResult, issues: ValidationIssue[], opts: AutoReviewOptions): { abox: ABoxResult; counts: Record<FactStatus, number> } {
  if (opts.gate === "off") return { abox, counts: countFacts(abox) };
  const acceptAt = opts.acceptAt ?? 0.8;
  const heldIndividual = new Set(issues.filter((i) => i.id && i.severity === "error" && !i.prop).map((i) => i.id!));
  const heldType = new Set(issues.filter((i) => i.id && !i.prop).map((i) => i.id!));
  const heldProp = new Set(issues.filter((i) => i.id && i.prop).map((i) => `${i.id}|${i.prop}`));

  const decide = (current: FactReview | undefined, evidence: EvidenceRef[] | undefined, held: boolean): FactReview | undefined => {
    if (current?.by === "user") return current;
    const confidence = bestConfidence(evidence);
    const stamp = { by: "auto" as const, ...(opts.at ? { at: opts.at } : {}), ...(opts.runId ? { runId: opts.runId } : {}), ...(confidence != null ? { confidence } : {}) };
    if (opts.gate === "flag") return { status: "candidate", ...stamp, reason: "review requested for every fact" };
    if (opts.rejectBelow != null && confidence != null && confidence < opts.rejectBelow) return { status: "rejected", ...stamp, reason: `evidence entailment ${confidence.toFixed(2)} below ${opts.rejectBelow}` };
    if (held) return { status: "candidate", ...stamp, reason: "a validation finding points at it" };
    if (confidence == null) return { status: "candidate", ...stamp, reason: "no verified evidence" };
    if (confidence < acceptAt) return { status: "candidate", ...stamp, reason: `evidence entailment ${confidence.toFixed(2)} below ${acceptAt}` };
    if ((evidence ?? []).some((e) => e.review)) return { status: "candidate", ...stamp, reason: "some evidence needs review" };
    return { status: "accepted", ...stamp };
  };

  const skip = opts.skip ?? new Set<string>();
  const individuals: ABoxIndividual[] = abox.individuals.map((ind) => {
    const all = heldIndividual.has(ind.id);
    const out: ABoxIndividual = { ...ind };
    if (!skip.has(factKey(ind.id, "type"))) {
      const r = decide(ind.review, ind.evidence, all || heldType.has(ind.id));
      if (r) out.review = r;
    }
    const data = (d: ABoxDataProp): ABoxDataProp => (skip.has(factKey(ind.id, "data", d)) ? d : { ...d, review: decide(d.review, d.evidence, all || heldProp.has(`${ind.id}|${d.propUri}`)) });
    const link = (o: ABoxObjectProp): ABoxObjectProp => (skip.has(factKey(ind.id, "link", o)) ? o : { ...o, review: decide(o.review, o.evidence, all || heldProp.has(`${ind.id}|${o.propUri}`)) });
    if (ind.dataProperties) out.dataProperties = ind.dataProperties.map(data);
    if (ind.objectProperties) out.objectProperties = ind.objectProperties.map(link);
    return out;
  });
  const next = { ...abox, individuals };
  return { abox: next, counts: countFacts(next) };
}

/**
 * The graph that is exported, queried and reasoned over. Rejected facts never
 * are; with "accepted-only", candidates are left out too. An individual whose
 * type is left out takes its assertions and the links to it along.
 */
export function effectiveAbox(abox: ABoxResult, policy: ReviewPolicy = "exclude-rejected"): ABoxResult {
  if (policy === "all") return abox;
  const keep = (r?: FactReview) => (policy === "accepted-only" ? statusOf(r) === "accepted" : statusOf(r) !== "rejected");
  const removed = new Set(abox.individuals.filter((i) => !keep(i.review)).map((i) => i.id));
  // nothing to leave out: the same object, so hashes and caches see no change
  const anyFact = abox.individuals.some((i) => removed.has(i.id) || (i.dataProperties ?? []).some((d) => !keep(d.review)) || (i.objectProperties ?? []).some((o) => !keep(o.review) || removed.has(o.targetId)));
  if (!anyFact) return abox;
  const individuals = abox.individuals
    .filter((i) => !removed.has(i.id))
    .map((i) => ({
      ...i,
      ...(i.dataProperties ? { dataProperties: i.dataProperties.filter((d) => keep(d.review)) } : {}),
      ...(i.objectProperties ? { objectProperties: i.objectProperties.filter((o) => keep(o.review) && !removed.has(o.targetId)) } : {}),
    }));
  return { ...abox, individuals };
}

/** Which of two reviews of the same fact wins when partial results are merged: a person's decision, then trust, then doubt. */
export function mergeReview(a: FactReview | undefined, b: FactReview | undefined): FactReview | undefined {
  const rank = (r: FactReview | undefined) => (r?.by === "user" ? 4 : statusOf(r) === "accepted" ? 3 : r?.status === "candidate" ? 2 : 1);
  if (a?.by === "user" && b?.by === "user") return (a.at ?? "") >= (b.at ?? "") ? a : b;
  return rank(b) > rank(a) ? b : a;
}

export interface FactDecision {
  key: string;
  status: FactStatus;
  reason?: string;
}

/** Apply a person's decisions to facts addressed by factKey. Returns the A-Box and how many facts were found. */
export function applyDecisions(abox: ABoxResult, decisions: FactDecision[], at: string): { abox: ABoxResult; applied: number } {
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  let applied = 0;
  const review = (key: string, cur: FactReview | undefined): FactReview | undefined => {
    const d = byKey.get(key);
    if (!d) return cur;
    applied++;
    return { status: d.status, by: "user", at, ...(d.reason ? { reason: d.reason.slice(0, 300) } : {}), ...(cur?.confidence != null ? { confidence: cur.confidence } : {}), ...(cur?.runId ? { runId: cur.runId } : {}) };
  };
  const individuals = abox.individuals.map((ind) => {
    const out: ABoxIndividual = { ...ind };
    const r = review(factKey(ind.id, "type"), ind.review);
    if (r) out.review = r;
    if (ind.dataProperties) out.dataProperties = ind.dataProperties.map((d) => ({ ...d, review: review(factKey(ind.id, "data", d), d.review) }));
    if (ind.objectProperties) out.objectProperties = ind.objectProperties.map((o) => ({ ...o, review: review(factKey(ind.id, "link", o), o.review) }));
    return out;
  });
  return { abox: { ...abox, individuals }, applied };
}

/** The A-Box without review metadata (what the fact content hash is computed over). */
export function withoutReviews(abox: ABoxResult): ABoxResult {
  return {
    ...abox,
    individuals: abox.individuals.map(({ review: _r, ...ind }) => {
      void _r;
      return {
        ...ind,
        ...(ind.dataProperties ? { dataProperties: ind.dataProperties.map(({ review: _d, ...d }) => (void _d, d)) } : {}),
        ...(ind.objectProperties ? { objectProperties: ind.objectProperties.map(({ review: _o, ...o }) => (void _o, o)) } : {}),
      };
    }),
  };
}
