import type { TBoxModel } from "../../types/tbox";
import type { ABoxResult, ValidationIssue } from "../../types/abox";
import { localName, normalizeDatatype, checkLexicalForm, RDFS_LITERAL, XSD_STRING, RDF_LANGSTRING } from "./iri";
import { ancestorsOf, typeClosure, satisfies } from "./hierarchy";
import { mintUri } from "./uri";

/**
 * Validate the structured A-Box against the T-Box. Findings are flag-and-keep:
 * nothing is dropped, the review screen surfaces them for the user to resolve.
 *
 * Errors (would produce a broken or ambiguous graph): duplicate ids, two ids that
 * mint the same IRI, an id that collides with a T-Box term, unknown classes /
 * properties, dangling object-property targets, disjoint-class violations.
 * Warnings (schema disagreement, kept for review): domain / range / datatype
 * mismatches, ill-formed literals, functional properties with several values,
 * unmet owl:Restrictions.
 */
export function validateABox(abox: ABoxResult, tbox: TBoxModel, baseIri?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  /** Run the checks of one property assertion, tagging what they find with the property. */
  const about = (prop: string, check: () => void) => {
    const mark = issues.length;
    check();
    for (let i = mark; i < issues.length; i++) issues[i].prop ??= prop;
  };
  const base = baseIri || tbox.baseIri;

  const classSet = new Set(tbox.classes.map((c) => c.uri));
  const classByUri = new Map(tbox.classes.map((c) => [c.uri, c]));
  const dataProps = new Map(tbox.dataProps.map((p) => [p.uri, p]));
  const objProps = new Map(tbox.objectProps.map((p) => [p.uri, p]));
  const termIris = new Set([...classSet, ...dataProps.keys(), ...objProps.keys()]);

  const typesOf = (ind: ABoxResult["individuals"][number]) => [ind.classUri, ...(ind.additionalTypes ?? [])];
  const indTypes = new Map<string, string[]>();
  const whereOf = (ind: ABoxResult["individuals"][number]) => (ind.label ? `${ind.label} (${ind.id})` : ind.id);

  // ── identity: duplicate ids, IRI collisions, T-Box term collisions ──
  const seenIds = new Set<string>();
  const iriOwner = new Map<string, string>();
  for (const ind of abox.individuals) {
    const where = whereOf(ind);
    if (seenIds.has(ind.id)) {
      issues.push({ severity: "error", code: "duplicate-id", message: `Duplicate individual id "${ind.id}"`, where, id: ind.id });
    }
    seenIds.add(ind.id);
    if (!indTypes.has(ind.id)) indTypes.set(ind.id, typesOf(ind));

    const iri = ind.iri || mintUri(base, ind.id);
    const owner = iriOwner.get(iri);
    if (owner && owner !== ind.id) {
      issues.push({
        severity: "error",
        code: "iri-collision",
        message: `Ids "${owner}" and "${ind.id}" mint the same IRI <${iri}> — rename one of them`,
        where,
        id: ind.id,
      });
    } else iriOwner.set(iri, ind.id);
    if (termIris.has(iri)) {
      issues.push({
        severity: "error",
        code: "tbox-collision",
        message: `Individual IRI <${iri}> is already a T-Box term (${localName(iri)}) — change the base IRI or the id`,
        where,
        id: ind.id,
      });
    }
  }

  for (const ind of abox.individuals) {
    const where = whereOf(ind);
    const id = ind.id;
    const types = typesOf(ind);

    // ── typing ──
    if (!classSet.has(ind.classUri)) {
      issues.push({ severity: "error", code: "unknown-class", message: `Unknown class: ${ind.classUri}`, where, id });
    }
    for (const t of ind.additionalTypes ?? []) {
      if (!classSet.has(t)) issues.push({ severity: "warn", code: "unknown-class", message: `Unknown additional type: ${t}`, where, id });
    }
    const closure = typeClosure(tbox, types);
    for (const c of closure) {
      for (const d of classByUri.get(c)?.disjointWith ?? []) {
        if (closure.has(d) && c < d) {
          issues.push({
            severity: "error",
            code: "disjoint",
            message: `${localName(ind.classUri)} is typed as both ${localName(c)} and ${localName(d)}, which are declared disjoint`,
            where,
            id,
          });
        }
      }
    }

    // ── data properties ──
    const dataCount = new Map<string, number>();
    for (const dp of ind.dataProperties ?? []) {
      about(dp.propUri, () => {
      const prop = dataProps.get(dp.propUri);
      if (!prop) {
        issues.push({ severity: "error", code: "unknown-property", message: `Unknown data property: ${dp.propUri}`, where, id });
        return;
      }
      dataCount.set(dp.propUri, (dataCount.get(dp.propUri) ?? 0) + 1);
      if (!satisfies(tbox, prop.domain, types)) {
        issues.push({
          severity: "warn",
          code: "domain",
          message: `${localName(dp.propUri)} expects domain ${prop.domain.map(localName).join(" or ")}, but this is a ${localName(ind.classUri)}`,
          where,
          id,
        });
      }
      const declared = normalizeDatatype(dp.datatype);
      if (dp.datatype && !declared) {
        issues.push({ severity: "warn", code: "datatype", message: `${localName(dp.propUri)}: unrecognised datatype "${dp.datatype}" (will be exported as xsd:string)`, where, id });
      }
      const ranges = prop.range.map((r) => normalizeDatatype(r) ?? r);
      const anyLiteral = ranges.length === 0 || ranges.includes(RDFS_LITERAL);
      if (dp.lang) {
        if (declared && declared !== XSD_STRING && declared !== RDF_LANGSTRING) {
          issues.push({ severity: "warn", code: "datatype", message: `${localName(dp.propUri)}: a language tag ("${dp.lang}") is only valid for text values, not ${localName(declared)}`, where, id });
        } else if (!anyLiteral && !ranges.includes(XSD_STRING) && !ranges.includes(RDF_LANGSTRING)) {
          issues.push({ severity: "warn", code: "range", message: `${localName(dp.propUri)} expects ${ranges.map(localName).join(" or ")}, got language-tagged text`, where, id });
        }
        return;
      }
      if (declared && !anyLiteral && !ranges.includes(declared)) {
        issues.push({
          severity: "warn",
          code: "range",
          message: `${localName(dp.propUri)} expects ${ranges.map(localName).join(" or ")}, got ${localName(declared)}`,
          where,
          id,
        });
      }
      // Effective datatype = declared, else the single declared range (mirrors the serializer).
      const effective = declared ?? (ranges.length === 1 && ranges[0] !== RDFS_LITERAL ? ranges[0] : undefined);
      if (effective && dp.value.trim() !== "") {
        const bad = checkLexicalForm(dp.value, effective);
        if (bad) issues.push({ severity: "warn", code: "lexical", message: `${localName(dp.propUri)}: ${bad}`, where, id });
      }
          });
    }
    for (const [uri, n] of dataCount) {
      if (n > 1 && dataProps.get(uri)?.functional) {
        issues.push({ severity: "warn", code: "functional", message: `${localName(uri)} is functional (at most one value) but has ${n} values`, where, id, prop: uri });
      }
    }

    // ── object properties ──
    const objCount = new Map<string, number>();
    for (const op of ind.objectProperties ?? []) {
      about(op.propUri, () => {
      const prop = objProps.get(op.propUri);
      if (!prop) {
        issues.push({ severity: "error", code: "unknown-property", message: `Unknown object property: ${op.propUri}`, where, id });
        return;
      }
      objCount.set(op.propUri, (objCount.get(op.propUri) ?? 0) + 1);
      const targetTypes = indTypes.get(op.targetId);
      if (!targetTypes) {
        issues.push({ severity: "error", code: "dangling-target", message: `${localName(op.propUri)} → "${op.targetId}" references an individual that does not exist`, where, id });
        return;
      }
      if (!satisfies(tbox, prop.domain, types)) {
        issues.push({
          severity: "warn",
          code: "domain",
          message: `${localName(op.propUri)} expects domain ${prop.domain.map(localName).join(" or ")}, but this is a ${localName(ind.classUri)}`,
          where,
          id,
        });
      }
      if (prop.range.length && !satisfies(tbox, prop.range, targetTypes)) {
        issues.push({
          severity: "warn",
          code: "range",
          message: `${localName(op.propUri)} expects range ${prop.range.map(localName).join(" or ")}, but "${op.targetId}" is a ${localName(targetTypes[0])}`,
          where,
          id,
        });
      }
          });
    }
    for (const [uri, n] of objCount) {
      if (n > 1 && objProps.get(uri)?.functional) {
        issues.push({ severity: "warn", code: "functional", message: `${localName(uri)} is functional (at most one value) but has ${n} values`, where, id, prop: uri });
      }
    }

    // ── owl:Restrictions (existential / minimum cardinality) on the individual's classes ──
    for (const r of tbox.restrictions ?? []) {
      if (!closure.has(r.onClass)) continue;
      const count = (dataCount.get(r.onProperty) ?? 0) + (objCount.get(r.onProperty) ?? 0);
      const need = r.kind === "someValuesFrom" ? 1 : r.kind === "minCardinality" || r.kind === "cardinality" ? r.n ?? 0 : 0;
      if (need > 0 && count < need) {
        issues.push({
          severity: "warn",
          code: "restriction",
          message: `${localName(r.onClass)} requires ${need > 1 ? `at least ${need} ` : "a "}${localName(r.onProperty)}${r.value ? ` (${localName(r.value)})` : ""}, found ${count}`,
          where,
          id,
          prop: r.onProperty,
        });
      }
      if ((r.kind === "maxCardinality" || r.kind === "cardinality") && r.n != null && count > r.n) {
        issues.push({ severity: "warn", code: "restriction", message: `${localName(r.onClass)} allows at most ${r.n} ${localName(r.onProperty)}, found ${count}`, where, id, prop: r.onProperty });
      }
    }
  }

  return issues;
}

/** Convenience: the set of an individual's classes including ancestors. */
export { ancestorsOf };
