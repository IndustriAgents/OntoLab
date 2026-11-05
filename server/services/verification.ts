// The evidence gate (B4). locateQuote already proves a quote exists in the
// source; this checks that the quote actually SAYS the claim. Each assertion is
// verbalised ("Acme Robotics is the supplier of the agreement.") and scored for
// entailment against its own quote — never judged without one (KGValidator: an
// ungrounded judge accepts nearly everything; PERSEUS: an NLI gate catches the
// plausible-but-unsupported facts). The score is stored on the evidence as its
// confidence; low scores are marked for review in the inspector.

import type { ABoxIndividual, ABoxResult, EvidenceRef } from "../../src/types/abox.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { localName } from "../../src/lib/ontology/iri.ts";
import { displayName } from "../../src/lib/ontology/resolution.ts";
import { NLI_REVIEW_THRESHOLD } from "../config.ts";
import type { NliScorer } from "../ml/nli.ts";

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

function termLabel(tbox: TBoxModel, uri: string): string {
  const t =
    tbox.classes.find((c) => c.uri === uri) ?? tbox.objectProps.find((p) => p.uri === uri) ?? tbox.dataProps.find((p) => p.uri === uri);
  return (t?.label ?? words(localName(uri))).trim();
}

/** "has supplier" → "has supplier"; "supplier" → "has supplier"; "isPartOf" → "is part of". */
function relationPhrase(label: string): string {
  return /^(has|is|was|were|are|belongs|contains|includes|uses|requires|located|part|member|issued|signed)\b/i.test(label)
    ? label
    : `has ${label}`;
}

export function verbaliseType(ind: ABoxIndividual, tbox: TBoxModel): string {
  const cls = termLabel(tbox, ind.classUri);
  return `${displayName(ind)} is a ${cls}.`;
}

export function verbaliseData(ind: ABoxIndividual, d: { propUri: string; value: string }, tbox: TBoxModel): string {
  return `${displayName(ind)} ${relationPhrase(termLabel(tbox, d.propUri))} ${d.value}.`;
}

export function verbaliseLink(
  ind: ABoxIndividual,
  o: { propUri: string; targetId: string },
  target: ABoxIndividual | undefined,
  tbox: TBoxModel,
): string {
  return `${displayName(ind)} ${relationPhrase(termLabel(tbox, o.propUri))} ${target ? displayName(target) : o.targetId.replace(/[-_]+/g, " ")}.`;
}

interface Job {
  ref: EvidenceRef;
  claim: string;
  set: (ev: EvidenceRef) => void;
}

export interface VerifyResult {
  abox: ABoxResult;
  scored: number;
  flagged: number;
}

/**
 * Score every quoted claim that has no confidence yet. Unlocated quotes are
 * still scored (the quote may be right even if the text moved) but always
 * marked for review.
 */
/**
 * The quote with one sentence either side, from the document text (a claim
 * often rests on a pronoun the previous sentence resolves). Capped so the
 * premise stays about the claim.
 */
export function contextAround(text: string, start: number, end: number, maxChars = 700): string {
  const isEnd = (ch: string | undefined) => ch === "." || ch === "!" || ch === "?" || ch === "\n";
  // left: past the end of the previous sentence, up to the end of the one before it
  let a = start;
  let seen = 0;
  while (a > 0) {
    if (isEnd(text[a - 1]) && ++seen === 2) break;
    a--;
  }
  // right: to the end of the quote's sentence, then of the next one
  let b = end;
  for (let n = 0; n < 2 && b < text.length; n++) {
    while (b < text.length && !isEnd(text[b])) b++;
    if (n === 0) b++;
  }
  const out = text.slice(a, Math.min(text.length, b + 1)).trim();
  return out.length > maxChars ? text.slice(start, end) : out;
}

export async function verifyAbox(
  abox: ABoxResult,
  tbox: TBoxModel,
  scorer: NliScorer,
  opts: { max?: number; threshold?: number; context?: (ref: EvidenceRef) => string | null } = {},
): Promise<VerifyResult> {
  const threshold = opts.threshold ?? NLI_REVIEW_THRESHOLD;
  const max = opts.max ?? 4000;
  const byId = new Map(abox.individuals.map((i) => [i.id, i]));
  const out: ABoxIndividual[] = abox.individuals.map((i) => structuredClone(i));
  const jobs: Job[] = [];

  const queue = (list: EvidenceRef[] | undefined, claim: string, write: (next: EvidenceRef[]) => void) => {
    if (!list?.length) return;
    // Several claims may share one list: each write builds on the previous one.
    let current: EvidenceRef[] = list;
    current.forEach((ref, k) => {
      if (ref.confidence !== undefined || !ref.quote?.trim() || ref.status === "legacy") return;
      jobs.push({
        ref,
        claim,
        set: (ev) => {
          current = current.map((x, i) => (i === k ? ev : x));
          write(current);
        },
      });
    });
  };

  for (const ind of out) {
    queue(ind.evidence, verbaliseType(ind, tbox), (next) => (ind.evidence = next));
    ind.dataProperties?.forEach((d, k) =>
      queue(d.evidence, verbaliseData(ind, d, tbox), (next) => (ind.dataProperties![k] = { ...ind.dataProperties![k], evidence: next })),
    );
    ind.objectProperties?.forEach((o, k) =>
      queue(
        o.evidence,
        verbaliseLink(ind, o, byId.get(o.targetId), tbox),
        (next) => (ind.objectProperties![k] = { ...ind.objectProperties![k], evidence: next }),
      ),
    );
  }

  const todo = jobs.slice(0, max);
  const premise = (ref: EvidenceRef) => (ref.status === "verified" && opts.context?.(ref)) || ref.quote;
  const scores = todo.length ? await scorer.score(todo.map((j) => ({ premise: premise(j.ref), hypothesis: j.claim }))) : [];
  let flagged = 0;
  todo.forEach((j, i) => {
    const confidence = Math.round((scores[i] ?? 0) * 1000) / 1000;
    const review = confidence < threshold || j.ref.status === "unverified";
    if (review) flagged++;
    j.set({
      ...j.ref,
      confidence,
      claim: j.claim,
      check: { premise: premise(j.ref), hypothesis: j.claim, backend: scorer.id, threshold },
      ...(review ? { review: true } : {}),
    });
  });
  return { abox: { ...abox, individuals: out }, scored: todo.length, flagged };
}
