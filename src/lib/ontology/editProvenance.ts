// Provenance for manual A-Box edits: every fact a person adds or changes is
// marked accepted-by-user, and each change is appended to the draft's audit
// trail so reviewers can see who changed what before it is committed.

import type { ABoxDataProp, ABoxIndividual, ABoxObjectProp, ABoxResult, FactReview, ManualEdit } from "../../types/abox";
import type { RevisionContent } from "../../types/project";
import { dataKey, factKey, linkKey } from "./factReview";
import { localName } from "./iri";

export const MAX_EDIT_LOG = 1000;

export interface StampOptions {
  at: string;
  /** who made the change (email, name or user id) */
  by: string;
  label?: string;
}

const userReview = (o: StampOptions): FactReview => ({ status: "accepted", by: "user", at: o.at, editedBy: o.by });

const sameTypes = (a: ABoxIndividual, b: ABoxIndividual) =>
  a.classUri === b.classUri && JSON.stringify([...(a.additionalTypes ?? [])].sort()) === JSON.stringify([...(b.additionalTypes ?? [])].sort());

const show = (v: string) => (v.length > 60 ? v.slice(0, 57) + "…" : v);

/** Multiset difference by key: the entries of `next` absent from `prev`, and the reverse. */
function diffBy<T>(prev: T[], next: T[], key: (t: T) => string): { added: T[]; removed: T[] } {
  const left = new Map<string, number>();
  for (const p of prev) left.set(key(p), (left.get(key(p)) ?? 0) + 1);
  const added: T[] = [];
  for (const n of next) {
    const k = key(n);
    const c = left.get(k) ?? 0;
    if (c > 0) left.set(k, c - 1);
    else added.push(n);
  }
  const right = new Map<string, number>();
  for (const n of next) right.set(key(n), (right.get(key(n)) ?? 0) + 1);
  const removed: T[] = [];
  for (const p of prev) {
    const k = key(p);
    const c = right.get(k) ?? 0;
    if (c > 0) right.set(k, c - 1);
    else removed.push(p);
  }
  return { added, removed };
}

/**
 * Apply a manual A-Box change to revision content: facts that are new or
 * changed relative to `prev.abox` get a user review, and the change is logged
 * in `content.edits`. Facts the edit did not touch keep their review as is.
 */
export function stampManual(prev: RevisionContent, nextAbox: ABoxResult, opts: StampOptions): RevisionContent {
  const before = new Map((prev.abox?.individuals ?? []).map((i) => [i.id, i]));
  const after = new Set(nextAbox.individuals.map((i) => i.id));
  const log: ManualEdit[] = [];
  const entry = (kind: ManualEdit["kind"], target: string, summary: string) =>
    log.push({ at: opts.at, by: opts.by, ...(opts.label ? { label: opts.label } : {}), kind, target, summary });

  const stampData = (d: ABoxDataProp): ABoxDataProp => ({ ...d, review: userReview(opts) });
  const stampLink = (o: ABoxObjectProp): ABoxObjectProp => ({ ...o, review: userReview(opts) });

  const individuals = nextAbox.individuals.map((ind) => {
    const old = before.get(ind.id);
    const name = ind.label || ind.id;
    if (!old) {
      entry("add", factKey(ind.id, "type"), `Added ${name} (${localName(ind.classUri)})`);
      return {
        ...ind,
        review: userReview(opts),
        dataProperties: ind.dataProperties?.map(stampData),
        objectProperties: ind.objectProperties?.map(stampLink),
      };
    }
    if (old === ind) return ind;

    const out: ABoxIndividual = { ...ind };
    if (!sameTypes(old, ind)) {
      out.review = userReview(opts);
      entry("change", factKey(ind.id, "type"), `${name}: class ${localName(old.classUri)} → ${localName(ind.classUri)}`);
    }
    if ((old.label ?? "") !== (ind.label ?? "")) {
      entry("change", `${ind.id}#label`, `${old.label || old.id}: renamed to "${show(ind.label ?? "")}"`);
    }

    const data = diffBy(old.dataProperties ?? [], ind.dataProperties ?? [], dataKey);
    if (data.added.length) {
      const fresh = new Set(data.added);
      out.dataProperties = ind.dataProperties?.map((d) => (fresh.has(d) ? stampData(d) : d));
    }
    for (const d of data.added) entry("add", factKey(ind.id, "data", d), `${name} ${localName(d.propUri)} = "${show(d.value)}"`);
    for (const d of data.removed) entry("remove", factKey(ind.id, "data", d), `${name} ${localName(d.propUri)} = "${show(d.value)}" removed`);

    const links = diffBy(old.objectProperties ?? [], ind.objectProperties ?? [], linkKey);
    if (links.added.length) {
      const fresh = new Set(links.added);
      out.objectProperties = ind.objectProperties?.map((o) => (fresh.has(o) ? stampLink(o) : o));
    }
    for (const o of links.added) entry("add", factKey(ind.id, "link", o), `${name} ${localName(o.propUri)} → ${o.targetId}`);
    for (const o of links.removed) entry("remove", factKey(ind.id, "link", o), `${name} ${localName(o.propUri)} → ${o.targetId} removed`);
    return out;
  });

  for (const [id, old] of before) {
    if (!after.has(id)) entry("remove", factKey(id, "type"), `Removed ${old.label || id}`);
  }

  if (!log.length) return { ...prev, abox: { ...nextAbox, individuals } };
  return { ...prev, abox: { ...nextAbox, individuals }, edits: [...(prev.edits ?? []), ...log].slice(-MAX_EDIT_LOG) };
}
