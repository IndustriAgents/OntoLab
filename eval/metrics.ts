// Evaluation metrics (phase 0). Pure functions over a predicted graph or
// ontology and a hand-labelled gold set, so every later change is judged by a
// number rather than by eye. Shapes follow the plan's measurement table:
//
//   extraction  — precision/recall of individuals and assertions, typing
//                 accuracy, and Text2KGBench's hallucination rates (subject,
//                 relation, object not supported by the source / ontology)
//   resolution  — duplicate rate and wrong-merge rate against gold clusters
//   evidence    — share of claims with a verified quote; agreement of the
//                 entailment gate with human labels (accuracy, Cohen's kappa)
//   induction   — OLLM-style literal, fuzzy and continuous F1 on class names
//                 and graph F1 on subclass edges, against a gold T-Box
//   requirements — similarity of generated to approved competency questions
//   assistant   — answer accuracy by question type

import type { ABoxIndividual, ABoxResult } from "../src/types/abox.ts";
import type { TBoxModel } from "../src/types/tbox.ts";
import { localName } from "../src/lib/ontology/iri.ts";
import { nameSimilarity, normalizeEntityName } from "../src/lib/ontology/resolution.ts";

/* ───────────────────────── gold shapes ───────────────────────── */

export interface GoldIndividual {
  key: string;
  class: string;
  label: string;
  aliases?: string[];
  docs?: string[];
  data?: { prop: string; value: string | number | boolean }[];
  links?: { prop: string; target: string }[];
}

export interface GoldAbox {
  individuals: GoldIndividual[];
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  predicted: number;
  gold: number;
}

export function prf(tp: number, predicted: number, gold: number): Prf {
  const precision = predicted ? tp / predicted : 0;
  const recall = gold ? tp / gold : 0;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, tp, predicted, gold };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const round = <T>(o: T): T => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "number" ? r3(v) : v))) as T;

/* ───────────────────────── matching predicted to gold individuals ───────────────────────── */

const MATCH = 0.85;

function nameScore(pred: ABoxIndividual, gold: GoldIndividual): number {
  const names = [gold.label, ...(gold.aliases ?? [])];
  const p = [pred.label ?? "", pred.id.replace(/[-_]+/g, " ")];
  let best = 0;
  for (const a of p) for (const b of names) if (a && b) best = Math.max(best, nameSimilarity(a, b));
  return best;
}

export interface Alignment {
  /** predicted id → gold key (one-to-one, greedy by score) */
  oneToOne: Map<string, string>;
  /** every gold key a predicted individual matches above the threshold (many-to-many, for ER metrics) */
  predToGolds: Map<string, string[]>;
  goldToPreds: Map<string, string[]>;
}

export function alignIndividuals(pred: ABoxResult, gold: GoldAbox, threshold = MATCH): Alignment {
  const scored: { p: string; g: string; s: number }[] = [];
  const predToGolds = new Map<string, string[]>();
  const goldToPreds = new Map<string, string[]>();
  for (const p of pred.individuals) {
    for (const g of gold.individuals) {
      const s = nameScore(p, g);
      if (s < threshold) continue;
      scored.push({ p: p.id, g: g.key, s });
      predToGolds.set(p.id, [...(predToGolds.get(p.id) ?? []), g.key]);
      goldToPreds.set(g.key, [...(goldToPreds.get(g.key) ?? []), p.id]);
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const oneToOne = new Map<string, string>();
  const usedGold = new Set<string>();
  for (const x of scored) {
    if (oneToOne.has(x.p) || usedGold.has(x.g)) continue;
    oneToOne.set(x.p, x.g);
    usedGold.add(x.g);
  }
  // An individual merged from several predictions also stands for them.
  for (const p of pred.individuals) {
    for (const m of p.mergedFrom ?? []) {
      const extra = gold.individuals.filter((g) => nameScore({ id: m, classUri: p.classUri }, g) >= threshold).map((g) => g.key);
      if (extra.length) predToGolds.set(p.id, [...new Set([...(predToGolds.get(p.id) ?? []), ...extra])]);
    }
  }
  return { oneToOne, predToGolds, goldToPreds };
}

/* ───────────────────────── extraction ───────────────────────── */

/** Normal form of a literal value for comparison: case, spacing, thousands separators, trailing units dropped from numbers. */
export function normValue(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  const num = /^[-+]?[\d.,\s]*\d(?:\.\d+)?/.exec(s.replace(/(\d),(\d{3})\b/g, "$1$2"));
  if (num && /^\s*[-+]?\d/.test(s)) {
    const n = Number(num[0].replace(/[\s,]/g, ""));
    if (Number.isFinite(n)) return String(n);
  }
  if (s === "yes") return "true";
  if (s === "no") return "false";
  return normalizeEntityName(s) || s;
}

export interface ExtractionMetrics {
  individuals: Prf;
  /** of the matched individuals, the share typed with the gold class */
  typingAccuracy: number;
  assertions: Prf;
  /** share of predicted assertions using a term the ontology has */
  ontologyConformance: number;
  hallucination: { subject: number; relation: number; object: number };
}

/** A token of the name appears in the source text (Text2KGBench's lexical support test, stemmed). */
function supported(text: string, name: string): boolean {
  const toks = normalizeEntityName(name)
    .split(" ")
    .filter((t) => t.length > 2);
  if (!toks.length) return true;
  return toks.some((t) => text.includes(t.length > 5 ? t.slice(0, t.length - 2) : t));
}

export function extractionMetrics(pred: ABoxResult, gold: GoldAbox, tbox: TBoxModel, sourceText: string): ExtractionMetrics {
  const al = alignIndividuals(pred, gold);
  const goldByKey = new Map(gold.individuals.map((g) => [g.key, g]));
  const predById = new Map(pred.individuals.map((p) => [p.id, p]));
  const matched = [...al.oneToOne.entries()];
  const typed = matched.filter(([p, g]) => localName(predById.get(p)!.classUri) === goldByKey.get(g)!.class).length;

  // assertions as comparable triples
  const goldTriples = new Set<string>();
  for (const g of gold.individuals) {
    for (const d of g.data ?? []) goldTriples.add(`${g.key}|${d.prop}|v:${normValue(d.value)}`);
    for (const l of g.links ?? []) goldTriples.add(`${g.key}|${l.prop}|i:${l.target}`);
  }
  const predTriples = new Set<string>();
  const termUris = new Set([...tbox.objectProps, ...tbox.dataProps].map((p) => p.uri));
  let total = 0;
  let conform = 0;
  let subjH = 0;
  let relH = 0;
  let objH = 0;
  const text = normalizeEntityName(sourceText);
  for (const p of pred.individuals) {
    const subject = al.oneToOne.get(p.id) ?? `?${p.id}`;
    const subjOk = supported(text, p.label ?? p.id.replace(/[-_]+/g, " "));
    for (const d of p.dataProperties ?? []) {
      total++;
      if (termUris.has(d.propUri)) conform++;
      else relH++;
      if (!subjOk) subjH++;
      if (!supported(text, d.value)) objH++;
      predTriples.add(`${subject}|${localName(d.propUri)}|v:${normValue(d.value)}`);
    }
    for (const o of p.objectProperties ?? []) {
      total++;
      if (termUris.has(o.propUri)) conform++;
      else relH++;
      if (!subjOk) subjH++;
      const target = predById.get(o.targetId);
      if (target && !supported(text, target.label ?? target.id.replace(/[-_]+/g, " "))) objH++;
      predTriples.add(`${subject}|${localName(o.propUri)}|i:${al.oneToOne.get(o.targetId) ?? `?${o.targetId}`}`);
    }
  }
  const tp = [...predTriples].filter((t) => goldTriples.has(t)).length;
  return {
    individuals: prf(al.oneToOne.size, pred.individuals.length, gold.individuals.length),
    typingAccuracy: matched.length ? typed / matched.length : 0,
    assertions: prf(tp, predTriples.size, goldTriples.size),
    ontologyConformance: total ? conform / total : 1,
    hallucination: { subject: total ? subjH / total : 0, relation: total ? relH / total : 0, object: total ? objH / total : 0 },
  };
}

/* ───────────────────────── entity resolution ───────────────────────── */

export interface ResolutionMetrics {
  /** gold entities represented by more than one individual, over gold entities found */
  duplicateRate: number;
  /** merges that joined individuals of different gold entities, over merges made */
  wrongMergeRate: number;
  merges: number;
  goldFound: number;
}

/**
 * `before` is the graph before entity resolution: the merged individuals'
 * constituents are aligned there, where each still has its own name, and a
 * merge is wrong when its constituents belong to different gold entities.
 */
export function resolutionMetrics(pred: ABoxResult, gold: GoldAbox, before?: ABoxResult): ResolutionMetrics {
  const al = alignIndividuals(pred, gold);
  // A gold entity is "found" when some prediction matches it; duplicated when several
  // predictions match it and nothing else (aliases may overlap across entities).
  const found = [...al.goldToPreds.entries()];
  const dup = found.filter(([, preds]) => preds.filter((p) => (al.predToGolds.get(p) ?? []).length === 1).length > 1).length;
  const pre = before ? alignIndividuals(before, gold) : null;
  const merged = pred.individuals.filter((i) => i.mergedFrom?.length);
  const wrong = pre
    ? merged.filter((i) => {
        const keys = new Set([i.id, ...(i.mergedFrom ?? [])].map((id) => pre.oneToOne.get(id)).filter(Boolean));
        return keys.size > 1;
      }).length
    : 0;
  return { duplicateRate: found.length ? dup / found.length : 0, wrongMergeRate: merged.length ? wrong / merged.length : 0, merges: merged.length, goldFound: found.length };
}

/* ───────────────────────── evidence ───────────────────────── */

export function verifiedShare(abox: ABoxResult): { claims: number; verified: number; share: number; reviewFlagged: number } {
  let claims = 0;
  let verified = 0;
  let review = 0;
  const count = (ev: ABoxIndividual["evidence"]) => {
    claims++;
    if (ev?.some((e) => e.status === "verified")) verified++;
    if (ev?.some((e) => e.review)) review++;
  };
  for (const i of abox.individuals) {
    count(i.evidence);
    for (const d of i.dataProperties ?? []) count(d.evidence);
    for (const o of i.objectProperties ?? []) count(o.evidence);
  }
  return { claims, verified, share: claims ? verified / claims : 0, reviewFlagged: review };
}

/** Agreement of binary judgements with human labels: accuracy and Cohen's kappa. */
export function agreement(predicted: boolean[], human: boolean[]): { accuracy: number; kappa: number; n: number } {
  const n = Math.min(predicted.length, human.length);
  if (!n) return { accuracy: 0, kappa: 0, n: 0 };
  let agree = 0;
  let pYes = 0;
  let hYes = 0;
  for (let i = 0; i < n; i++) {
    if (predicted[i] === human[i]) agree++;
    if (predicted[i]) pYes++;
    if (human[i]) hYes++;
  }
  const po = agree / n;
  const pe = (pYes / n) * (hYes / n) + (1 - pYes / n) * (1 - hYes / n);
  return { accuracy: po, kappa: pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe), n };
}

/* ───────────────────────── ontology induction (OLLM-style) ───────────────────────── */

export interface InductionMetrics {
  classes: { literal: Prf; fuzzy: Prf; continuous: number };
  properties: { literal: Prf; fuzzy: Prf };
  /** subclass edges whose both ends match and that exist in the gold */
  graph: Prf;
}

export const termName = (uri: string, label?: string) => label || localName(uri).replace(/([a-z0-9])([A-Z])/g, "$1 $2");

/** Best one-to-one matching between two name lists by a similarity function. */
export function matchNames(pred: string[], gold: string[], sim: (a: string, b: string) => number, threshold: number): { pairs: Map<number, number>; best: number[] } {
  const all: { i: number; j: number; s: number }[] = [];
  pred.forEach((a, i) => gold.forEach((b, j) => all.push({ i, j, s: sim(a, b) })));
  all.sort((x, y) => y.s - x.s);
  const pairs = new Map<number, number>();
  const usedJ = new Set<number>();
  for (const x of all) {
    if (x.s < threshold) break;
    if (pairs.has(x.i) || usedJ.has(x.j)) continue;
    pairs.set(x.i, x.j);
    usedJ.add(x.j);
  }
  const best = gold.map((_, j) => Math.max(0, ...pred.map((_, i) => sim(pred[i], gold[j]))));
  return { pairs, best };
}

/** Dice coefficient of character trigrams: catches spelling variants ("Organization"/"Organisation") that token matching misses. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = `#${normalizeEntityName(s).replace(/ /g, "#")}#`;
    const out = new Map<string, number>();
    for (let i = 0; i + 3 <= t.length; i++) out.set(t.slice(i, i + 3), (out.get(t.slice(i, i + 3)) ?? 0) + 1);
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

/** Fuzzy-match threshold for term names (one spelling variant, e.g. -ise/-ize, scores 0.75). */
export const FUZZY = 0.75;

/** The default fuzzy similarity for term names: the better of token and character similarity. */
export const termSimilarity = (a: string, b: string) => Math.max(nameSimilarity(a, b), trigramSimilarity(a, b));

export function inductionMetrics(pred: TBoxModel, gold: TBoxModel, sim: (a: string, b: string) => number = termSimilarity): InductionMetrics {
  const pc = pred.classes.map((c) => termName(c.uri, c.label));
  const gc = gold.classes.map((c) => termName(c.uri, c.label));
  const exact = matchNames(pc, gc, (a, b) => (normalizeEntityName(a) === normalizeEntityName(b) ? 1 : 0), 1);
  const fuzzy = matchNames(pc, gc, sim, FUZZY);
  const pp = [...pred.objectProps, ...pred.dataProps].map((p) => termName(p.uri, p.label));
  const gp = [...gold.objectProps, ...gold.dataProps].map((p) => termName(p.uri, p.label));
  const pExact = matchNames(pp, gp, (a, b) => (normalizeEntityName(a) === normalizeEntityName(b) ? 1 : 0), 1);
  const pFuzzy = matchNames(pp, gp, sim, FUZZY);

  // graph F1 on subclass edges, via the fuzzy class matching
  const toGold = new Map([...fuzzy.pairs.entries()].map(([i, j]) => [pred.classes[i].uri, gold.classes[j].uri]));
  const goldEdges = new Set(Object.entries(gold.subClassOf).flatMap(([c, ps]) => ps.map((p) => `${c}|${p}`)));
  const predEdges = Object.entries(pred.subClassOf).flatMap(([c, ps]) => ps.map((p) => [c, p] as const));
  const hit = predEdges.filter(([c, p]) => toGold.has(c) && toGold.has(p) && goldEdges.has(`${toGold.get(c)}|${toGold.get(p)}`)).length;

  return {
    classes: {
      literal: prf(exact.pairs.size, pc.length, gc.length),
      fuzzy: prf(fuzzy.pairs.size, pc.length, gc.length),
      continuous: fuzzy.best.length ? fuzzy.best.reduce((a, b) => a + b, 0) / fuzzy.best.length : 0,
    },
    properties: { literal: prf(pExact.pairs.size, pp.length, gp.length), fuzzy: prf(pFuzzy.pairs.size, pp.length, gp.length) },
    graph: prf(hit, predEdges.length, goldEdges.size),
  };
}

/* ───────────────────────── requirements ───────────────────────── */

/** Mean best-match similarity of approved CQs to generated ones, and the share of generated CQs that match an approved one. */
export function cqSimilarity(generated: string[], approved: string[], sim: (a: string, b: string) => number, keep = 0.6): { meanBest: number; keptShare: number } {
  if (!generated.length || !approved.length) return { meanBest: 0, keptShare: 0 };
  const best = approved.map((a) => Math.max(...generated.map((g) => sim(a, g))));
  const kept = generated.filter((g) => approved.some((a) => sim(a, g) >= keep)).length;
  return { meanBest: best.reduce((x, y) => x + y, 0) / best.length, keptShare: kept / generated.length };
}

/** Token Jaccard on content words — the lexical CQ similarity when no embedder is configured. */
export function tokenJaccard(a: string, b: string): number {
  const t = (s: string) => new Set(normalizeEntityName(s).split(" ").filter((w) => w.length > 2));
  const A = t(a);
  const B = t(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return A.size + B.size - inter ? inter / (A.size + B.size - inter) : 0;
}

/* ───────────────────────── assistant ───────────────────────── */

export function answerCorrect(answer: string, expected: string[]): boolean {
  const a = answer.toLowerCase();
  return expected.some((e) => a.includes(String(e).toLowerCase()));
}
