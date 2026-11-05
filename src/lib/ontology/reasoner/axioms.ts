import type { TBoxModel } from "../../../types/tbox";
import type { ABoxResult } from "../../../types/abox";
import type { OntoModule } from "../../../types/validation";
import { parseTBox } from "../tboxParser";
import { localName } from "../iri";
import type { Axiom, AxiomKind } from "./types";

/** Collects axioms, numbering them and dropping exact repeats (first module wins). */
export class AxiomSet {
  readonly list: Axiom[] = [];
  private seen = new Set<string>();

  add(kind: AxiomKind, args: string[], extra: { module?: string; individualId?: string } = {}): void {
    // symmetric kinds are stored once, in a canonical order
    const symmetric = kind === "equivalentClass" || kind === "disjointWith" || kind === "equivalentProperty" || kind === "propertyDisjointWith";
    const key = `${kind}|${(symmetric ? [...args].sort() : args).join("|")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ id: `a${this.list.length}`, kind, args, ...extra });
  }
}

/** Axioms asserted by a parsed T-Box (optionally tagged with the module they come from). */
export function addTBoxAxioms(set: AxiomSet, tbox: TBoxModel, module?: string): void {
  const m = module ? { module } : {};
  for (const [child, parents] of Object.entries(tbox.subClassOf)) for (const p of parents) set.add("subClassOf", [child, p], m);
  for (const c of tbox.classes) {
    for (const d of c.disjointWith ?? []) set.add("disjointWith", [c.uri, d], m);
    for (const e of c.equivalentTo ?? []) set.add("equivalentClass", [c.uri, e], m);
  }
  for (const p of [...tbox.objectProps, ...tbox.dataProps]) {
    for (const d of p.domain) set.add("domain", [p.uri, d], m);
    if (p.kind === "object") for (const r of p.range) set.add("range", [p.uri, r], m);
    for (const s of p.subPropertyOf ?? []) set.add("subPropertyOf", [p.uri, s], m);
    for (const e of p.equivalentTo ?? []) set.add("equivalentProperty", [p.uri, e], m);
    for (const d of p.disjointWith ?? []) set.add("propertyDisjointWith", [p.uri, d], m);
    if (p.inverseOf) set.add("inverseOf", [p.uri, p.inverseOf], m);
    if (p.functional) set.add("functional", [p.uri], m);
    for (const ch of p.characteristics ?? []) set.add("characteristic", [p.uri, ch], m);
  }
  for (const r of tbox.restrictions ?? []) {
    set.add("restriction", [r.onClass, r.onProperty, r.kind, r.value ?? "", r.n != null ? String(r.n) : ""], m);
  }
}

/** Axioms of several modules, each parsed on its own so explanations can name the file. Unparseable modules are skipped. */
export function axiomsOfModules(modules: Pick<OntoModule, "name" | "turtle">[], set = new AxiomSet()): AxiomSet {
  for (const mod of modules) {
    let tbox: TBoxModel;
    try {
      tbox = parseTBox(mod.turtle);
    } catch {
      continue;
    }
    addTBoxAxioms(set, tbox, mod.name);
  }
  return set;
}

/** Axioms asserted by an A-Box. Individuals are named by their `id`. */
export function addABoxAxioms(set: AxiomSet, abox: ABoxResult): void {
  for (const ind of abox.individuals) {
    const at = { individualId: ind.id };
    if (ind.classUri) set.add("type", [ind.id, ind.classUri], at);
    for (const t of ind.additionalTypes ?? []) set.add("type", [ind.id, t], at);
    for (const s of ind.sameAs ?? []) set.add("sameAs", [ind.id, s], at);
    for (const d of ind.differentFrom ?? []) set.add("differentFrom", [ind.id, d], at);
    for (const op of ind.objectProperties ?? []) set.add("link", [ind.id, op.propUri, op.targetId], at);
    for (const dp of ind.dataProperties ?? []) set.add("data", [ind.id, dp.propUri, dp.value, dp.datatype ?? ""], at);
  }
}

/** Readable explanation lines for a finding, with where each axiom comes from. */
export function explanationLines(axioms: Axiom[]): string[] {
  return axioms.map((a) => {
    const where = a.module ? ` — ${a.module}` : a.individualId ? ` — asserted on ${a.individualId}` : "";
    return `${describeAxiom(a)}${where}`;
  });
}

/** A short human reading of an axiom, for explanations in the UI. */
export function describeAxiom(a: Axiom): string {
  const n = (s: string | undefined) => (s ? localName(s) || s : "?");
  const [x, y, z, w, k] = a.args;
  switch (a.kind) {
    case "subClassOf":
      return `${n(x)} ⊑ ${n(y)}`;
    case "equivalentClass":
      return `${n(x)} ≡ ${n(y)}`;
    case "disjointWith":
      return `${n(x)} disjoint with ${n(y)}`;
    case "domain":
      return `domain(${n(x)}) = ${n(y)}`;
    case "range":
      return `range(${n(x)}) = ${n(y)}`;
    case "subPropertyOf":
      return `${n(x)} ⊑ ${n(y)} (property)`;
    case "equivalentProperty":
      return `${n(x)} ≡ ${n(y)} (property)`;
    case "inverseOf":
      return `${n(x)} inverse of ${n(y)}`;
    case "functional":
      return `${n(x)} is functional`;
    case "characteristic":
      return `${n(x)} is ${y}`;
    case "propertyDisjointWith":
      return `${n(x)} disjoint with ${n(y)} (property)`;
    case "restriction": {
      const filler = w ? ` ${n(w)}` : "";
      if (z === "someValuesFrom") return `${n(x)} ⊑ ${n(y)} some${filler}`;
      if (z === "allValuesFrom") return `${n(x)} ⊑ ${n(y)} only${filler}`;
      const op = z === "minCardinality" ? "min" : z === "maxCardinality" ? "max" : "exactly";
      return `${n(x)} ⊑ ${n(y)} ${op} ${k}${filler}`;
    }
    case "type":
      return `${x} is a ${n(y)}`;
    case "link":
      return `${x} ${n(y)} ${z}`;
    case "data":
      return `${x} ${n(y)} "${z}"`;
    case "sameAs":
      return `${x} same as ${n(y)}`;
    case "differentFrom":
      return `${x} different from ${y}`;
    case "other":
      return x ?? "";
  }
}
