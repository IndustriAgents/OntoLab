// Merging, duplicate detection and diffing of A-Boxes. Shared by the server
// (run finalisation, assistant proposals) and the client (draft comparison).
//
// Identity is the individual id, never the label: two individuals called
// "Sensor B1" with different ids stay two individuals and are only *reported*
// as possible duplicates for a human to decide.

import type {
  ABoxDataProp,
  ABoxIndividual,
  ABoxObjectProp,
  ABoxResult,
  EvidenceRef,
  FactOrigin,
  UnresolvedRelationship,
} from "../../types/abox";
import type { RevisionDiff, RevisionContent } from "../../types/project";
import { mergeReview } from "./factReview";

const evKey = (e: EvidenceRef) =>
  `${e.documentId ?? ""}|${e.chunkId ?? ""}|${e.start ?? ""}|${e.end ?? ""}|${e.start != null && e.end != null ? "" : e.quote.replace(/\s+/g, " ").trim()}`;

export function mergeEvidence(a: EvidenceRef[] | undefined, b: EvidenceRef[] | undefined): EvidenceRef[] | undefined {
  const byKey = new Map<string, EvidenceRef>();
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const key = evKey(e),
      old = byKey.get(key);
    if (!old || (old.status !== "verified" && e.status === "verified")) byKey.set(key, e);
  }
  return byKey.size ? [...byKey.values()] : undefined;
}
export function mergeOrigins(a: FactOrigin[] | undefined, b: FactOrigin[] | undefined): FactOrigin[] | undefined {
  const byKey = new Map<string, FactOrigin>();
  for (const o of [...(a ?? []), ...(b ?? [])])
    byKey.set(JSON.stringify([o.kind, o.documentId, o.chunkId, [...(o.types ?? [])].sort()]), o);
  return byKey.size ? [...byKey.values()] : undefined;
}

const dpKey = (d: ABoxDataProp) => `${d.propUri}|${d.value}|${d.datatype ?? ""}|${d.lang ?? ""}`;
const opKey = (o: ABoxObjectProp) => `${o.propUri}|${o.targetId}`;

/** Fold `src`'s claims and evidence into `target` (mutates target). */
export function mergeInto(target: ABoxIndividual, src: ABoxIndividual, notes: string[]): void {
  if (src.classUri !== target.classUri && !(target.additionalTypes ?? []).includes(src.classUri)) {
    // A conflicting claim is preserved (as an extra type) rather than discarded;
    // validation then flags it if the classes are disjoint.
    target.additionalTypes = [...(target.additionalTypes ?? []), src.classUri];
    notes.push(`"${target.id}" was typed differently in another part of the documents; both types kept for review`);
  }
  target.additionalTypes = [...new Set([...(target.additionalTypes ?? []), ...(src.additionalTypes ?? [])])].filter(
    (t) => t !== target.classUri,
  );
  if (!target.additionalTypes.length) delete target.additionalTypes;
  // a person's decision survives every merge; otherwise trust beats doubt
  const review = mergeReview(target.review, src.review);
  if (review) target.review = review;
  target.label ??= src.label;
  target.sourceEvidence ??= src.sourceEvidence;
  target.evidence = mergeEvidence(target.evidence, src.evidence);
  target.origins = mergeOrigins(target.origins, src.origins);
  if (src.sameAs?.length) target.sameAs = [...new Set([...(target.sameAs ?? []), ...src.sameAs])];

  if (src.dataProperties?.length) {
    const list = [...(target.dataProperties ?? [])];
    const index = new Map(list.map((d, i) => [dpKey(d), i]));
    for (const d of src.dataProperties) {
      const at = index.get(dpKey(d));
      if (at === undefined) {
        index.set(dpKey(d), list.length);
        list.push({ ...d });
      } else {
        const review = mergeReview(list[at].review, d.review);
        list[at] = {
          ...list[at],
          evidence: mergeEvidence(list[at].evidence, d.evidence),
          origins: mergeOrigins(list[at].origins, d.origins),
          ...(review ? { review } : {}),
        };
      }
    }
    target.dataProperties = list;
  }
  if (src.objectProperties?.length) {
    const list = [...(target.objectProperties ?? [])];
    const index = new Map(list.map((o, i) => [opKey(o), i]));
    for (const o of src.objectProperties) {
      const at = index.get(opKey(o));
      if (at === undefined) {
        index.set(opKey(o), list.length);
        list.push({ ...o });
      } else {
        const review = mergeReview(list[at].review, o.review);
        list[at] = {
          ...list[at],
          evidence: mergeEvidence(list[at].evidence, o.evidence),
          origins: mergeOrigins(list[at].origins, o.origins),
          ...(review ? { review } : {}),
        };
      }
    }
    target.objectProperties = list;
  }
}

/** Union several partial A-Boxes by id, keeping every distinct claim and its evidence. */
export function mergeAboxes(parts: ABoxResult[]): { abox: ABoxResult; notes: string[] } {
  const notes: string[] = [];
  const byId = new Map<string, ABoxIndividual>();
  const order: string[] = [];
  for (const part of parts) {
    for (const ind of part.individuals) {
      const existing = byId.get(ind.id);
      if (existing) mergeInto(existing, ind, notes);
      else {
        const copy = { ...structuredClone(ind), dataProperties: undefined, objectProperties: undefined };
        mergeInto(copy, ind, notes);
        byId.set(ind.id, copy);
        order.push(ind.id);
      }
    }
  }
  // Keep missing targets as reviewable proposals; later parts can resolve them.
  const unresolved = new Map<string, UnresolvedRelationship>();
  for (const part of parts)
    for (const link of part.unresolved ?? []) {
      const old = unresolved.get(link.id);
      unresolved.set(link.id, {
        ...structuredClone(link),
        ...(old?.status === "dismissed" ? { status: "dismissed" } : {}),
        evidence: mergeEvidence(old?.evidence, link.evidence),
        origins: mergeOrigins(old?.origins, link.origins),
      });
    }
  for (const id of order) {
    const ind = byId.get(id)!;
    ind.objectProperties = (ind.objectProperties ?? []).filter((o) => {
      if (byId.has(o.targetId)) return true;
      const key = JSON.stringify([id, o.propUri, o.targetId]),
        old = unresolved.get(key);
      unresolved.set(key, {
        ...o,
        id: key,
        subjectId: id,
        status: old?.status ?? "open",
        evidence: mergeEvidence(old?.evidence, o.evidence),
        origins: mergeOrigins(old?.origins, o.origins),
      });
      return false;
    });
    if (!ind.objectProperties.length) delete ind.objectProperties;
  }
  for (const [key, link] of unresolved) {
    if (link.status === "dismissed" || !byId.has(link.subjectId) || !byId.has(link.targetId)) continue;
    const ind = byId.get(link.subjectId)!;
    const { id: _id, subjectId: _subject, status: _status, ...prop } = link;
    void _id;
    void _subject;
    void _status;
    const existing = ind.objectProperties?.find((p) => opKey(p) === opKey(prop));
    if (existing) {
      existing.evidence = mergeEvidence(existing.evidence, prop.evidence);
      existing.origins = mergeOrigins(existing.origins, prop.origins);
    } else (ind.objectProperties ??= []).push(prop);
    unresolved.delete(key);
  }
  if (unresolved.size) notes.push(`${unresolved.size} unresolved relationship${unresolved.size === 1 ? "" : "s"} retained for review`);
  return {
    abox: { individuals: order.map((id) => byId.get(id)!), ...(unresolved.size ? { unresolved: [...unresolved.values()] } : {}) },
    notes,
  };
}

const normLabel = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export interface DuplicateGroup {
  label: string;
  ids: string[];
}

/** Individuals with different ids but the same normalised label — for review, never auto-merged. */
export function findPossibleDuplicates(abox: ABoxResult): DuplicateGroup[] {
  const groups = new Map<string, { label: string; ids: string[] }>();
  for (const ind of abox.individuals) {
    const key = normLabel(ind.label || ind.id.replace(/[-_]+/g, " "));
    if (!key) continue;
    const g = groups.get(key) ?? { label: ind.label || ind.id, ids: [] };
    g.ids.push(ind.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.ids.length > 1);
}

function describeChanges(a: ABoxIndividual, b: ABoxIndividual): string[] {
  const out: string[] = [];
  if (a.classUri !== b.classUri) out.push("class");
  if ((a.label ?? "") !== (b.label ?? "")) out.push("label");
  const ad = new Set((a.dataProperties ?? []).map(dpKey));
  const bd = new Set((b.dataProperties ?? []).map(dpKey));
  const addedD = [...bd].filter((k) => !ad.has(k)).length;
  const removedD = [...ad].filter((k) => !bd.has(k)).length;
  if (addedD) out.push(`+${addedD} value${addedD === 1 ? "" : "s"}`);
  if (removedD) out.push(`−${removedD} value${removedD === 1 ? "" : "s"}`);
  const ao = new Set((a.objectProperties ?? []).map(opKey));
  const bo = new Set((b.objectProperties ?? []).map(opKey));
  const addedO = [...bo].filter((k) => !ao.has(k)).length;
  const removedO = [...ao].filter((k) => !bo.has(k)).length;
  if (addedO) out.push(`+${addedO} link${addedO === 1 ? "" : "s"}`);
  if (removedO) out.push(`−${removedO} link${removedO === 1 ? "" : "s"}`);
  return out;
}

/** What changed between two revisions' contents (modules by name, individuals by id). */
export function diffContents(from: RevisionContent | null, to: RevisionContent): RevisionDiff {
  const fm = new Map((from?.modules ?? []).map((m) => [m.name, m.turtle]));
  const tm = new Map(to.modules.map((m) => [m.name, m.turtle]));
  const modules = {
    added: [...tm.keys()].filter((n) => !fm.has(n)),
    removed: [...fm.keys()].filter((n) => !tm.has(n)),
    changed: [...tm.keys()].filter((n) => fm.has(n) && fm.get(n) !== tm.get(n)),
  };
  const fi = new Map((from?.abox?.individuals ?? []).map((i) => [i.id, i]));
  const ti = new Map((to.abox?.individuals ?? []).map((i) => [i.id, i]));
  const changed: RevisionDiff["individuals"]["changed"] = [];
  for (const [id, b] of ti) {
    const a = fi.get(id);
    if (!a) continue;
    const changes = describeChanges(a, b);
    if (changes.length) changed.push({ id, changes });
  }
  return {
    modules,
    individuals: {
      added: [...ti.keys()].filter((id) => !fi.has(id)),
      removed: [...fi.keys()].filter((id) => !ti.has(id)),
      changed,
    },
  };
}

export function assertionCount(abox: ABoxResult | null): number {
  return (abox?.individuals ?? []).reduce((n, i) => n + 1 + (i.dataProperties?.length ?? 0) + (i.objectProperties?.length ?? 0), 0);
}

/**
 * Re-attach located evidence after an edit that went through a format without
 * it (hand-edited Turtle): individuals and claims that still exist unchanged
 * keep their evidence; new or changed claims get none rather than a guess.
 */
export function carryEvidence(before: ABoxResult, after: ABoxResult): ABoxResult {
  const old = new Map(before.individuals.map((i) => [i.id, i]));
  return {
    individuals: after.individuals.map((ind) => {
      const prev = old.get(ind.id);
      if (!prev) return ind;
      const dpEv = new Map((prev.dataProperties ?? []).map((d) => [dpKey(d), d.evidence]));
      const opEv = new Map((prev.objectProperties ?? []).map((o) => [opKey(o), o.evidence]));
      return {
        ...ind,
        ...(prev.evidence && !ind.evidence ? { evidence: prev.evidence } : {}),
        ...(ind.dataProperties
          ? {
              dataProperties: ind.dataProperties.map((d) =>
                d.evidence || !dpEv.get(dpKey(d)) ? d : { ...d, evidence: dpEv.get(dpKey(d)) },
              ),
            }
          : {}),
        ...(ind.objectProperties
          ? {
              objectProperties: ind.objectProperties.map((o) =>
                o.evidence || !opEv.get(opKey(o)) ? o : { ...o, evidence: opEv.get(opKey(o)) },
              ),
            }
          : {}),
      };
    }),
  };
}
