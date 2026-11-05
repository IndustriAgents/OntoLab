import { Parser, Writer } from "n3";
import type { CallContext } from "../extract.ts";
import { HttpError } from "../http.ts";
import { generationContextTokens, generationOutputTokens } from "../ml/generationBudget.ts";
import { generationCounter } from "../ml/tokenization.ts";
import { isCliProvider } from "../cli/catalog.ts";
import { localName, OWL, RDF, RDFS, XSD } from "../../src/lib/ontology/iri.ts";

/** Keep full, original statement IDs while showing only a bounded repair neighborhood. */
export function buildRepairContext(turtle: string, instruction: string, call: CallContext, subjects: string[] = []) {
  const quads = new Parser({ blankNodePrefix: "" }).parse(turtle);
  const writer = new Writer({ format: "N-Triples" });
  const counter = generationCounter(call.provider, call.model);
  const limit = Math.min(
    32000,
    (generationContextTokens() ?? 131072) - generationOutputTokens(4096) - (isCliProvider(call.provider) ? 8192 : 0) - 512 - 4096,
  );
  const encodedSize = (value: unknown) => counter.count(JSON.stringify(JSON.stringify(value)));
  if (limit <= encodedSize({ findings: instruction, statements: [] }))
    throw new HttpError(413, "The configured budget leaves no room for a safe ontology repair context.");

  const declarations = quads.filter(
    (q) =>
      q.subject.termType === "NamedNode" &&
      q.predicate.value === RDF + "type" &&
      [OWL + "Class", OWL + "ObjectProperty", OWL + "DatatypeProperty", RDF + "Property"].includes(q.object.value),
  );
  const focus = new Set(subjects);
  if (subjects.length)
    for (const q of declarations) {
      const name = localName(q.subject.value);
      if (name.length >= 3 && instruction.includes(name)) focus.add(q.subject.value);
    }
  const standard = (iri: string) => [RDF, RDFS, OWL, XSD].some((prefix) => iri.startsWith(prefix));
  const related = new Set<string>();
  for (const q of quads) {
    if (focus.has(q.subject.value) && q.object.termType === "NamedNode" && !standard(q.object.value)) related.add(q.object.value);
    if (focus.has(q.object.value) && q.subject.termType === "NamedNode" && !standard(q.subject.value)) related.add(q.subject.value);
  }

  // A compact vocabulary lets a missing-domain repair choose existing classes,
  // without resending every definition and annotation in the ontology.
  const prefixes: Record<string, string> = {};
  const aliases = new Map<string, string>();
  const vocabulary: string[][] = [];
  let vocabularySize = 0;
  const ordered = [...declarations].sort(
    (a, b) =>
      Number(!focus.has(a.subject.value) && !related.has(a.subject.value)) -
      Number(!focus.has(b.subject.value) && !related.has(b.subject.value)),
  );
  for (const q of ordered) {
    const iri = q.subject.value;
    const boundary = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1;
    const namespace = iri.slice(0, boundary);
    const prefix = aliases.get(namespace) ?? `n${aliases.size}`;
    const entry = [`${prefix}:${iri.slice(boundary)}`, localName(q.object.value)];
    const cost = encodedSize(entry) + (aliases.has(namespace) ? 0 : encodedSize({ [prefix]: namespace }));
    if (vocabularySize + cost > Math.min(8192, limit / 3)) continue;
    if (!aliases.has(namespace)) {
      aliases.set(namespace, prefix);
      prefixes[prefix] = namespace;
    }
    vocabulary.push(entry);
    vocabularySize += cost;
  }
  const base = {
    findings: instruction,
    prefixes,
    vocabulary,
    vocabularyComplete: vocabulary.length === declarations.length,
    statements: [] as string[],
  };
  let remaining = limit - encodedSize(base);
  const lines = quads.map((q, index) => `${index}: ${writer.quadToString(q.subject, q.predicate, q.object)}`);
  const blankRows = new Map<string, number[]>();
  quads.forEach((q, index) => {
    for (const term of [q.subject, q.object])
      if (term.termType === "BlankNode") {
        const rows = blankRows.get(term.value) ?? [];
        rows.push(index);
        blankRows.set(term.value, rows);
      }
  });
  const units = new Map<number, number[]>();
  const bundle = (index: number): number[] => {
    const known = units.get(index);
    if (known) return known;
    const indices = new Set<number>(),
      pending = [index];
    while (pending.length) {
      const i = pending.pop()!;
      if (indices.has(i)) continue;
      indices.add(i);
      for (const term of [quads[i].subject, quads[i].object])
        if (term.termType === "BlankNode") pending.push(...(blankRows.get(term.value) ?? []));
    }
    const result = [...indices].sort((a, b) => a - b);
    for (const i of result) units.set(i, result);
    return result;
  };
  const candidates = quads
    .map((q, index) => ({
      index,
      rank: !subjects.length ? 0 : focus.has(q.subject.value) ? 0 : focus.has(q.object.value) ? 1 : related.has(q.subject.value) ? 2 : 3,
    }))
    .filter((candidate) => candidate.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const indices = new Set<number>();
  for (const candidate of candidates) {
    const unit = bundle(candidate.index).filter((index) => !indices.has(index));
    const cost = unit.reduce((total, index) => total + encodedSize(lines[index]) + 2, 0);
    if (cost > remaining) continue;
    for (const index of unit) indices.add(index);
    remaining -= cost;
  }
  if (!indices.size) throw new HttpError(413, "No complete relevant statements fit the ontology repair budget; manual review is required.");
  const statements = [...indices].sort((a, b) => a - b).map((index) => lines[index]);
  const lead = JSON.stringify({ ...base, statements });
  return {
    quads,
    writer,
    indices,
    lead,
    scope: {
      statementsShown: indices.size,
      totalStatements: quads.length,
      vocabularyTermsShown: vocabulary.length,
      vocabularyTermsTotal: declarations.length,
      inputLimit: limit,
      inputEstimate: encodedSize({ ...base, statements }),
    },
  };
}
