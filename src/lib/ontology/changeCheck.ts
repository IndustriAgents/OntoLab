// Validate one manual change rather than the whole A-Box: which findings the
// change introduced, which it resolved, and whether any of the new ones block
// a commit (errors block; warnings need an acknowledgement).

import type { ABoxResult, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";
import { validateABox } from "./aboxValidator";

export interface ChangeCheck {
  introduced: ValidationIssue[];
  resolved: ValidationIssue[];
  /** introduced errors: the commit is refused while any remain */
  blocking: ValidationIssue[];
  /** individuals the change added, removed or edited */
  touched: string[];
}

/** A draft checked as a change to its parent, on the server (schema + reasoner). */
export interface DraftCheck extends ChangeCheck {
  contentHash: string;
  /** null when reasoning is off or could not run */
  reasoner: { tier: string; consistent: boolean; issues: ValidationIssue[]; introduced: ValidationIssue[] } | null;
  /** the change cannot be committed: it introduces a schema error or a reasoner error */
  blocked: boolean;
}

/** Identity of a finding across two validations (messages embed values, so they are not compared). */
const issueKey = (i: ValidationIssue) => `${i.code ?? i.message}|${i.id ?? ""}|${i.prop ?? ""}`;

/** Ids of individuals that differ between the two A-Boxes. */
export function touchedIds(prev: ABoxResult | null, next: ABoxResult | null): string[] {
  const a = new Map((prev?.individuals ?? []).map((i) => [i.id, i]));
  const b = new Map((next?.individuals ?? []).map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const [id, ind] of b) {
    const old = a.get(id);
    if (!old || (old !== ind && JSON.stringify(old) !== JSON.stringify(ind))) out.add(id);
  }
  for (const id of a.keys()) if (!b.has(id)) out.add(id);
  return [...out];
}

/** Count findings per key, so two identical findings on one individual stay two. */
function tally(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const m = new Map<string, ValidationIssue[]>();
  for (const i of issues) {
    const k = issueKey(i);
    const arr = m.get(k) ?? [];
    arr.push(i);
    m.set(k, arr);
  }
  return m;
}

/** Findings present after but not before (introduced) and the reverse (resolved). */
export function diffIssues(beforeIssues: ValidationIssue[], afterIssues: ValidationIssue[]): { introduced: ValidationIssue[]; resolved: ValidationIssue[] } {
  const before = tally(beforeIssues);
  const after = tally(afterIssues);
  const introduced: ValidationIssue[] = [];
  const resolved: ValidationIssue[] = [];
  for (const [k, list] of after) introduced.push(...list.slice(before.get(k)?.length ?? 0));
  for (const [k, list] of before) resolved.push(...list.slice(after.get(k)?.length ?? 0));
  return { introduced, resolved };
}

/**
 * Compare validation before and after a change. Findings about untouched
 * individuals are included too: deleting an individual can leave someone
 * else's link dangling, and that is the change's doing.
 */
export function checkChange(prev: ABoxResult | null, next: ABoxResult | null, tbox: TBoxModel, baseIri?: string): ChangeCheck {
  const { introduced, resolved } = diffIssues(prev ? validateABox(prev, tbox, baseIri) : [], next ? validateABox(next, tbox, baseIri) : []);
  return { introduced, resolved, blocking: introduced.filter((i) => i.severity === "error"), touched: touchedIds(prev, next) };
}
