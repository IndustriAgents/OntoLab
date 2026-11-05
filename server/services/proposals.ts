// The improvement loop (A7). Extraction keeps what the ontology could not
// express — terms the model proposed (EDC's Define step) and terms it used that
// do not exist — instead of dropping them. After a run they are grouped by
// meaning (EDC's Canonicalize step: one idea, several names), counted and
// shown with example quotes; accepting a proposal turns it into T-Box
// additions in a new revision.

import type { RevisionContent, TermProposal, UnmatchedTerm } from "../../src/types/project.ts";
import type { ABoxIndividual, ABoxResult, EvidenceRef, FactReview, PendingFact } from "../../src/types/abox.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import type { OntoModule } from "../../src/types/validation.ts";
import { DataFactory, Writer, type Quad } from "n3";
import { localName, namespaceOf, SKOS } from "../../src/lib/ontology/iri.ts";
import { serializeTBoxStructured, toTermLocalName, type RawTBox } from "../../src/lib/ontology/tboxSerializer.ts";
import { cosine, type Embedder } from "../ml/embeddings.ts";
import { newId } from "./context.ts";

const norm = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/(ies)\b/g, "y")
    .replace(/s\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const SAME_MEANING = 0.86;

/** Group unmatched terms (from every checkpoint of a run) into proposals. */
export async function groupProposals(terms: (UnmatchedTerm & { documentId?: string })[], tbox: TBoxModel, embedder: Embedder | null): Promise<TermProposal[]> {
  const existing = new Set([...tbox.classes, ...tbox.objectProps, ...tbox.dataProps].map((t) => norm(localName(t.uri))));
  const usable = terms.filter((t) => t.name && !existing.has(norm(t.name)));
  if (!usable.length) return [];

  const vecs = embedder ? await embedder.embed(usable.map((t) => `${t.kind}: ${t.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}. ${t.definition}`)) : null;
  const groups: { members: number[]; centroid?: Float32Array }[] = [];
  usable.forEach((t, i) => {
    const g = groups.find((gr) => {
      const head = usable[gr.members[0]];
      if (head.kind !== t.kind) return false;
      if (norm(head.name) === norm(t.name)) return true;
      return !!vecs && !!gr.centroid && cosine(gr.centroid, vecs[i]) >= SAME_MEANING;
    });
    if (g) g.members.push(i);
    else groups.push({ members: [i], centroid: vecs?.[i] });
  });

  const mode = (xs: (string | undefined)[]) => {
    const counts = new Map<string, number>();
    for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  return groups
    .map((g) => {
      const ms = g.members.map((i) => usable[i]);
      const name = mode(ms.map((m) => m.name))!;
      return {
        id: newId("tp"),
        kind: ms[0].kind,
        name,
        definition: ms.map((m) => m.definition).sort((a, b) => b.length - a.length)[0] ?? "",
        ...(mode(ms.map((m) => m.parent)) ? { parent: mode(ms.map((m) => m.parent)) } : {}),
        ...(mode(ms.map((m) => m.domain)) ? { domain: mode(ms.map((m) => m.domain)) } : {}),
        ...(mode(ms.map((m) => m.range)) ? { range: mode(ms.map((m) => m.range)) } : {}),
        count: ms.length,
        variants: [...new Set(ms.map((m) => m.name))].filter((n) => n !== name),
        examples: ms
          .filter((m) => m.quote)
          .slice(0, 3)
          .map((m) => ({ quote: m.quote!, ...(m.documentId ? { documentId: m.documentId } : {}) })),
        status: "open" as const,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);
}

/** Above this similarity an idea is taken to be a specialisation of an existing class (when its name says so). */
const RELATED = 0.7;

/**
 * Change-aware extension (Research Area 2): before anything is added, decide
 * how each idea relates to what the ontology already has. Name equality was
 * already filtered out; here meaning is compared (name + definition), so
 * "Employer" next to an existing "Organization" defined the same way becomes a
 * label, not a duplicate class.
 */
export async function classifyProposals(proposals: TermProposal[], tbox: TBoxModel, embedder: Embedder | null): Promise<TermProposal[]> {
  if (!proposals.length) return proposals;
  const sameKind = (p: TermProposal) => (p.kind === "class" ? tbox.classes : p.kind === "objectProperty" ? tbox.objectProps : tbox.dataProps);
  const otherKinds = (p: TermProposal) => [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps].filter((t) => !sameKind(p).includes(t as never));
  const termText = (t: { uri: string; label?: string; comment?: string }) => `${t.label ?? norm(localName(t.uri))}. ${t.comment ?? ""}`;
  const all = [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps];
  const vecs = embedder && all.length ? await embedder.embed([...all.map(termText), ...proposals.map((p) => `${norm(p.name)}. ${p.definition}`)]) : null;
  const vecOf = new Map(all.map((t, i) => [t.uri, vecs?.[i]]));
  const classByLocal = new Map(tbox.classes.map((c) => [localName(c.uri).toLowerCase(), c.uri]));

  return proposals.map((p, i) => {
    // the same name as a term of another kind (a class "Owner" vs a property "owner")
    const clash = otherKinds(p).find((t) => norm(localName(t.uri)) === norm(p.name));
    if (clash) return { ...p, relation: "conflict" as const, match: { uri: clash.uri, score: 1 } };
    let best: { uri: string; score: number } | null = null;
    const v = vecs?.[all.length + i];
    if (v) {
      for (const t of sameKind(p)) {
        const tv = vecOf.get(t.uri);
        if (!tv) continue;
        const s = cosine(v, tv);
        if (!best || s > best.score) best = { uri: t.uri, score: Math.round(s * 1000) / 1000 };
      }
    }
    // "DoctoralResearcher" next to "Researcher": a compound ending in an existing class names a kind of it, however similar
    if (p.kind === "class") {
      const head = tbox.classes.find((c) => {
        const ln = localName(c.uri);
        return ln.length >= 4 && toTermLocalName(p.name).endsWith(ln) && toTermLocalName(p.name) !== ln;
      });
      if (head && (!best || best.uri === head.uri || best.score >= RELATED)) return { ...p, relation: "specialization" as const, parent: localName(head.uri), match: { uri: head.uri, score: best?.score ?? 1 } };
    }
    if (best && best.score >= SAME_MEANING) return { ...p, relation: "synonym" as const, match: best };
    if (p.kind === "class") {
      const parent = p.parent ? classByLocal.get(toTermLocalName(p.parent).toLowerCase()) : undefined;
      if (parent) return { ...p, relation: "specialization" as const, match: { uri: parent, score: best?.uri === parent ? best.score : 1 } };
    }
    return { ...p, relation: "new" as const, ...(best ? { match: best } : {}) };
  });
}

/* ───────────────────────── pending facts (the feedback loop) ───────────────────────── */

const MAX_PENDING = 2000;

/** Facts the ontology could not express: kept with their quote until the term exists. */
export function pendingFromUnmatched(terms: UnmatchedTerm[]): PendingFact[] {
  return terms
    .filter((t) => t.subjectId && (t.kind === "class" || (t.kind === "dataProperty" ? t.value != null : !!t.objectId)))
    .slice(0, MAX_PENDING)
    .map((t, i) => ({
      id: `pf${i}`,
      kind: t.kind,
      term: t.name,
      subjectId: t.subjectId!,
      ...(t.subjectLabel ? { subjectLabel: t.subjectLabel } : {}),
      ...(t.parent && t.kind === "class" ? { subjectClass: t.parent } : {}),
      ...(t.value != null ? { value: t.value } : {}),
      ...(t.objectId ? { targetId: t.objectId } : {}),
      ...(t.quote ? { quote: t.quote } : {}),
      ...(t.documentId ? { documentId: t.documentId } : {}),
      ...(t.chunkId ? { chunkId: t.chunkId } : {}),
    }));
}

/** Attach to each proposal the pending facts that wait for it and the chunks its idea came from. */
export function linkPending(proposals: TermProposal[], pending: PendingFact[], terms: UnmatchedTerm[]): TermProposal[] {
  return proposals.map((p) => {
    const names = new Set([p.name, ...p.variants].map(norm));
    const ids = pending.filter((f) => f.kind === p.kind && names.has(norm(f.term))).map((f) => f.id);
    const chunks = [...new Set(terms.filter((t) => t.kind === p.kind && names.has(norm(t.name)) && t.chunkId).map((t) => t.chunkId!))];
    return { ...p, ...(ids.length ? { pendingFactIds: ids } : {}), ...(chunks.length ? { chunkIds: chunks } : {}) };
  });
}

/**
 * Replay pending facts against an ontology that now has their terms. Each
 * becomes a CANDIDATE fact (a person reviews it), with its quote as evidence.
 * Facts whose term is still missing, or whose subject/object cannot be found,
 * are skipped and counted.
 */
export function replayPendingFacts(
  abox: ABoxResult,
  pending: PendingFact[],
  tbox: TBoxModel,
  opts: { evidence: (f: PendingFact) => EvidenceRef | null; runId?: string; at?: string },
): { abox: ABoxResult; replayed: number; skipped: number } {
  const byName = (list: { uri: string }[]) => new Map(list.map((t) => [norm(localName(t.uri)), t.uri]));
  const classes = byName(tbox.classes);
  const objectProps = byName(tbox.objectProps);
  const dataProps = byName(tbox.dataProps);
  // shallow copies: assertions are only ever added as new arrays below
  const individuals: ABoxIndividual[] = abox.individuals.map((i) => ({ ...i }));
  const byId = new Map(individuals.map((i) => [i.id, i]));
  const review: FactReview = { status: "candidate", by: "auto", reason: "replayed after the ontology gained its term", ...(opts.runId ? { runId: opts.runId } : {}), ...(opts.at ? { at: opts.at } : {}) };
  let replayed = 0;
  let skipped = 0;
  for (const f of pending) {
    const ev = opts.evidence(f);
    const evidence = ev ? [ev] : undefined;
    if (f.kind === "class") {
      const cls = classes.get(norm(f.term));
      if (!cls) {
        skipped++;
        continue;
      }
      const ind = byId.get(f.subjectId);
      if (ind) {
        if (ind.classUri === cls || ind.additionalTypes?.includes(cls)) continue;
        ind.additionalTypes = [...(ind.additionalTypes ?? []), cls];
      } else {
        const created = { id: f.subjectId, classUri: cls, ...(f.subjectLabel ? { label: f.subjectLabel } : {}), ...(evidence ? { evidence } : {}), review };
        individuals.push(created);
        byId.set(created.id, created);
      }
      replayed++;
    } else if (f.kind === "dataProperty") {
      const prop = dataProps.get(norm(f.term));
      const ind = byId.get(f.subjectId);
      if (!prop || !ind || f.value == null) {
        skipped++;
        continue;
      }
      if ((ind.dataProperties ?? []).some((d) => d.propUri === prop && d.value === f.value)) continue;
      ind.dataProperties = [...(ind.dataProperties ?? []), { propUri: prop, value: f.value, ...(evidence ? { evidence } : {}), review }];
      replayed++;
    } else {
      const prop = objectProps.get(norm(f.term));
      const ind = byId.get(f.subjectId);
      if (!prop || !ind || !f.targetId || !byId.has(f.targetId)) {
        skipped++;
        continue;
      }
      if ((ind.objectProperties ?? []).some((o) => o.propUri === prop && o.targetId === f.targetId)) continue;
      ind.objectProperties = [...(ind.objectProperties ?? []), { propUri: prop, targetId: f.targetId, ...(evidence ? { evidence } : {}), review }];
      replayed++;
    }
  }
  return { abox: { ...abox, individuals }, replayed, skipped };
}

const DATATYPES = new Set(["string", "decimal", "integer", "boolean", "double", "date", "dateTime", "time", "duration", "anyURI"]);

/** The namespace most of the T-Box's terms live in — new terms join it so parents and domains line up. */
export function mainNamespace(tbox: TBoxModel): string {
  const counts = new Map<string, number>();
  for (const t of [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps]) counts.set(namespaceOf(t.uri), (counts.get(namespaceOf(t.uri)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? tbox.baseIri;
}

export const EXTENSIONS_MODULE = "extensions.ttl";

/**
 * Turn accepted proposals into T-Box additions: a parent/domain/range that
 * names an existing class (by local name, case-insensitively) is linked to it;
 * anything else is dropped from the axiom rather than invented. Returns the
 * revision content with the additions appended to extensions.ttl.
 */
export function proposalsToContent(base: RevisionContent, tbox: TBoxModel, accepted: TermProposal[]): { content: RevisionContent; added: string[] } {
  const byLocal = new Map(tbox.classes.map((c) => [localName(c.uri).toLowerCase(), localName(c.uri)]));
  const newClasses = new Map(accepted.filter((p) => p.kind === "class").map((p) => [toTermLocalName(p.name).toLowerCase(), toTermLocalName(p.name)]));
  const cls = (name?: string) => (name ? (byLocal.get(toTermLocalName(name).toLowerCase()) ?? newClasses.get(toTermLocalName(name).toLowerCase())) : undefined);
  const raw: RawTBox = { classes: [], objectProperties: [], dataProperties: [] };
  const labels: Quad[] = [];
  for (const p of accepted) {
    const name = toTermLocalName(p.name);
    // another name for an existing term: record it as an alternative label, not a duplicate term
    if (p.relation === "synonym" && p.match && [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps].some((t) => t.uri === p.match!.uri)) {
      labels.push(DataFactory.quad(DataFactory.namedNode(p.match.uri), DataFactory.namedNode(SKOS + "altLabel"), DataFactory.literal(p.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))));
      continue;
    }
    if (p.kind === "class") raw.classes.push({ name, label: p.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"), comment: p.definition, ...(cls(p.parent) ? { parents: [cls(p.parent)!] } : {}) });
    else if (p.kind === "objectProperty") raw.objectProperties!.push({ name, comment: p.definition, ...(cls(p.domain) ? { domain: [cls(p.domain)!] } : {}), ...(cls(p.range) ? { range: [cls(p.range)!] } : {}) });
    else {
      const dt = p.range?.replace(/^xsd:/, "");
      raw.dataProperties!.push({ name, comment: p.definition, ...(cls(p.domain) ? { domain: [cls(p.domain)!] } : {}), datatype: dt && DATATYPES.has(dt) ? dt : "string" });
    }
  }
  const hasTerms = raw.classes.length || raw.objectProperties!.length || raw.dataProperties!.length;
  let additions = hasTerms ? serializeTBoxStructured(raw, mainNamespace(tbox)) : "";
  if (labels.length) {
    const w = new Writer({ prefixes: { skos: SKOS } });
    w.addQuads(labels);
    w.end((err, out) => {
      if (!err) additions = `${additions.trimEnd()}\n${out}`;
    });
  }
  const modules: OntoModule[] = [...base.modules];
  const at = modules.findIndex((m) => m.name === EXTENSIONS_MODULE);
  if (at >= 0) modules[at] = { ...modules[at], turtle: `${modules[at].turtle.trimEnd()}\n\n${additions}` };
  else modules.push({ id: newId("mod"), name: EXTENSIONS_MODULE, turtle: additions });
  return { content: { ...base, modules }, added: accepted.map((p) => toTermLocalName(p.name)) };
}
