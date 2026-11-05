import type { TBoxModel, TBoxProperty } from "../../types/tbox";
import type { ABoxIndividual, ABoxResult } from "../../types/abox";
import { localName, normalizeDatatype, NUMERIC_DATATYPES, XSD } from "./iri";
import { satisfies, typeClosure } from "./hierarchy";

/**
 * Schema guidance for manual editing: which properties fit an individual, which
 * individuals fit a property's range, which required values are still missing.
 * The validator flags mistakes after the fact; this keeps the pickers honest up front.
 */

const typesOf = (ind: Pick<ABoxIndividual, "classUri" | "additionalTypes">) => [ind.classUri, ...(ind.additionalTypes ?? [])];

/** Domain of a property, inherited from its super-properties when it declares none. */
export function effectiveDomain(tbox: TBoxModel, prop: TBoxProperty, seen = new Set<string>()): string[] {
  if (prop.domain.length || seen.has(prop.uri)) return prop.domain;
  seen.add(prop.uri);
  const all = [...tbox.objectProps, ...tbox.dataProps];
  for (const parent of prop.subPropertyOf ?? []) {
    const p = all.find((x) => x.uri === parent);
    const d = p ? effectiveDomain(tbox, p, seen) : [];
    if (d.length) return d;
  }
  return [];
}

/** Range of a property, inherited from its super-properties when it declares none. */
export function effectiveRange(tbox: TBoxModel, prop: TBoxProperty, seen = new Set<string>()): string[] {
  if (prop.range.length || seen.has(prop.uri)) return prop.range;
  seen.add(prop.uri);
  const all = [...tbox.objectProps, ...tbox.dataProps];
  for (const parent of prop.subPropertyOf ?? []) {
    const p = all.find((x) => x.uri === parent);
    const r = p ? effectiveRange(tbox, p, seen) : [];
    if (r.length) return r;
  }
  return [];
}

/** Data and object properties whose domain admits an individual of these classes (no domain = anything). */
export function applicableProps(tbox: TBoxModel, classes: (string | undefined)[]): { data: TBoxProperty[]; object: TBoxProperty[] } {
  const fits = (p: TBoxProperty) => satisfies(tbox, effectiveDomain(tbox, p), classes);
  return { data: tbox.dataProps.filter(fits), object: tbox.objectProps.filter(fits) };
}

/** Individuals whose types satisfy the range of an object property (no range = all of them). */
export function rangeTargets(tbox: TBoxModel, abox: ABoxResult, propUri: string): ABoxIndividual[] {
  const prop = tbox.objectProps.find((p) => p.uri === propUri);
  if (!prop) return abox.individuals;
  const range = effectiveRange(tbox, prop);
  return abox.individuals.filter((i) => satisfies(tbox, range, typesOf(i)));
}

export interface MissingSlot {
  propUri: string;
  kind: "data" | "object";
  /** how many more values the schema asks for */
  need: number;
  /** the filler class / datatype a restriction names */
  filler?: string;
  /** readable reason, e.g. "Pump requires a hasPart" */
  reason: string;
}

/** Required values an individual does not have yet: unmet someValuesFrom / min-cardinality restrictions. */
export function missingSlots(tbox: TBoxModel, ind: ABoxIndividual): MissingSlot[] {
  const closure = typeClosure(tbox, typesOf(ind));
  const count = new Map<string, number>();
  for (const d of ind.dataProperties ?? []) count.set(d.propUri, (count.get(d.propUri) ?? 0) + 1);
  for (const o of ind.objectProperties ?? []) count.set(o.propUri, (count.get(o.propUri) ?? 0) + 1);
  const dataUris = new Set(tbox.dataProps.map((p) => p.uri));

  const out = new Map<string, MissingSlot>();
  for (const r of tbox.restrictions ?? []) {
    if (!closure.has(r.onClass)) continue;
    const want = r.kind === "someValuesFrom" ? 1 : r.kind === "minCardinality" || r.kind === "cardinality" ? (r.n ?? 0) : 0;
    const need = want - (count.get(r.onProperty) ?? 0);
    if (need <= 0) continue;
    const prev = out.get(r.onProperty);
    if (prev && prev.need >= need) continue;
    out.set(r.onProperty, {
      propUri: r.onProperty,
      kind: dataUris.has(r.onProperty) ? "data" : "object",
      need,
      filler: r.value,
      reason: `${localName(r.onClass)} requires ${want > 1 ? `at least ${want} ` : "a "}${localName(r.onProperty)}${r.value ? ` (${localName(r.value)})` : ""}`,
    });
  }
  return [...out.values()];
}

export type InputKind = "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "time";

/** The input control that fits a datatype. */
export function inputKindFor(datatype?: string): InputKind {
  const dt = normalizeDatatype(datatype);
  if (!dt) return "text";
  if (dt === XSD + "boolean") return "boolean";
  if (dt === XSD + "date") return "date";
  if (dt === XSD + "dateTime") return "datetime";
  if (dt === XSD + "time") return "time";
  if (NUMERIC_DATATYPES.has(dt)) return /integer|int$|long|short|byte/i.test(localName(dt)) ? "integer" : "number";
  return "text";
}

/** The datatype a new value of this data property should carry: the single declared range, if any. */
export function defaultDatatype(tbox: TBoxModel, propUri: string): string | undefined {
  const prop = tbox.dataProps.find((p) => p.uri === propUri);
  if (!prop) return undefined;
  const range = effectiveRange(tbox, prop).map((r) => normalizeDatatype(r) ?? r);
  return range.length === 1 ? range[0] : undefined;
}
