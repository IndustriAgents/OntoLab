// Proposed terms that the ontology already has. The extraction schema offers
// `proposedTerms` for facts no property can express; some models (seen with
// Claude Haiku on Text2KGBench) instead file ordinary facts there under a
// longer name: "albumArtist" when the T-Box has "artist", "albumReleaseDate"
// when it has "releaseDate". Queued as proposals, those facts wait for a
// person to add a term that already exists. Before conformance, each such
// proposal is turned back into an assertion on the existing property, so it
// gets the same quote location, entailment check and review as every other
// fact. Deterministic and name-based: a compound that ends in an existing
// property's name names a sub-property of it, so the general assertion holds.

import type { TBoxModel, TBoxProperty } from "../src/types/tbox.ts";
import { localName } from "../src/lib/ontology/iri.ts";
import { toTermLocalName } from "../src/lib/ontology/tboxSerializer.ts";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
// compare names ignoring case, separators and a leading has/is ("hasArtist", "release_date" ~ "artist", "releaseDate")
const key = (s: string) => toTermLocalName(s).replace(/^(has|is)(?=[A-Z_-])/, "").replace(/[_-]/g, "").toLowerCase();

/** The existing property a proposed name stands for, or null. Equal names first, then the longest existing name the proposal ends with. */
export function existingPropertyFor(name: string, props: TBoxProperty[]): TBoxProperty | null {
  const k = key(name);
  if (!k) return null;
  const equal = props.find((p) => key(localName(p.uri)) === k);
  if (equal) return equal;
  const ends = props
    .map((p) => ({ p, ln: key(localName(p.uri)) }))
    .filter(({ ln }) => ln.length >= 4 && k.length > ln.length && k.endsWith(ln))
    .sort((a, b) => b.ln.length - a.ln.length);
  return ends[0]?.p ?? null;
}

/** The text's own spelling of a kebab/snake id ("year-of-no-light" → "Year of No Light"), or the words of the id. */
function labelFromId(id: string, texts: string[]): string {
  const words = id.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return id;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\-_]+"), "i");
  for (const t of texts) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return words.join(" ");
}

export interface FoldResult {
  /** the raw individuals with the folded assertions added */
  individuals: unknown[];
  /** the raw proposals that still name a missing idea */
  proposedTerms: unknown[];
  notes: string[];
}

/**
 * Move proposals that name an existing property (see existingPropertyFor) into
 * the raw individuals, creating the subject or target individual when the
 * model did not emit it. A fact is folded only when its subject, value/target
 * and a class for any individual it must create are all known; anything else
 * stays a proposal.
 */
export function foldProposedFacts(rawIndividuals: unknown, rawProposed: unknown, tbox: TBoxModel, texts: string[] = [], knownIds: Set<string> = new Set()): FoldResult {
  const individuals = (Array.isArray(rawIndividuals) ? rawIndividuals : []).map((i) => (isObj(i) ? { ...i } : i));
  const proposed = Array.isArray(rawProposed) ? rawProposed : [];
  if (!proposed.length) return { individuals, proposedTerms: proposed, notes: [] };
  const byId = new Map<string, Raw>();
  for (const i of individuals) if (isObj(i) && str(i.id)) byId.set(str(i.id)!, i);
  const classByName = new Map(tbox.classes.map((c) => [key(localName(c.uri)), c.uri]));
  const classSet = new Set(tbox.classes.map((c) => c.uri));
  const classFor = (named: string | undefined, declared: string[]) =>
    (named ? classByName.get(key(named)) : undefined) ?? declared.find((u) => classSet.has(u));
  // the individual with this id, created with the given class when the result lacks it
  const ensure = (id: string, cls: string | undefined, label: string | undefined, quote: string | undefined): Raw | null => {
    const have = byId.get(id);
    if (have) return have;
    if (!cls) return null;
    const ind: Raw = { id, classUri: cls, label: label ?? labelFromId(id, [quote ?? "", ...texts]), ...(quote ? { sourceEvidence: quote } : {}) };
    individuals.push(ind);
    byId.set(id, ind);
    return ind;
  };

  const kept: unknown[] = [];
  const folded = new Map<string, number>();
  for (const t of proposed) {
    const o = isObj(t) ? t : null;
    const kind = o?.kind;
    const subject = str(o?.subject);
    if (!o || (kind !== "dataProperty" && kind !== "objectProperty") || !subject || !str(o.name)) {
      kept.push(t);
      continue;
    }
    const prop = existingPropertyFor(str(o.name)!, kind === "dataProperty" ? tbox.dataProps : tbox.objectProps);
    const value = str(o.value);
    const object = str(o.object);
    const quote = str(o.quote);
    if (!prop || (kind === "dataProperty" ? !value : !object)) {
      kept.push(t);
      continue;
    }
    // a target from an earlier chunk is kept by conformance; a new one needs a class
    if (kind === "objectProperty" && !byId.has(object!) && !knownIds.has(object!)) {
      if (!ensure(object!, classFor(str(o.range), prop.range), undefined, quote)) {
        kept.push(t);
        continue;
      }
    }
    const subj = ensure(subject, classFor(str(o.domain), prop.domain), str(o.subjectLabel), quote);
    if (!subj) {
      kept.push(t);
      continue;
    }
    const assertion = { propUri: prop.uri, ...(kind === "dataProperty" ? { value } : { targetId: object }), ...(quote ? { quote } : {}) };
    const field = kind === "dataProperty" ? "dataProperties" : "objectProperties";
    subj[field] = [...(Array.isArray(subj[field]) ? (subj[field] as unknown[]) : []), assertion];
    const label = `${str(o.name)} → ${localName(prop.uri)}`;
    folded.set(label, (folded.get(label) ?? 0) + 1);
  }
  const notes = folded.size
    ? [`${[...folded.values()].reduce((a, b) => a + b, 0)} proposed fact(s) used an existing property under another name and were asserted on it: ${[...folded.entries()].map(([l, n]) => (n > 1 ? `${l} (${n})` : l)).join(", ")}`]
    : [];
  return { individuals, proposedTerms: kept, notes };
}
