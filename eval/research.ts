// Research-testbed metrics (beyond the phase-0 set in metrics.ts): what the
// 2024–26 ontology-engineering literature measures, computed on the product's
// own outputs so ablations compare like with like.
//
//   axioms       — precision/recall per axiom type, asserted and entailed (OWL 2 RL)
//   cq coverage  — share of gold competency questions whose terms the ontology has
//   llms4ol      — LLMs4OL tasks B (taxonomy: is-a pairs over the closure) and
//                  C (non-taxonomic relations: domain–property–range triples)
//   calibration  — expected calibration error, Brier score and selective
//                  accuracy of per-claim confidence; precision of auto-accepted facts
//   alignment    — precision/recall against a reference alignment (OAEI format)
//   extension    — recovery of held-out terms, duplicates, unintended entailments

import type { ABoxResult, FactReview } from "../src/types/abox.ts";
import type { TBoxModel } from "../src/types/tbox.ts";
import { localName } from "../src/lib/ontology/iri.ts";
import { reasonModules } from "../src/lib/ontology/reasoner/index.ts";
import { addTBoxAxioms, AxiomSet } from "../src/lib/ontology/reasoner/axioms.ts";
import { runRL } from "../src/lib/ontology/reasoner/rl.ts";
import { statusOf } from "../src/lib/ontology/factReview.ts";
import { sparqlIris } from "../server/services/answerability.ts";
import { alignIndividuals, FUZZY, matchNames, normValue, prf, termName, termSimilarity, type GoldAbox, type Prf } from "./metrics.ts";

/* ───────────────────────── name mapping ───────────────────────── */

/** Map predicted term URIs to gold term URIs by fuzzy name (one-to-one). */
export function termMap(pred: TBoxModel, gold: TBoxModel, sim = termSimilarity, threshold = FUZZY): Map<string, string> {
  const out = new Map<string, string>();
  const groups: [{ uri: string; label?: string }[], { uri: string; label?: string }[]][] = [
    [pred.classes, gold.classes],
    [[...pred.objectProps, ...pred.dataProps], [...gold.objectProps, ...gold.dataProps]],
  ];
  for (const [p, g] of groups) {
    const m = matchNames(
      p.map((t) => termName(t.uri, t.label)),
      g.map((t) => termName(t.uri, t.label)),
      sim,
      threshold,
    );
    for (const [i, j] of m.pairs) out.set(p[i].uri, g[j].uri);
  }
  return out;
}

/* ───────────────────────── axioms ───────────────────────── */

const AXIOM_KINDS = ["subClassOf", "disjointWith", "domain", "range", "functional", "inverseOf", "characteristic", "restriction"] as const;

/** Axioms of a model as comparable keys in gold-name space (unmapped terms keep a marker, so they count as wrong). */
function axiomKeys(model: TBoxModel, map: (uri: string) => string): Map<string, Set<string>> {
  const set = new AxiomSet();
  addTBoxAxioms(set, model);
  const out = new Map<string, Set<string>>(AXIOM_KINDS.map((k) => [k, new Set<string>()]));
  const symmetric = new Set(["disjointWith", "equivalentClass", "inverseOf"]);
  for (const a of set.list) {
    if (!out.has(a.kind)) continue;
    const args = a.args.map((x, i) => (a.kind === "restriction" && i === 2 ? x : a.kind === "characteristic" && i === 1 ? x : x ? map(x) : x));
    const key = symmetric.has(a.kind) ? [...args].sort().join("|") : args.join("|");
    out.get(a.kind)!.add(key);
  }
  return out;
}

export interface AxiomMetrics {
  asserted: Record<string, Prf>;
  /** subsumptions entailed by the RL reasoner, gold vs predicted */
  entailedSubsumption: Prf;
}

/** Precision/recall per axiom type, after mapping predicted terms onto gold terms by name. */
export function axiomMetrics(pred: TBoxModel, gold: TBoxModel): AxiomMetrics {
  const m = termMap(pred, gold);
  const toGold = (u: string) => m.get(u) ?? `?${localName(u)}`;
  const p = axiomKeys(pred, toGold);
  const g = axiomKeys(gold, (u) => u);
  const asserted: Record<string, Prf> = {};
  for (const k of AXIOM_KINDS) {
    const ps = p.get(k)!;
    const gs = g.get(k)!;
    if (!ps.size && !gs.size) continue;
    asserted[k] = prf([...ps].filter((x) => gs.has(x)).length, ps.size, gs.size);
  }
  const entailed = (model: TBoxModel, map: (u: string) => string) => {
    const set = new AxiomSet();
    addTBoxAxioms(set, model);
    return new Set(runRL({ axioms: set.list }).report.subsumptions.map((e) => `${map(e.args[0])}|${map(e.args[1])}`));
  };
  const pe = entailed(pred, toGold);
  const ge = entailed(gold, (u) => u);
  return { asserted, entailedSubsumption: prf([...pe].filter((x) => ge.has(x)).length, pe.size, ge.size) };
}

/* ───────────────────────── competency-question coverage ───────────────────────── */

/**
 * Schema-level coverage: a gold competency question is covered when every
 * ontology term its gold SPARQL uses has a counterpart (by name) in the
 * predicted ontology. Deterministic — no model, no data.
 */
export function cqTermCoverage(goldCqs: { sparql: string }[], pred: TBoxModel, gold: TBoxModel): { covered: number; total: number; share: number } {
  const goldTerms = new Set([...gold.classes, ...gold.objectProps, ...gold.dataProps].map((t) => t.uri));
  const mapped = new Set(termMap(pred, gold).values());
  let covered = 0;
  let total = 0;
  for (const q of goldCqs) {
    const needed = sparqlIris(q.sparql).filter((iri) => goldTerms.has(iri));
    if (!needed.length) continue;
    total++;
    if (needed.every((iri) => mapped.has(iri))) covered++;
  }
  return { covered, total, share: total ? covered / total : 0 };
}

/* ───────────────────────── LLMs4OL tasks B and C ───────────────────────── */

export interface Llms4olMetrics {
  /** task B, taxonomy discovery: is-a pairs over the transitive closure */
  taxonomy: Prf;
  /** task C, non-taxonomic relation extraction: (domain, property, range) triples */
  relations: Prf;
}

export function llms4olMetrics(pred: TBoxModel, gold: TBoxModel): Llms4olMetrics {
  const m = termMap(pred, gold);
  const toGold = (u: string) => m.get(u) ?? `?${localName(u)}`;
  const closure = (model: TBoxModel, map: (u: string) => string) => {
    const set = new AxiomSet();
    addTBoxAxioms(set, model);
    return new Set(runRL({ axioms: set.list }).report.subsumptions.map((e) => `${map(e.args[0])}<${map(e.args[1])}`));
  };
  const triples = (model: TBoxModel, map: (u: string) => string) => {
    const out = new Set<string>();
    for (const p of model.objectProps) for (const d of p.domain) for (const r of p.range) out.add(`${map(d)}|${map(p.uri)}|${map(r)}`);
    return out;
  };
  const score = (a: Set<string>, b: Set<string>) => prf([...a].filter((x) => b.has(x)).length, a.size, b.size);
  return { taxonomy: score(closure(pred, toGold), closure(gold, (u) => u)), relations: score(triples(pred, toGold), triples(gold, (u) => u)) };
}

/* ───────────────────────── calibration ───────────────────────── */

export interface ClaimScore {
  confidence: number;
  correct: boolean;
  status: "candidate" | "accepted" | "rejected";
  auto: boolean;
}

/**
 * Per-claim correctness against the gold graph, with the confidence the
 * evidence gate gave it. A type claim is correct when the individual matches
 * a gold one of the same class; a value or link when the same triple is gold.
 */
export function claimScores(pred: ABoxResult, gold: GoldAbox): ClaimScore[] {
  const al = alignIndividuals(pred, gold);
  const goldByKey = new Map(gold.individuals.map((g) => [g.key, g]));
  const out: ClaimScore[] = [];
  const conf = (ev: { confidence?: number; status: string }[] | undefined) => Math.max(-1, ...(ev ?? []).filter((e) => e.status === "verified" && e.confidence != null).map((e) => e.confidence!));
  for (const p of pred.individuals) {
    const g = goldByKey.get(al.oneToOne.get(p.id) ?? "");
    const push = (confidence: number, correct: boolean, review: FactReview | undefined) => {
      if (confidence < 0) return;
      out.push({ confidence, correct, status: statusOf(review), auto: review?.by !== "user" });
    };
    push(conf(p.evidence), !!g && localName(p.classUri) === g.class, p.review);
    for (const d of p.dataProperties ?? []) push(conf(d.evidence), !!g && (g.data ?? []).some((x) => x.prop === localName(d.propUri) && normValue(x.value) === normValue(d.value)), d.review);
    for (const o of p.objectProperties ?? []) {
      const target = al.oneToOne.get(o.targetId);
      push(conf(o.evidence), !!g && !!target && (g.links ?? []).some((x) => x.prop === localName(o.propUri) && x.target === target), o.review);
    }
  }
  return out;
}

export interface CalibrationMetrics {
  n: number;
  /** expected calibration error over equal-width bins */
  ece: number;
  brier: number;
  /** accuracy of the claims above each confidence threshold, and how many that keeps */
  selective: { threshold: number; coverage: number; accuracy: number }[];
  /** precision of the facts the gate accepted automatically */
  autoAcceptedPrecision: number | null;
  autoAccepted: number;
}

export function calibration(scores: ClaimScore[], bins = 10): CalibrationMetrics {
  const n = scores.length;
  if (!n) return { n: 0, ece: 0, brier: 0, selective: [], autoAcceptedPrecision: null, autoAccepted: 0 };
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = scores.filter((s) => s.confidence >= lo && (b === bins - 1 ? s.confidence <= hi : s.confidence < hi));
    if (!inBin.length) continue;
    const acc = inBin.filter((s) => s.correct).length / inBin.length;
    const avg = inBin.reduce((a, s) => a + s.confidence, 0) / inBin.length;
    ece += (inBin.length / n) * Math.abs(acc - avg);
  }
  const brier = scores.reduce((a, s) => a + (s.confidence - (s.correct ? 1 : 0)) ** 2, 0) / n;
  const selective = [0.5, 0.7, 0.8, 0.9].map((t) => {
    const kept = scores.filter((s) => s.confidence >= t);
    return { threshold: t, coverage: kept.length / n, accuracy: kept.length ? kept.filter((s) => s.correct).length / kept.length : 0 };
  });
  const auto = scores.filter((s) => s.status === "accepted" && s.auto);
  return { n, ece, brier, selective, autoAcceptedPrecision: auto.length ? auto.filter((s) => s.correct).length / auto.length : null, autoAccepted: auto.length };
}

/* ───────────────────────── alignment ───────────────────────── */

export interface ReferenceCell {
  e1: string;
  e2: string;
  /** "=" equivalence, "<" e1 narrower than e2, ">" broader */
  relation: string;
  measure?: number;
}

/** Precision/recall of predicted correspondences against a reference alignment (equivalences; subsumptions count when the direction agrees). */
export function alignmentMetrics(pred: { source: string; target: string; relation: string }[], reference: ReferenceCell[]): Prf & { equivalenceOnly: Prf } {
  const key = (a: string, b: string, r: string) => `${a}|${b}|${r}`;
  const rel = (r: string) => (r === "equivalent" || r === "=" ? "=" : r === "broader" || r === "<" ? "<" : r === "narrower" || r === ">" ? ">" : "~");
  const ref = new Set(reference.map((c) => key(c.e1, c.e2, rel(c.relation))));
  const logical = pred.filter((p) => ["equivalent", "broader", "narrower"].includes(p.relation));
  const hits = logical.filter((p) => ref.has(key(p.source, p.target, rel(p.relation)))).length;
  const refEq = reference.filter((c) => rel(c.relation) === "=");
  const predEq = logical.filter((p) => p.relation === "equivalent");
  const eqRef = new Set(refEq.map((c) => `${c.e1}|${c.e2}`));
  const eqHits = predEq.filter((p) => eqRef.has(`${p.source}|${p.target}`)).length;
  return { ...prf(hits, logical.length, reference.length), equivalenceOnly: prf(eqHits, predEq.length, refEq.length) };
}

/** Incoherence a mapping set causes: classes satisfiable in each ontology alone that are not with the mappings. */
export function coherence(modules: { name: string; turtle: string }[], mappingTurtle: string): { unsatisfiable: number } {
  const before = new Set(reasonModules(modules).report.unsatisfiable.map((u) => u.cls));
  const after = reasonModules([...modules, { name: "alignment.ttl", turtle: mappingTurtle }]).report.unsatisfiable.filter((u) => !before.has(u.cls));
  return { unsatisfiable: after.length };
}

/* ───────────────────────── extension ───────────────────────── */

/** Pick gold leaf classes to hold out (deterministic: every k-th leaf by name), returning the rest of the T-Box as Turtle-free names. */
export function leafClasses(gold: TBoxModel): string[] {
  const parents = new Set(Object.values(gold.subClassOf).flat());
  return gold.classes
    .map((c) => c.uri)
    .filter((u) => !parents.has(u) && (gold.subClassOf[u] ?? []).length > 0)
    .sort();
}

/** How many held-out terms the accepted proposals recovered (by name), and how many accepted proposals duplicate a kept term. */
export function extensionRecovery(accepted: string[], heldOut: string[], kept: string[]): { recovery: Prf; duplicateRate: number } {
  const m = matchNames(accepted, heldOut, termSimilarity, FUZZY);
  const dupes = matchNames(accepted, kept, termSimilarity, FUZZY).pairs.size;
  return { recovery: prf(m.pairs.size, accepted.length, heldOut.length), duplicateRate: accepted.length ? dupes / accepted.length : 0 };
}
