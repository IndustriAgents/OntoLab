import { Parser, type Quad } from "n3";
import { parseTBox, mergeTBox } from "./tboxParser";
import type { TBoxModel, TBoxProperty } from "../../types/tbox";
import type { OntoModule, OntoDiff, ValidationIssue, ValidationReport } from "../../types/validation";
import { RDF, RDFS, OWL, STD_NAMESPACES, localName, namespaceOf } from "./iri";
import { reasonModules, entailmentDiff, explanationLines } from "./reasoner/index";

const TYPE = RDF + "type";
const SUBCLASS = RDFS + "subClassOf";
const DOMAIN = RDFS + "domain";
const RANGE = RDFS + "range";
const IMPORTS = OWL + "imports";
const ONTOLOGY = OWL + "Ontology";

const CLASS_TYPES = new Set([OWL + "Class", RDFS + "Class"]);
const OBJ_PROP = OWL + "ObjectProperty";
const DATA_PROP = OWL + "DatatypeProperty";

/** Standard vocab namespaces — references into these are always allowed. */
const STD_NS = STD_NAMESPACES;

function safeParseTBox(turtle: string): TBoxModel | null {
  try {
    return parseTBox(turtle);
  } catch {
    return null;
  }
}

function mergeModels(modules: OntoModule[]): TBoxModel {
  const models = modules.map((m) => safeParseTBox(m.turtle)).filter((m): m is TBoxModel => m != null);
  return mergeTBox(models);
}

/** Stable signature of a class's superclasses / a property's domain+range. */
function classSig(m: TBoxModel, uri: string): string {
  return [...(m.subClassOf[uri] ?? [])].sort().join(",");
}
function propSig(p: TBoxProperty): string {
  return `${[...p.domain].sort().join(",")}|${[...p.range].sort().join(",")}`;
}

/**
 * Validate a candidate change (a new or edited module) against the committed
 * base ontology. Structural checks block the merge (errors); regression and
 * import issues are surfaced as warnings/info. With `reason` (the default) the
 * in-process OWL 2 RL reasoner also runs on the base and on base + change:
 * classes the change makes unsatisfiable are errors, and entailments that change
 * between terms that already existed are warnings (with the axioms behind them).
 *
 * If `draft.id` matches a base module the change is treated as an EDIT of that
 * module (so removals/changes are detectable); otherwise it is a NEW module
 * unioned on top of the base.
 */
export function validateOntology(
  baseModules: OntoModule[],
  draft: { id?: string; name: string; turtle: string },
  opts: { reason?: boolean } = {},
): ValidationReport {
  const reason = opts.reason ?? true;
  const issues: ValidationIssue[] = [];

  const isEdit = draft.id != null && baseModules.some((m) => m.id === draft.id);
  const draftModule: OntoModule = { id: draft.id ?? "__draft__", name: draft.name, turtle: draft.turtle };
  const afterModules: OntoModule[] = isEdit
    ? baseModules.map((m) => (m.id === draft.id ? draftModule : m))
    : [...baseModules, draftModule];

  // ── 1. Parse every module (collect quads with provenance) ──
  const afterQuads: { q: Quad; module: string }[] = [];
  for (const m of afterModules) {
    let quads: Quad[];
    try {
      quads = new Parser().parse(m.turtle);
    } catch (e) {
      issues.push({
        severity: "error",
        code: "parse-error",
        message: `Turtle parse error: ${e instanceof Error ? e.message : String(e)}`,
        module: m.name,
      });
      continue;
    }
    for (const q of quads) afterQuads.push({ q, module: m.name });
  }

  // ── Index the merged (base + change) graph ──
  const typeOf = new Map<string, Set<string>>(); // subject -> rdf:type objects
  const subClassEdges: { child: string; parent: string; module: string }[] = [];
  const refUses: { target: string; pred: string; subject: string; module: string }[] = [];
  const importTargets: { iri: string; module: string }[] = [];
  const ontologyIris = new Set<string>();

  for (const { q, module } of afterQuads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    const o = q.object;
    if (p === TYPE) {
      const set = typeOf.get(s) ?? new Set<string>();
      set.add(o.value);
      typeOf.set(s, set);
      if (o.value === ONTOLOGY) ontologyIris.add(s);
    } else if (p === IMPORTS) {
      if (o.termType === "NamedNode") importTargets.push({ iri: o.value, module });
    } else if (p === SUBCLASS) {
      if (o.termType === "NamedNode") {
        subClassEdges.push({ child: s, parent: o.value, module });
        refUses.push({ target: o.value, pred: "rdfs:subClassOf", subject: s, module });
      }
    } else if (p === DOMAIN) {
      if (o.termType === "NamedNode") refUses.push({ target: o.value, pred: "rdfs:domain", subject: s, module });
    } else if (p === RANGE) {
      if (o.termType === "NamedNode") refUses.push({ target: o.value, pred: "rdfs:range", subject: s, module });
    }
  }

  // Declared terms.
  const declaredClasses = new Set<string>();
  const declaredObjProps = new Set<string>();
  const declaredDataProps = new Set<string>();
  for (const [s, types] of typeOf) {
    if ([...types].some((t) => CLASS_TYPES.has(t))) declaredClasses.add(s);
    if (types.has(OBJ_PROP)) declaredObjProps.add(s);
    if (types.has(DATA_PROP)) declaredDataProps.add(s);
  }
  // Subjects of rdfs:subClassOf are classes too (matches parseTBox semantics).
  for (const e of subClassEdges) declaredClasses.add(e.child);

  // Local namespaces = the namespaces in which this ontology declares its own
  // terms. References into other namespaces (external vocab) are not our concern.
  const localNs = new Set<string>();
  for (const u of [...declaredClasses, ...declaredObjProps, ...declaredDataProps]) localNs.add(namespaceOf(u));

  // ── 2. dangling-ref: a local-namespace target used but not declared as a class ──
  const seenDangling = new Set<string>();
  for (const u of refUses) {
    const ns = namespaceOf(u.target);
    if (STD_NS.has(ns)) continue; // standard vocab (e.g. xsd datatype range)
    if (!localNs.has(ns)) continue; // external vocab — not validated here
    if (declaredClasses.has(u.target)) continue; // resolves to a declared class
    const key = `${u.pred} ${u.target} <- ${u.subject}`;
    if (seenDangling.has(key)) continue;
    seenDangling.add(key);
    issues.push({
      severity: "error",
      code: "dangling-ref",
      message: `${localName(u.subject)} ${u.pred} ${localName(u.target)}, but ${localName(u.target)} is not a declared class in the ontology.`,
      module: u.module,
      subject: u.target,
    });
  }

  // ── 3. subclass-cycle: DFS over the subClassOf graph ──
  const adj = new Map<string, string[]>();
  for (const e of subClassEdges) {
    const arr = adj.get(e.child) ?? [];
    arr.push(e.parent);
    adj.set(e.child, arr);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();
  const visit = (n: string) => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(m);
        const ring = stack.slice(idx).concat(m).map(localName);
        const key = [...ring].sort().join("|");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          issues.push({
            severity: "error",
            code: "subclass-cycle",
            message: `Subclass cycle: ${ring.join(" → ")}.`,
          });
        }
      } else if (c === WHITE) {
        visit(m);
      }
    }
    stack.pop();
    color.set(n, BLACK);
  };
  for (const n of adj.keys()) if ((color.get(n) ?? WHITE) === WHITE) visit(n);

  // ── 4. type-conflict: a URI typed as more than one of class/obj-prop/data-prop ──
  // Object+data property on one URI is a genuine conflict (OWL 2 forbids it);
  // class+property is legal OWL 2 punning, so it is only reported as a warning.
  for (const [s, types] of typeOf) {
    const isClass = [...types].some((t) => CLASS_TYPES.has(t));
    const isObj = types.has(OBJ_PROP);
    const isData = types.has(DATA_PROP);
    if (isObj && isData) {
      issues.push({
        severity: "error",
        code: "type-conflict",
        message: `${localName(s)} is declared as both object property and data property.`,
        subject: s,
      });
    } else if (isClass && (isObj || isData)) {
      issues.push({
        severity: "warning",
        code: "type-conflict",
        message: `${localName(s)} is declared as both class and ${isObj ? "object" : "data"} property (OWL 2 punning) — allowed, but easy to confuse.`,
        subject: s,
      });
    }
  }

  // ── 5. unresolved-import: owl:imports with no matching loaded module ──
  const seenImport = new Set<string>();
  for (const imp of importTargets) {
    if (ontologyIris.has(imp.iri) || seenImport.has(imp.iri)) continue;
    seenImport.add(imp.iri);
    issues.push({
      severity: "warning",
      code: "unresolved-import",
      message: `owl:imports <${imp.iri}> is not provided by any loaded module.`,
      module: imp.module,
      subject: imp.iri,
    });
  }

  // ── 6. Regression diff: base → (base + change) ──
  const baseModel = mergeModels(baseModules);
  const afterModel = mergeModels(afterModules);

  const setOf = (uris: { uri: string }[]) => new Set(uris.map((x) => x.uri));
  const diffSet = (before: Set<string>, after: Set<string>) => ({
    added: [...after].filter((u) => !before.has(u)),
    removed: [...before].filter((u) => !after.has(u)),
  });

  const c = diffSet(setOf(baseModel.classes), setOf(afterModel.classes));
  const o = diffSet(setOf(baseModel.objectProps), setOf(afterModel.objectProps));
  const d = diffSet(setOf(baseModel.dataProps), setOf(afterModel.dataProps));

  const diff: OntoDiff = {
    added: { classes: c.added, objectProps: o.added, dataProps: d.added },
    removed: { classes: c.removed, objectProps: o.removed, dataProps: d.removed },
    modified: [],
  };

  for (const u of [...c.removed, ...o.removed, ...d.removed]) {
    issues.push({
      severity: "error",
      code: "removed-term",
      message: `${localName(u)} existed in the base ontology but is removed by this change.`,
      subject: u,
    });
  }

  // modified-term: term present in both, axioms changed. With reasoning on, the
  // entailment diff below says what changed and why; without it, compare the
  // asserted superclasses.
  const baseClassUris = setOf(baseModel.classes);
  const afterClassUris = setOf(afterModel.classes);
  if (!reason) {
    for (const u of [...afterClassUris].filter((x) => baseClassUris.has(x))) {
      if (classSig(baseModel, u) !== classSig(afterModel, u)) {
        diff.modified.push(u);
        issues.push({
          severity: "warning",
          code: "modified-term",
          message: `${localName(u)} (existing class) has its superclasses changed by this change.`,
          subject: u,
        });
      }
    }
  }
  const compareProps = (before: TBoxProperty[], after: TBoxProperty[], kind: string) => {
    const bMap = new Map(before.map((p) => [p.uri, p]));
    for (const ap of after) {
      const bp = bMap.get(ap.uri);
      if (bp && propSig(bp) !== propSig(ap)) {
        diff.modified.push(ap.uri);
        issues.push({
          severity: "warning",
          code: "modified-term",
          message: `${localName(ap.uri)} (existing ${kind}) has its domain/range changed by this change.`,
          subject: ap.uri,
        });
      }
    }
  };
  compareProps(baseModel.objectProps, afterModel.objectProps, "object property");
  compareProps(baseModel.dataProps, afterModel.dataProps, "data property");

  // ── 7. Reasoning: satisfiability and entailment changes ──
  let reasoning: ValidationReport["reasoning"];
  if (reason) {
    const before = reasonModules(baseModules);
    const after = reasonModules(afterModules);
    const baseTerms = new Set<string>([...baseClassUris, ...setOf(baseModel.objectProps), ...setOf(baseModel.dataProps)]);
    const ed = entailmentDiff(before.report, after.report, baseTerms, after.explainSubsumption);
    const newly = new Set(ed.newlyUnsat);
    for (const u of after.report.unsatisfiable) {
      issues.push({
        severity: newly.has(u.cls) ? "error" : "warning",
        code: "unsatisfiable-class",
        message: newly.has(u.cls)
          ? `${localName(u.cls)} can have no members after this change: ${u.reason}.`
          : `${localName(u.cls)} was already unsatisfiable in the base ontology: ${u.reason}.`,
        subject: u.cls,
        explanation: explanationLines(u.explanation),
      });
    }
    const MAX_SHOWN = 25;
    const shown = ed.unintended.filter((e) => !newly.has(e.args[0])).slice(0, MAX_SHOWN);
    for (const e of shown) {
      const [a, b] = e.args;
      const isAdded = ed.added.includes(e);
      const rel = e.kind === "subPropertyOf" ? "is a sub-property of" : "is a subclass of";
      if (!diff.modified.includes(a)) diff.modified.push(a);
      issues.push({
        severity: "warning",
        code: "entailment-changed",
        message: isAdded
          ? `${localName(a)} now ${rel} ${localName(b)} — both existed before, so this changes what the existing ontology means.`
          : `${localName(a)} no longer ${rel} ${localName(b)}.`,
        subject: a,
        ...(e.explanation?.length ? { explanation: explanationLines(e.explanation) } : {}),
      });
    }
    if (ed.unintended.length > shown.length) {
      issues.push({ severity: "info", code: "entailment-changed", message: `${ed.unintended.length - shown.length} more changed entailments between existing terms are not listed.` });
    }
    reasoning = {
      unsatisfiable: after.report.unsatisfiable.map((u) => u.cls),
      newlyUnsat: ed.newlyUnsat,
      added: ed.added.length,
      removed: ed.removed.length,
      unintended: ed.unintended.length,
      incomplete: after.report.incomplete,
    };
  }

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, issues, diff, ...(reasoning ? { reasoning } : {}) };
}
