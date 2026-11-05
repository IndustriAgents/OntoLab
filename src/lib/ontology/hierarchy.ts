import type { TBoxModel } from "../../types/tbox";

/** A class plus all its transitive rdfs:subClassOf ancestors (cycle-safe). */
export function ancestorsOf(tbox: Pick<TBoxModel, "subClassOf">, cls: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!cls) return out;
  const stack = [cls];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.has(c)) continue;
    out.add(c);
    for (const parent of tbox.subClassOf[c] ?? []) stack.push(parent);
  }
  return out;
}

/** Union of ancestors over several classes (an individual's full type set). */
export function typeClosure(tbox: Pick<TBoxModel, "subClassOf">, classes: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const c of classes) for (const a of ancestorsOf(tbox, c)) out.add(a);
  return out;
}

/** Does `cls` (or an ancestor) appear in `allowed`? Empty `allowed` means anything goes. */
export function satisfies(tbox: Pick<TBoxModel, "subClassOf">, allowed: string[], classes: (string | undefined)[]): boolean {
  if (allowed.length === 0) return true;
  const anc = typeClosure(tbox, classes);
  return allowed.some((a) => anc.has(a));
}

/** Direct subclasses per class (inverse of subClassOf), for rendering trees. */
export function childrenMap(tbox: Pick<TBoxModel, "subClassOf" | "classes">): Map<string, string[]> {
  const kids = new Map<string, string[]>();
  for (const c of tbox.classes) kids.set(c.uri, []);
  for (const [child, parents] of Object.entries(tbox.subClassOf)) {
    for (const p of parents) {
      const arr = kids.get(p) ?? [];
      arr.push(child);
      kids.set(p, arr);
    }
  }
  return kids;
}
