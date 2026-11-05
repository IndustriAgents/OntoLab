// Ontology pitfall scanner (A4). Checks a T-Box draft for the modelling
// mistakes catalogued by OOPS! (Poveda-Villalón et al.) plus the ones LLMs make
// most (Lisena et al., LLMs4KGOE 2026): instances modelled as classes, string
// attributes that should be links, near-duplicate classes. Pure and shared by
// the server (induction, repair loop, eval harness) and the browser.
//
// Severity follows OOPS!: critical (breaks reasoning or extraction), important
// (degrades it), minor (hygiene). Every finding carries a one-line fix that the
// repair prompt hands back to the model.

import { Parser } from "n3";
import type { TBoxModel } from "../../types/tbox";
import { RDFS, localName, isStandardTerm } from "./iri";
import { childrenMap } from "./hierarchy";

export type PitfallSeverity = "critical" | "important" | "minor";

export interface Pitfall {
  /** OOPS! code where one exists (P02, P04 …); OL-* for LLM-specific checks */
  code: string;
  title: string;
  severity: PitfallSeverity;
  /** the term the finding is about */
  subject: string;
  message: string;
  /** what to change, phrased as an instruction for the repair prompt */
  fix: string;
}

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/** Singular-ish normal form for comparing names: "Pumps" ≈ "Pump", "Agreements" ≈ "agreement". */
function normName(s: string): string {
  return words(s)
    .split(/\s+/)
    .map((w) => (w.length > 3 ? w.replace(/(ies)$/, "y").replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, "") : w))
    .join(" ");
}

const nameOf = (uri: string, label?: string) => label || words(localName(uri));

/** rdfs:domain / rdfs:range axioms per property, counted from the raw Turtle (OWL reads several as an intersection). */
function axiomCounts(modules: { turtle: string }[]): Map<string, { domain: number; range: number }> {
  const out = new Map<string, { domain: number; range: number }>();
  for (const m of modules) {
    let quads;
    try {
      quads = new Parser().parse(m.turtle);
    } catch {
      continue;
    }
    for (const q of quads) {
      const p = q.predicate.value;
      if (p !== RDFS + "domain" && p !== RDFS + "range") continue;
      if (q.subject.termType !== "NamedNode") continue;
      const c = out.get(q.subject.value) ?? { domain: 0, range: 0 };
      if (p === RDFS + "domain") c.domain++;
      else c.range++;
      out.set(q.subject.value, c);
    }
  }
  return out;
}

function ancestors(tbox: TBoxModel, cls: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(tbox.subClassOf[cls] ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(tbox.subClassOf[c] ?? []));
  }
  return seen;
}

export interface PitfallOptions {
  /** raw modules, for checks the merged model cannot see (several domain axioms) */
  modules?: { turtle: string }[];
}

export function scanPitfalls(tbox: TBoxModel, opts: PitfallOptions = {}): Pitfall[] {
  const out: Pitfall[] = [];
  const own = (uri: string) => !isStandardTerm(uri);
  const classes = tbox.classes.filter((c) => own(c.uri));
  const classByUri = new Map(classes.map((c) => [c.uri, c]));
  const props = [...tbox.objectProps, ...tbox.dataProps].filter((p) => own(p.uri));
  const add = (p: Pitfall) => out.push(p);

  // P06 — cycles in the class hierarchy (critical: every subclass inference loops)
  for (const c of classes) {
    if (ancestors(tbox, c.uri).has(c.uri)) {
      add({ code: "P06", title: "Cycle in the class hierarchy", severity: "critical", subject: c.uri, message: `${nameOf(c.uri, c.label)} is (indirectly) a subclass of itself.`, fix: `Remove one rdfs:subClassOf link so ${localName(c.uri)} is not its own ancestor.` });
    }
  }

  // P19 — several rdfs:domain / rdfs:range axioms (OWL intersects them, which is rarely meant)
  const counts = axiomCounts(opts.modules ?? []);
  for (const p of props) {
    const c = counts.get(p.uri);
    if (!c) continue;
    for (const which of ["domain", "range"] as const) {
      if (c[which] > 1) {
        add({
          code: "P19",
          title: `Multiple ${which} axioms`,
          severity: "critical",
          subject: p.uri,
          message: `${localName(p.uri)} has ${c[which]} separate rdfs:${which} statements; OWL reads them as an intersection, so only things that are ALL of those classes qualify.`,
          fix: `Give ${localName(p.uri)} one ${which}: a common superclass, or an owl:unionOf if any of them is meant.`,
        });
      }
    }
  }

  // OL-TYPE — the same IRI used as a class and as a property
  const propUris = new Set(props.map((p) => p.uri));
  for (const c of classes) {
    if (propUris.has(c.uri)) add({ code: "OL-TYPE", title: "Term is both a class and a property", severity: "critical", subject: c.uri, message: `${localName(c.uri)} is declared as a class and as a property.`, fix: `Use separate names for the class and the property (e.g. ${localName(c.uri)} and has${localName(c.uri)}).` });
  }

  // P11 — missing domain or range
  for (const p of props) {
    const missing = [!p.domain.length ? "domain" : "", !p.range.length ? "range" : ""].filter(Boolean);
    if (missing.length) {
      add({
        code: "P11",
        title: "Missing domain or range",
        severity: "important",
        subject: p.uri,
        message: `${localName(p.uri)} has no ${missing.join(" or ")}, so extraction cannot tell what it may connect.`,
        fix: `Add rdfs:${missing.join(" and rdfs:")} to ${localName(p.uri)}${p.kind === "data" && !p.range.length ? " (an xsd datatype)" : ""}.`,
      });
    }
  }

  // P02/P30 — synonyms modelled as separate classes
  const byNorm = new Map<string, string[]>();
  for (const c of classes) {
    for (const key of new Set([normName(localName(c.uri)), c.label ? normName(c.label) : ""])) {
      if (!key) continue;
      byNorm.set(key, [...(byNorm.get(key) ?? []), c.uri]);
    }
  }
  const reported = new Set<string>();
  for (const [, uris] of byNorm) {
    const distinct = [...new Set(uris)];
    if (distinct.length < 2) continue;
    const key = distinct.sort().join("|");
    if (reported.has(key)) continue;
    reported.add(key);
    add({
      code: "P02",
      title: "Synonym classes",
      severity: "important",
      subject: distinct[0],
      message: `${distinct.map((u) => localName(u)).join(", ")} name the same idea; individuals will be split between them.`,
      fix: `Keep one of ${distinct.map((u) => localName(u)).join(" / ")} and remove the others (or declare owl:equivalentClass if both must stay).`,
    });
  }

  // P10 — siblings with no disjointness at all
  const kids = childrenMap(tbox);
  for (const [parent, children] of kids) {
    const own = children.filter((c) => classByUri.has(c));
    if (own.length < 2) continue;
    const anyDisjoint = own.some((c) => (classByUri.get(c)?.disjointWith ?? []).some((d) => own.includes(d)));
    if (!anyDisjoint) {
      add({
        code: "P10",
        title: "Missing disjointness",
        severity: "important",
        subject: parent,
        message: `The subclasses of ${localName(parent)} (${own.map(localName).slice(0, 6).join(", ")}${own.length > 6 ? ", …" : ""}) are not declared disjoint, so an individual typed as two of them is never flagged.`,
        fix: `Declare owl:disjointWith between the subclasses of ${localName(parent)} that cannot overlap.`,
      });
    }
  }

  // OL-INST — an instance modelled as a class (LLM-specific: "Pump P-101", "ISO 9001", "Acme Corp")
  for (const c of classes) {
    const n = c.label ?? localName(c.uri);
    const looksLikeInstance = /\d{2,}/.test(n) || /\b(Inc|Ltd|GmbH|LLC|Corp|AG|plc)\b\.?$/i.test(n) || /^[A-Z]{1,4}-?\d+/.test(localName(c.uri));
    if (looksLikeInstance && !(kids.get(c.uri)?.length)) {
      add({ code: "OL-INST", title: "Instance modelled as a class", severity: "important", subject: c.uri, message: `${n} looks like a specific thing (a name or code), not a kind of thing.`, fix: `Remove class ${localName(c.uri)}; extract it as an individual of a more general class instead.` });
    }
  }

  // OL-ATTR — a string attribute that names an existing class (should be a link)
  const classNames = new Map(classes.map((c) => [normName(localName(c.uri)), c.uri]));
  for (const p of tbox.dataProps.filter((x) => own(x.uri))) {
    // "hasManufacturer" names a class; "agreementId" or "manufacturerName" is a
    // legitimate attribute, so suffixes are not stripped. A property about its
    // own domain class is never flagged.
    const stem = normName(localName(p.uri).replace(/^(has|is|with)(?=[A-Z])/, ""));
    const named = classNames.get(stem);
    const target = named && !p.domain.includes(named) ? named : undefined;
    const textual = !p.range.length || p.range.some((r) => /#(string|anyURI)$/.test(r) || r === RDFS + "Literal");
    if (target && textual) {
      add({
        code: "OL-ATTR",
        title: "Attribute should be a relation",
        severity: "important",
        subject: p.uri,
        message: `${localName(p.uri)} stores a text value although ${localName(target)} is a class — the link between the two individuals is lost.`,
        fix: `Replace data property ${localName(p.uri)} with an object property whose range is ${localName(target)}.`,
      });
    }
  }

  // P04 — unconnected classes
  const used = new Set<string>();
  for (const p of props) for (const u of [...p.domain, ...p.range]) used.add(u);
  for (const [child, parents] of Object.entries(tbox.subClassOf)) {
    used.add(child);
    for (const p of parents) used.add(p);
  }
  for (const r of tbox.restrictions ?? []) {
    used.add(r.onClass);
    if (r.value) used.add(r.value);
  }
  for (const c of classes) {
    if (!used.has(c.uri)) add({ code: "P04", title: "Unconnected class", severity: "minor", subject: c.uri, message: `${nameOf(c.uri, c.label)} has no superclass, subclass or property using it.`, fix: `Place ${localName(c.uri)} in the hierarchy or use it as a domain/range — or remove it if it is not needed.` });
  }

  // Redundant subClassOf: a direct parent that is also an ancestor via another parent
  for (const c of classes) {
    const parents = tbox.subClassOf[c.uri] ?? [];
    for (const p of parents) {
      if (parents.some((q) => q !== p && ancestors(tbox, q).has(p))) {
        add({ code: "P-RED", title: "Redundant subclass link", severity: "minor", subject: c.uri, message: `${localName(c.uri)} is declared a subclass of ${localName(p)}, which it already is through another parent.`, fix: `Remove the direct rdfs:subClassOf ${localName(p)} from ${localName(c.uri)}.` });
      }
    }
  }

  // P13 — inverse-looking pairs with no owl:inverseOf
  const objByName = new Map(tbox.objectProps.filter((p) => own(p.uri)).map((p) => [localName(p.uri), p]));
  const pairs: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^has(.+)$/, (m) => `${m[1][0].toLowerCase()}${m[1].slice(1)}Of`],
    [/^has(.+)$/, (m) => `is${m[1]}Of`],
  ];
  for (const [name, p] of objByName) {
    for (const [re, inv] of pairs) {
      const m = name.match(re);
      const other = m ? objByName.get(inv(m)) : undefined;
      if (other && p.inverseOf !== other.uri && other.inverseOf !== p.uri) {
        add({ code: "P13", title: "Inverse not declared", severity: "minor", subject: p.uri, message: `${name} and ${localName(other.uri)} look like inverses but are not declared so.`, fix: `Declare ${localName(other.uri)} owl:inverseOf ${name}.` });
      }
    }
  }

  // P08 — missing annotations
  const unlabeled = [...classes, ...props].filter((t) => !t.label || !t.comment);
  if (unlabeled.length) {
    add({
      code: "P08",
      title: "Missing labels or definitions",
      severity: "minor",
      subject: unlabeled[0].uri,
      message: `${unlabeled.length} term${unlabeled.length === 1 ? "" : "s"} lack an rdfs:label or rdfs:comment (${unlabeled.slice(0, 5).map((t) => localName(t.uri)).join(", ")}${unlabeled.length > 5 ? ", …" : ""}). Definitions drive schema retrieval and extraction quality.`,
      fix: `Add an English rdfs:label and a one-sentence rdfs:comment to every term.`,
    });
  }

  const rank: Record<PitfallSeverity, number> = { critical: 0, important: 1, minor: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function pitfallCounts(list: Pitfall[]): Record<PitfallSeverity, number> {
  return {
    critical: list.filter((p) => p.severity === "critical").length,
    important: list.filter((p) => p.severity === "important").length,
    minor: list.filter((p) => p.severity === "minor").length,
  };
}

/** The repair instruction handed to the model (T-Box refine mode). */
export function repairInstruction(list: Pitfall[], max = 25): string {
  const relevant = list.filter((p) => p.severity !== "minor" || p.code === "P11").slice(0, max);
  if (!relevant.length) return "";
  return [
    "Repair these modelling problems found by an automated pitfall scan, changing nothing else:",
    ...relevant.map((p, i) => `${i + 1}. [${p.code} ${p.severity}] ${p.message} Fix: ${p.fix}`),
  ].join("\n");
}
