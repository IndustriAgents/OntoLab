// In-process OWL 2 RL reasoning over the axioms of a T-Box (and, optionally, an
// A-Box). Forward chaining with one recorded justification per derived fact, so
// every clash, unsatisfiable class and inferred subsumption can be explained by
// the asserted axioms behind it. It is deliberately incomplete — no reasoning
// over the anonymous individuals that someValuesFrom/minCardinality imply, no
// unions or complements — and says so in `incomplete`; the DL sidecar
// (HermiT/ELK) is the authoritative tier when it is configured.

import { OWL, RDFS, XSD, localName } from "../iri";
import type { Axiom, Clash, ClashCode, Entailment, ReasonerReport, UnsatClass } from "./types";

const THING = OWL + "Thing";
const NOTHING = OWL + "Nothing";
const SEP = "\u0001";

export interface RLInput {
  axioms: Axiom[];
  /** unique-name assumption: distinct individual ids are distinct things (default true, matching the app) */
  una?: boolean;
  /** stop deriving after this many facts (default 200 000) */
  maxFacts?: number;
  /** cap on axioms per explanation (default 24) */
  explanationCap?: number;
}

export interface RLSession {
  report: ReasonerReport;
  /** the asserted axioms that make `sub` ⊑ `sup` hold (empty when it does not) */
  explainSubsumption(sub: string, sup: string): Axiom[];
  /** the asserted axioms that make individual `ind` a member of `cls` */
  explainType(ind: string, cls: string): Axiom[];
}

interface Edge {
  to: string;
  ax: string;
}
interface Restr {
  prop: string;
  kind: string;
  value: string;
  n: number | null;
  ax: string;
}
interface Reached {
  via: string;
  ax: string;
}

const isDatatype = (u: string) => u.startsWith(XSD) || u === RDFS + "Literal" || u === RDFS + "Datatype";
const ln = (u: string) => localName(u) || u;
/** "a Person", "an Organization" */
const an = (u: string) => `${/^[aeiou]/i.test(ln(u)) ? "an" : "a"} ${ln(u)}`;

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export function reasonRL(input: RLInput): ReasonerReport {
  return runRL(input).report;
}

export function runRL(input: RLInput): RLSession {
  const t0 = Date.now();
  const una = input.una ?? true;
  const maxFacts = input.maxFacts ?? 200_000;
  const cap = input.explanationCap ?? 24;
  const axById = new Map(input.axioms.map((a) => [a.id, a]));
  const incomplete: string[] = [
    "OWL 2 RL: individuals implied by someValuesFrom / minCardinality are not created, and unions, complements and nominals are not interpreted",
  ];
  if (!una) incomplete.push("Without the unique-name assumption, functional properties only suggest owl:sameAs; their consequences are not propagated");

  /* ───────────── T-Box indexes ───────────── */

  const classEdges = new Map<string, Edge[]>();
  const propEdges = new Map<string, Edge[]>();
  const domains = new Map<string, Edge[]>();
  const ranges = new Map<string, Edge[]>();
  const inverses = new Map<string, Edge[]>();
  const disjoint = new Map<string, Edge[]>();
  const propDisjoint = new Map<string, Edge[]>();
  const functional = new Map<string, string>();
  const chars = new Map<string, Map<string, string>>();
  const restrictions = new Map<string, Restr[]>();
  const classes = new Set<string>();
  const addClass = (c: string) => {
    if (c && !isDatatype(c)) classes.add(c);
  };

  // A-Box assertions
  const typeAx: Axiom[] = [];
  const linkAx: Axiom[] = [];
  const dataAx: Axiom[] = [];
  const sameAx: Axiom[] = [];
  const diffAx: Axiom[] = [];

  for (const a of input.axioms) {
    const [x, y, z, w, k] = a.args;
    switch (a.kind) {
      case "subClassOf":
        pushMap(classEdges, x, { to: y, ax: a.id });
        addClass(x);
        addClass(y);
        break;
      case "equivalentClass":
        pushMap(classEdges, x, { to: y, ax: a.id });
        pushMap(classEdges, y, { to: x, ax: a.id });
        addClass(x);
        addClass(y);
        break;
      case "disjointWith":
        pushMap(disjoint, x, { to: y, ax: a.id });
        pushMap(disjoint, y, { to: x, ax: a.id });
        addClass(x);
        addClass(y);
        break;
      case "domain":
        pushMap(domains, x, { to: y, ax: a.id });
        addClass(y);
        break;
      case "range":
        pushMap(ranges, x, { to: y, ax: a.id });
        addClass(y);
        break;
      case "subPropertyOf":
        pushMap(propEdges, x, { to: y, ax: a.id });
        break;
      case "equivalentProperty":
        pushMap(propEdges, x, { to: y, ax: a.id });
        pushMap(propEdges, y, { to: x, ax: a.id });
        break;
      case "inverseOf":
        pushMap(inverses, x, { to: y, ax: a.id });
        pushMap(inverses, y, { to: x, ax: a.id });
        break;
      case "propertyDisjointWith":
        pushMap(propDisjoint, x, { to: y, ax: a.id });
        pushMap(propDisjoint, y, { to: x, ax: a.id });
        break;
      case "functional":
        functional.set(x, a.id);
        break;
      case "characteristic": {
        const m = chars.get(x) ?? new Map<string, string>();
        m.set(y, a.id);
        chars.set(x, m);
        break;
      }
      case "restriction": {
        const n = k ? Number(k) : null;
        pushMap(restrictions, x, { prop: y, kind: z, value: w || "", n: n != null && Number.isFinite(n) ? n : null, ax: a.id });
        addClass(x);
        if (w) addClass(w);
        break;
      }
      case "type":
        typeAx.push(a);
        addClass(y);
        break;
      case "link":
        linkAx.push(a);
        break;
      case "data":
        dataAx.push(a);
        break;
      case "sameAs":
        sameAx.push(a);
        break;
      case "differentFrom":
        diffAx.push(a);
        break;
    }
  }
  classes.delete(THING);

  /* ───────────── subsumption closure (BFS, one justification per pair) ───────────── */

  const closure = (edges: Map<string, Edge[]>) => {
    const memo = new Map<string, Map<string, Reached>>();
    return (start: string): Map<string, Reached> => {
      const hit = memo.get(start);
      if (hit) return hit;
      const seen = new Map<string, Reached>([[start, { via: "", ax: "" }]]);
      const queue = [start];
      for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        for (const e of edges.get(cur) ?? []) {
          if (seen.has(e.to)) continue;
          seen.set(e.to, { via: cur, ax: e.ax });
          queue.push(e.to);
        }
      }
      memo.set(start, seen);
      return seen;
    };
  };
  const anc = closure(classEdges);
  const panc = closure(propEdges);
  const pathAx = (reach: Map<string, Reached>, start: string, target: string): string[] => {
    const out: string[] = [];
    let cur = target;
    while (cur !== start) {
      const r = reach.get(cur);
      if (!r) return [];
      out.push(r.ax);
      cur = r.via;
    }
    return out.reverse();
  };
  const subPath = (c: string, d: string) => pathAx(anc(c), c, d);
  const propPath = (p: string, q: string) => pathAx(panc(p), p, q);

  const toAxioms = (ids: Iterable<string>): Axiom[] => {
    const out: Axiom[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const a = axById.get(id);
      if (a) out.push(a);
      if (out.length >= cap) break;
    }
    return out;
  };

  /* ───────────── unsatisfiable classes (fixpoint) ───────────── */

  const unsat = new Map<string, { reason: string; ax: string[] }>();

  /** Axiom ids proving v ⊓ w ⊑ ⊥, or null. */
  const disjointWitness = (v: string, w: string): string[] | null => {
    if (!v || !w || isDatatype(v) || isDatatype(w) || v === THING || w === THING) return null;
    const uv = unsat.get(v);
    if (uv) return uv.ax;
    const uw = unsat.get(w);
    if (uw) return uw.ax;
    const av = anc(v);
    const aw = anc(w);
    for (const a of av.keys()) {
      for (const d of disjoint.get(a) ?? []) {
        if (aw.has(d.to)) return [...subPath(v, a), d.ax, ...subPath(w, d.to)];
      }
    }
    return null;
  };

  const checkClass = (c: string): { reason: string; ax: string[] } | null => {
    const ac = anc(c);
    if (ac.has(NOTHING)) return { reason: `${ln(c)} is a subclass of owl:Nothing`, ax: subPath(c, NOTHING) };
    for (const a of ac.keys()) {
      if (a !== c && unsat.has(a)) return { reason: `${ln(c)} is a subclass of the unsatisfiable class ${ln(a)}`, ax: [...subPath(c, a), ...unsat.get(a)!.ax] };
      for (const d of disjoint.get(a) ?? []) {
        if (ac.has(d.to)) {
          return {
            reason: `${ln(c)} falls under both ${ln(a)} and ${ln(d.to)}, which are disjoint`,
            ax: [...subPath(c, a), d.ax, ...subPath(c, d.to)],
          };
        }
      }
    }
    // restrictions inherited from every superclass
    const rs: (Restr & { path: string[] })[] = [];
    for (const a of ac.keys()) for (const r of restrictions.get(a) ?? []) rs.push({ ...r, path: subPath(c, a) });
    const existentials = rs.filter(
      (r) => r.kind === "someValuesFrom" || ((r.kind === "minCardinality" || r.kind === "cardinality") && (r.n ?? 0) >= 1),
    );
    for (const e of existentials) {
      const v = e.value || THING;
      const need = e.kind === "someValuesFrom" ? 1 : e.n ?? 1;
      const base = [...e.path, e.ax];
      const uv = unsat.get(v);
      if (uv) return { reason: `${ln(c)} needs ${an(e.prop)} value of the unsatisfiable class ${ln(v)}`, ax: [...base, ...uv.ax] };
      const supers = panc(e.prop);
      for (const r of rs) {
        if (!supers.has(r.prop)) continue;
        const via = [...base, ...propPath(e.prop, r.prop), ...r.path, r.ax];
        if ((r.kind === "maxCardinality" || r.kind === "cardinality") && r.n != null && r.n < need) {
          const qualifies = !r.value || r.value === THING || anc(v).has(r.value);
          if (qualifies) return { reason: `${ln(c)} needs at least ${need} ${ln(e.prop)} value(s) but allows at most ${r.n}`, ax: via };
        }
        if (r.kind === "allValuesFrom" && r.value) {
          const w = disjointWitness(v, r.value);
          if (w) return { reason: `${ln(c)} needs ${an(e.prop)} value that is ${an(v)}, but only allows ${ln(r.value)}`, ax: [...via, ...w] };
        }
      }
      for (const q of supers.keys()) {
        for (const rg of ranges.get(q) ?? []) {
          const w = disjointWitness(v, rg.to);
          if (w) {
            return {
              reason: `${ln(c)} needs ${an(e.prop)} value that is ${an(v)}, but the range of ${ln(q)} is the disjoint class ${ln(rg.to)}`,
              ax: [...base, ...propPath(e.prop, q), rg.ax, ...w],
            };
          }
        }
        for (const dm of domains.get(q) ?? []) {
          const w = disjointWitness(c, dm.to);
          if (w) {
            return {
              reason: `${ln(c)} must have ${an(e.prop)} value, which makes it ${an(dm.to)} (domain of ${ln(q)}), and the two are disjoint`,
              ax: [...base, ...propPath(e.prop, q), dm.ax, ...w],
            };
          }
        }
      }
    }
    // min n > max m on the same property and filler
    for (const lo of rs) {
      if (lo.kind !== "minCardinality" && lo.kind !== "cardinality") continue;
      for (const hi of rs) {
        if (hi === lo || (hi.kind !== "maxCardinality" && hi.kind !== "cardinality")) continue;
        if (hi.prop !== lo.prop || (hi.value || "") !== (lo.value || "") || lo.n == null || hi.n == null || lo.n <= hi.n) continue;
        return { reason: `${ln(c)} needs at least ${lo.n} but at most ${hi.n} ${ln(lo.prop)} values`, ax: [...lo.path, lo.ax, ...hi.path, hi.ax] };
      }
    }
    return null;
  };

  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const c of classes) {
      if (c === NOTHING || unsat.has(c)) continue;
      const hit = checkClass(c);
      if (hit) {
        unsat.set(c, hit);
        changed = true;
      }
    }
    if (!changed) break;
  }

  /* ───────────── A-Box: identity ───────────── */

  const individuals = new Set<string>();
  for (const a of typeAx) individuals.add(a.args[0]);
  for (const a of linkAx) {
    individuals.add(a.args[0]);
    individuals.add(a.args[2]);
  }
  for (const a of dataAx) individuals.add(a.args[0]);
  for (const a of [...sameAx, ...diffAx]) individuals.add(a.args[0]);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let cur = x;
    while (cur !== r) {
      const next = parent.get(cur) ?? r;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const sameWhy = new Map<string, string[]>(); // representative -> sameAs axiom ids
  const union = (a: string, b: string, why: string[]) => {
    const ra = find(a);
    const rb = find(b);
    const reasons = [...(sameWhy.get(ra) ?? []), ...(sameWhy.get(rb) ?? []), ...why];
    if (ra === rb) {
      sameWhy.set(ra, reasons);
      return;
    }
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    sameWhy.set(keep, reasons);
    sameWhy.delete(drop);
  };
  // owl:sameAs between individuals, or two individuals pointing at the same external IRI
  const byExternal = new Map<string, Axiom>();
  for (const a of sameAx) {
    const [x, y] = a.args;
    if (individuals.has(y)) union(x, y, [a.id]);
    else {
      const prev = byExternal.get(y);
      if (prev) union(prev.args[0], x, [prev.id, a.id]);
      else byExternal.set(y, a);
    }
  }
  const rep = (x: string) => find(x);
  const repWhy = (x: string) => sameWhy.get(rep(x)) ?? [];

  /* ───────────── A-Box: forward chaining ───────────── */

  const just = new Map<string, string[]>(); // fact key -> premises (axiom ids or fact keys)
  const types = new Map<string, Set<string>>();
  const out = new Map<string, Map<string, Set<string>>>(); // x -> p -> ys
  const inn = new Map<string, Map<string, Set<string>>>(); // y -> p -> xs
  const asserted = new Set<string>();
  const clashes: Clash[] = [];
  const clashSeen = new Set<string>();
  let facts = 0;
  let capped = false;
  const queue: { t: "T" | "L"; a: string; b: string; c?: string }[] = [];

  const tKey = (x: string, c: string) => `T${SEP}${x}${SEP}${c}`;
  const lKey = (x: string, p: string, y: string) => `L${SEP}${x}${SEP}${p}${SEP}${y}`;
  const linksOf = (x: string, p: string) => out.get(x)?.get(p) ?? new Set<string>();
  const linksInto = (y: string, p: string) => inn.get(y)?.get(p) ?? new Set<string>();

  const addType = (x: string, c: string, why: string[]) => {
    if (capped || !c) return;
    const set = types.get(x) ?? new Set<string>();
    if (set.has(c)) return;
    set.add(c);
    types.set(x, set);
    just.set(tKey(x, c), why);
    if (++facts > maxFacts) capped = true;
    queue.push({ t: "T", a: x, b: c });
  };
  const addLink = (x: string, p: string, y: string, why: string[]) => {
    if (capped) return;
    const key = lKey(x, p, y);
    if (just.has(key)) return;
    just.set(key, why);
    const om = out.get(x) ?? new Map<string, Set<string>>();
    const os = om.get(p) ?? new Set<string>();
    os.add(y);
    om.set(p, os);
    out.set(x, om);
    const im = inn.get(y) ?? new Map<string, Set<string>>();
    const is = im.get(p) ?? new Set<string>();
    is.add(x);
    im.set(p, is);
    inn.set(y, im);
    if (++facts > maxFacts) capped = true;
    queue.push({ t: "L", a: x, b: p, c: y });
  };

  /** Expand premises down to asserted axiom ids. */
  const explainKeys = (keys: string[]): string[] => {
    const outIds: string[] = [];
    const seen = new Set<string>();
    const stack = [...keys].reverse();
    while (stack.length && outIds.length < cap * 4) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!k.includes(SEP)) {
        outIds.push(k);
        continue;
      }
      const prem = just.get(k);
      if (prem) for (let i = prem.length - 1; i >= 0; i--) stack.push(prem[i]);
    }
    return outIds;
  };

  const clash = (code: ClashCode, dedupe: string, message: string, subjects: string[], premises: string[]) => {
    if (clashSeen.has(dedupe)) return;
    clashSeen.add(dedupe);
    clashes.push({ code, message, subjects, explanation: toAxioms(explainKeys(premises)) });
  };

  for (const a of typeAx) {
    const x = rep(a.args[0]);
    asserted.add(tKey(x, a.args[1]));
    addType(x, a.args[1], [a.id, ...repWhy(a.args[0])]);
  }
  for (const a of linkAx) {
    const x = rep(a.args[0]);
    const y = rep(a.args[2]);
    asserted.add(lKey(x, a.args[1], y));
    addLink(x, a.args[1], y, [a.id, ...repWhy(a.args[0]), ...repWhy(a.args[2])]);
  }
  // data values: inherit through super-properties; domains type the subject
  const dataVals = new Map<string, Map<string, { value: string; dt: string; why: string[] }[]>>();
  for (const a of dataAx) {
    const [x0, p, value, dt] = a.args;
    const x = rep(x0);
    const supers = panc(p);
    for (const q of supers.keys()) {
      const why = [a.id, ...propPath(p, q), ...repWhy(x0)];
      const m = dataVals.get(x) ?? new Map();
      const arr = m.get(q) ?? [];
      arr.push({ value, dt: dt ?? "", why });
      m.set(q, arr);
      dataVals.set(x, m);
      for (const d of domains.get(q) ?? []) addType(x, d.to, [...why, d.ax]);
    }
  }

  for (let i = 0; i < queue.length && !capped; i++) {
    const f = queue[i];
    if (f.t === "T") {
      const x = f.a;
      const c = f.b;
      const key = tKey(x, c);
      for (const e of classEdges.get(c) ?? []) addType(x, e.to, [key, e.ax]);
      for (const r of restrictions.get(c) ?? []) {
        if (r.kind !== "allValuesFrom" || !r.value || isDatatype(r.value)) continue;
        for (const y of linksOf(x, r.prop)) addType(y, r.value, [key, r.ax, lKey(x, r.prop, y)]);
      }
      const u = unsat.get(c);
      if (u) clash("unsat-type", `U${SEP}${x}`, `${x} is ${an(c)}, a class that can have no members (${u.reason})`, [x], [key, ...u.ax]);
      const xs = types.get(x)!;
      for (const d of disjoint.get(c) ?? []) {
        if (!xs.has(d.to)) continue;
        const pair = [c, d.to].sort().join(SEP);
        clash("disjoint-types", `D${SEP}${x}${SEP}${pair}`, `${x} is both ${an(c)} and ${an(d.to)}, which are disjoint`, [x], [key, tKey(x, d.to), d.ax]);
      }
    } else {
      const x = f.a;
      const p = f.b;
      const y = f.c!;
      const key = lKey(x, p, y);
      for (const e of propEdges.get(p) ?? []) addLink(x, e.to, y, [key, e.ax]);
      for (const d of domains.get(p) ?? []) addType(x, d.to, [key, d.ax]);
      for (const r of ranges.get(p) ?? []) addType(y, r.to, [key, r.ax]);
      for (const inv of inverses.get(p) ?? []) addLink(y, inv.to, x, [key, inv.ax]);
      const pc = chars.get(p);
      if (pc?.has("symmetric")) addLink(y, p, x, [key, pc.get("symmetric")!]);
      if (pc?.has("transitive")) {
        const tax = pc.get("transitive")!;
        for (const z of [...linksOf(y, p)]) addLink(x, p, z, [key, lKey(y, p, z), tax]);
        for (const w of [...linksInto(x, p)]) addLink(w, p, y, [lKey(w, p, x), key, tax]);
      }
      for (const c of types.get(x) ?? []) {
        for (const r of restrictions.get(c) ?? []) {
          if (r.kind === "allValuesFrom" && r.prop === p && r.value && !isDatatype(r.value)) addType(y, r.value, [key, tKey(x, c), r.ax]);
        }
      }
      if (pc?.has("irreflexive") && x === y) clash("irreflexive", `I${SEP}${key}`, `${x} ${ln(p)} itself, but ${ln(p)} is irreflexive`, [x], [key, pc.get("irreflexive")!]);
      if (pc?.has("asymmetric") && linksOf(y, p).has(x)) {
        const pair = [x, y].sort().join(SEP);
        clash("asymmetric", `A${SEP}${p}${SEP}${pair}`, `${x} and ${y} are linked by ${ln(p)} in both directions, but it is asymmetric`, [x, y], [key, lKey(y, p, x), pc.get("asymmetric")!]);
      }
      for (const q of propDisjoint.get(p) ?? []) {
        if (!linksOf(x, q.to).has(y)) continue;
        const pair = [p, q.to].sort().join(SEP);
        clash("disjoint-properties", `P${SEP}${x}${SEP}${y}${SEP}${pair}`, `${x} is linked to ${y} by both ${ln(p)} and ${ln(q.to)}, which are disjoint`, [x, y], [key, lKey(x, q.to, y), q.ax]);
      }
    }
  }
  if (capped) incomplete.push(`Stopped after ${maxFacts} derived facts; later consequences were not computed`);

  /* ───────────── cardinality-style checks on the closed fact set ───────────── */

  const suggestedSame: string[][] = [];
  for (const [p, fax] of functional) {
    for (const [x, m] of out) {
      const ys = [...(m.get(p) ?? [])];
      if (ys.length < 2) continue;
      if (una) {
        clash("functional-clash", `F${SEP}${x}${SEP}${p}`, `${x} has ${ys.length} different ${ln(p)} values (${ys.slice(0, 4).join(", ")}), but ${ln(p)} is functional`, [x, ...ys], [
          ...ys.map((y) => lKey(x, p, y)),
          fax,
        ]);
      } else suggestedSame.push(ys);
    }
    for (const [x, m] of dataVals) {
      const vals = m.get(p) ?? [];
      const distinct = new Map<string, (typeof vals)[number]>();
      for (const v of vals) distinct.set(normValue(v.value), v);
      if (distinct.size < 2) continue;
      const shown = [...distinct.values()].slice(0, 4).map((v) => `"${v.value}"`);
      clash("functional-clash", `F${SEP}${x}${SEP}${p}`, `${x} has ${distinct.size} different ${ln(p)} values (${shown.join(", ")}), but ${ln(p)} is functional`, [x], [
        ...[...distinct.values()].flatMap((v) => v.why),
        fax,
      ]);
    }
  }
  for (const [p, pc] of chars) {
    const iax = pc.get("inverseFunctional");
    if (!iax) continue;
    for (const [y, m] of inn) {
      const xs = [...(m.get(p) ?? [])];
      if (xs.length < 2) continue;
      if (una) {
        clash("inverse-functional-clash", `IF${SEP}${y}${SEP}${p}`, `${xs.length} different individuals (${xs.slice(0, 4).join(", ")}) have ${ln(p)} ${y}, but ${ln(p)} is inverse-functional`, [y, ...xs], [
          ...xs.map((x) => lKey(x, p, y)),
          iax,
        ]);
      } else suggestedSame.push(xs);
    }
  }
  if (una) {
    for (const [x, xs] of types) {
      for (const c of xs) {
        for (const r of restrictions.get(c) ?? []) {
          if ((r.kind !== "maxCardinality" && r.kind !== "cardinality") || r.n == null) continue;
          const objTargets = [...linksOf(x, r.prop)].filter((y) => !r.value || r.value === THING || types.get(y)?.has(r.value));
          const dataTargets = r.value && !isDatatype(r.value) ? [] : [...new Set((dataVals.get(x)?.get(r.prop) ?? []).map((v) => normValue(v.value)))];
          const count = objTargets.length + dataTargets.length;
          if (count <= r.n) continue;
          clash("max-card", `M${SEP}${x}${SEP}${r.ax}`, `${x} has ${count} ${ln(r.prop)} values, but a ${ln(c)} may have at most ${r.n}`, [x, ...objTargets], [
            tKey(x, c),
            r.ax,
            ...objTargets.map((y) => lKey(x, r.prop, y)),
          ]);
        }
      }
    }
  }
  for (const a of diffAx) {
    const [x, y] = a.args;
    if (rep(x) !== rep(y)) continue;
    clash("different-same", `S${SEP}${[x, y].sort().join(SEP)}`, `${x} and ${y} are said to be different, but are also the same individual`, [x, y], [a.id, ...repWhy(x)]);
  }

  /* ───────────── report ───────────── */

  const subsumptions: Entailment[] = [];
  const named = (c: string) => c !== THING && c !== NOTHING && !c.startsWith(OWL) && !c.startsWith(RDFS) && !isDatatype(c);
  for (const c of [...classes].sort()) {
    if (!named(c)) continue;
    for (const d of anc(c).keys()) if (d !== c && named(d)) subsumptions.push({ kind: "subClassOf", args: [c, d] });
  }
  const props = new Set<string>([...propEdges.keys(), ...domains.keys(), ...ranges.keys(), ...functional.keys(), ...chars.keys()]);
  const propertySubsumptions: Entailment[] = [];
  for (const p of [...props].sort()) for (const q of panc(p).keys()) if (q !== p) propertySubsumptions.push({ kind: "subPropertyOf", args: [p, q] });

  const inferredTypes: Record<string, string[]> = {};
  for (const [x, xs] of types) {
    const extra = [...xs].filter((c) => c !== THING && !asserted.has(tKey(x, c))).sort();
    if (extra.length) inferredTypes[x] = extra;
  }
  const inferredLinks: Entailment[] = [];
  for (const [x, m] of out) {
    for (const [p, ys] of m) {
      for (const y of ys) {
        if (asserted.has(lKey(x, p, y))) continue;
        inferredLinks.push({ kind: "link", args: [x, p, y] });
        if (inferredLinks.length >= 2000) break;
      }
    }
  }

  const clusters = new Map<string, Set<string>>();
  for (const x of individuals) {
    const r = rep(x);
    if (r === x && !parent.has(x)) continue;
    const s = clusters.get(r) ?? new Set<string>([r]);
    s.add(x);
    clusters.set(r, s);
  }
  const sameAs = [...[...clusters.values()].filter((s) => s.size > 1).map((s) => [...s].sort()), ...suggestedSame.map((g) => [...new Set(g)].sort())];

  const unsatisfiable: UnsatClass[] = [...unsat.entries()]
    .filter(([c]) => c !== NOTHING)
    .map(([cls, u]) => ({ cls, reason: u.reason, explanation: toAxioms(u.ax) }))
    .sort((a, b) => a.cls.localeCompare(b.cls));

  const report: ReasonerReport = {
    tier: "rl",
    reasoner: "ontolab-rl",
    consistent: clashes.length === 0,
    clashes,
    unsatisfiable,
    subsumptions,
    propertySubsumptions,
    inferredTypes,
    inferredLinks,
    sameAs,
    incomplete,
    stats: { axioms: input.axioms.length, facts, ms: Date.now() - t0 },
  };

  return {
    report,
    explainSubsumption: (sub, sup) => (anc(sub).has(sup) ? toAxioms(subPath(sub, sup)) : []),
    explainType: (ind, cls) => {
      const key = tKey(rep(ind), cls);
      return just.has(key) ? toAxioms(explainKeys([key])) : [];
    },
  };
}

/** Literal identity for functional checks: numbers compare by value, text by trimmed form. */
function normValue(v: string): string {
  const t = v.trim();
  if (t !== "" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return String(Number(t));
  return t;
}
