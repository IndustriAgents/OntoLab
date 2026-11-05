import type { ABoxIndividual, EvidenceRef } from "../../types/abox";

/** Structured evidence, or legacy free-text evidence without a location. */
export function legacyList(ind: ABoxIndividual): EvidenceRef[] {
  if (ind.evidence?.length) return ind.evidence;
  return ind.sourceEvidence ? [{ quote: ind.sourceEvidence, status: "legacy" }] : [];
}

/** All evidence attached to an individual and its claims. */
export function allEvidence(ind: ABoxIndividual): EvidenceRef[] {
  return [...legacyList(ind), ...(ind.dataProperties ?? []).flatMap((d) => d.evidence ?? []), ...(ind.objectProperties ?? []).flatMap((o) => o.evidence ?? [])];
}

export type EvidenceFilter = "all" | "verified" | "needs-review" | "none";

export function matchesEvidence(ind: ABoxIndividual, f: EvidenceFilter): boolean {
  if (f === "all") return true;
  const ev = allEvidence(ind);
  if (f === "none") return ev.length === 0;
  if (f === "verified") return ev.length > 0 && ev.every((e) => e.status === "verified" && !e.review);
  // Needs review: an unlocated quote, a quote the entailment check doubts, or no quote at all.
  return ev.some((e) => e.status === "unverified" || e.status === "legacy" || e.review) || ev.length === 0;
}
