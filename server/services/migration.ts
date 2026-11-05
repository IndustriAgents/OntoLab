// Schema evolution (B5). When a revision changes the T-Box of a revision that
// already has individuals, the individuals follow: a term that was renamed
// (same kind, and the same label, definition or case-insensitive local name
// under a new IRI) is rewritten everywhere it is used; individuals still using
// a removed term are flagged for review instead of silently left invalid.

import type { ABoxIndividual, ABoxResult } from "../../src/types/abox.ts";
import type { MigrationReport } from "../../src/types/project.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { localName } from "../../src/lib/ontology/iri.ts";

type Kind = "class" | "object" | "data";
interface Term {
  uri: string;
  kind: Kind;
  label?: string;
  comment?: string;
}

const terms = (t: TBoxModel): Term[] => [
  ...t.classes.map((c) => ({ uri: c.uri, kind: "class" as const, label: c.label, comment: c.comment })),
  ...t.objectProps.map((p) => ({ uri: p.uri, kind: "object" as const, label: p.label, comment: p.comment })),
  ...t.dataProps.map((p) => ({ uri: p.uri, kind: "data" as const, label: p.label, comment: p.comment })),
];

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** old URI → new URI for terms that moved, by kind and identity of label, definition or name. */
export function detectRenames(before: TBoxModel, after: TBoxModel): Map<string, string> {
  const afterUris = new Set(terms(after).map((t) => t.uri));
  const beforeUris = new Set(terms(before).map((t) => t.uri));
  const removed = terms(before).filter((t) => !afterUris.has(t.uri));
  const added = terms(after).filter((t) => !beforeUris.has(t.uri));
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of removed) {
    const matches = added.filter((a) => a.kind === r.kind && !taken.has(a.uri) && (same(a.label, r.label) || same(a.comment, r.comment) || same(localName(a.uri), localName(r.uri))));
    if (matches.length === 1) {
      out.set(r.uri, matches[0].uri);
      taken.add(matches[0].uri);
    }
  }
  return out;
}

export function migrateAbox(before: TBoxModel, after: TBoxModel, abox: ABoxResult): { abox: ABoxResult; report: MigrationReport } {
  const renames = detectRenames(before, after);
  const afterUris = new Set(terms(after).map((t) => t.uri));
  const removed = new Set(terms(before).filter((t) => !afterUris.has(t.uri) && !renames.has(t.uri)).map((t) => t.uri));
  const counts = new Map<string, number>();
  const r = (uri: string) => {
    const to = renames.get(uri);
    if (to) counts.set(uri, (counts.get(uri) ?? 0) + 1);
    return to ?? uri;
  };
  const flagged: MigrationReport["flagged"] = [];
  const individuals: ABoxIndividual[] = abox.individuals.map((ind) => {
    const next: ABoxIndividual = {
      ...ind,
      classUri: r(ind.classUri),
      ...(ind.additionalTypes ? { additionalTypes: ind.additionalTypes.map(r) } : {}),
      ...(ind.dataProperties ? { dataProperties: ind.dataProperties.map((d) => ({ ...d, propUri: r(d.propUri) })) } : {}),
      ...(ind.objectProperties ? { objectProperties: ind.objectProperties.map((o) => ({ ...o, propUri: r(o.propUri) })) } : {}),
    };
    const used = [next.classUri, ...(next.additionalTypes ?? []), ...(next.dataProperties ?? []).map((d) => d.propUri), ...(next.objectProperties ?? []).map((o) => o.propUri)];
    for (const u of new Set(used)) if (removed.has(u)) flagged.push({ id: ind.id, term: u });
    return next;
  });
  return {
    abox: { individuals },
    report: { renamed: [...renames.entries()].filter(([from]) => counts.has(from)).map(([from, to]) => ({ from, to, individuals: counts.get(from)! })), flagged },
  };
}
