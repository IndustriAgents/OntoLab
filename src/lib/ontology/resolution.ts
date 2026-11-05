// Entity-resolution primitives shared by the server (candidate generation,
// harness metrics) and the browser (the merge-review UI): name normalisation,
// lexical similarity, class compatibility and applying a merge decision.
//
// Merges are never silent: candidates are listed with their explanation and a
// person applies them (or the recommended set) — a wrong merge is invisible
// once made, a duplicate is not.

import type { ABoxIndividual, ABoxResult } from "../../types/abox";
import type { MergeCandidate } from "../../types/project";
import type { TBoxModel } from "../../types/tbox";
import { mergeInto } from "./aboxMerge";

const LEGAL_SUFFIX =
  /\b(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|sa|sas|bv|nv|corp|corporation|co|company|kg|oy|ab|spa|srl|pty)\b\.?/g;

/** Comparable form of an entity name: case, accents, punctuation and legal suffixes removed. */
export function normalizeEntityName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => new Set(normalizeEntityName(s).split(" ").filter(Boolean));

/** Initials of a multi-word name ("Acme Robotics" → "ar"). */
const acronym = (s: string) =>
  normalizeEntityName(s)
    .split(" ")
    .filter((w) => w.length > 1)
    .map((w) => w[0])
    .join("");

/**
 * Lexical similarity of two names in [0, 1]: 1 for equal normal forms; high
 * when one name is the other plus qualifiers ("Acme Robotics" / "Acme Robotics
 * GmbH Munich"); token Jaccard otherwise; acronyms count.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeEntityName(a);
  const nb = normalizeEntityName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter);
  const containment = inter / Math.min(ta.size, tb.size);
  const compactA = na.replace(/ /g, "");
  const compactB = nb.replace(/ /g, "");
  const isAcronym = (short: string, long: string) => short.length >= 2 && !short.includes(" ") && acronym(long) === short;
  if (isAcronym(compactA, b) || isAcronym(compactB, a)) return 0.85;
  if (compactA === compactB) return 0.98;
  // "acme robotics" inside "acme robotics munich": strong, but not certain.
  return Math.max(jaccard, containment === 1 && Math.min(ta.size, tb.size) >= 2 ? 0.9 : containment * 0.8);
}

export const displayName = (i: ABoxIndividual) => i.label || i.id.replace(/[-_]+/g, " ");

function ancestors(tbox: Pick<TBoxModel, "subClassOf">, cls: string): Set<string> {
  const out = new Set<string>([cls]);
  const stack = [cls];
  while (stack.length) {
    for (const p of tbox.subClassOf[stack.pop()!] ?? []) {
      if (out.has(p)) continue;
      out.add(p);
      stack.push(p);
    }
  }
  return out;
}

/** Two individuals may be the same entity only if one's class subsumes the other's and they are not disjoint. */
export function classesCompatible(tbox: Pick<TBoxModel, "subClassOf" | "classes">, a: string, b: string): boolean {
  if (a === b) return true;
  const ua = ancestors(tbox, a);
  const ub = ancestors(tbox, b);
  if (!ua.has(b) && !ub.has(a)) return false;
  const disjoint = new Map(tbox.classes.map((c) => [c.uri, new Set(c.disjointWith ?? [])]));
  for (const x of ua) for (const y of ub) if (disjoint.get(x)?.has(y)) return false;
  return true;
}

/**
 * Merge candidate.ids[1..] into candidate.ids[0]: claims and evidence are
 * unioned, links that pointed at a merged id now point at the kept one, and the
 * kept individual records what it absorbed. Pure.
 */
export function applyMerge(abox: ABoxResult, ids: string[]): { abox: ABoxResult; notes: string[] } {
  const [keepId, ...rest] = ids;
  const byId = new Map(abox.individuals.map((i) => [i.id, i]));
  const keep = byId.get(keepId);
  const others = rest.map((id) => byId.get(id)).filter((x): x is ABoxIndividual => !!x);
  if (!keep || !others.length) return { abox, notes: [] };
  const notes: string[] = [];
  const merged: ABoxIndividual = structuredClone(keep);
  for (const o of others) mergeInto(merged, structuredClone(o), notes);
  merged.mergedFrom = [
    ...new Set([...(merged.mergedFrom ?? []), ...others.map((o) => o.id), ...others.flatMap((o) => o.mergedFrom ?? [])]),
  ];
  const gone = new Set(others.map((o) => o.id));
  const individuals = abox.individuals
    .filter((i) => !gone.has(i.id))
    .map((i) => (i.id === keepId ? merged : i))
    .map((i) => {
      if (!i.objectProperties?.some((op) => gone.has(op.targetId))) return i;
      const seen = new Set<string>();
      const ops = i.objectProperties
        .map((op) => (gone.has(op.targetId) ? { ...op, targetId: keepId } : op))
        .filter((op) => {
          const k = `${op.propUri}|${op.targetId}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      return { ...i, objectProperties: ops };
    });
  return {
    abox: {
      ...abox,
      individuals,
      unresolved: abox.unresolved?.map((o) => ({
        ...o,
        subjectId: gone.has(o.subjectId) ? keepId : o.subjectId,
        targetId: gone.has(o.targetId) ? keepId : o.targetId,
      })),
    },
    notes: [`merged ${others.map((o) => `"${o.id}"`).join(", ")} into "${keepId}"`, ...notes],
  };
}

/** Apply every candidate decided "merge", in order, skipping ids already absorbed. */
export function applyMergeDecisions(abox: ABoxResult, candidates: MergeCandidate[]): ABoxResult {
  let cur = abox;
  const absorbed = new Map<string, string>();
  const live = (id: string) => {
    let x = id;
    while (absorbed.has(x)) x = absorbed.get(x)!;
    return x;
  };
  for (const c of candidates) {
    if (c.decision !== "merge") continue;
    const ids = [...new Set(c.ids.map(live))];
    if (ids.length < 2) continue;
    cur = applyMerge(cur, ids).abox;
    for (const id of ids.slice(1)) absorbed.set(id, ids[0]);
  }
  return cur;
}
