// Boundary validation. Request bodies arrive as untrusted JSON and model output
// arrives as untrusted JSON; both are checked here before anything else touches
// them, so a malformed payload is a 400 with a useful message rather than a
// "Cannot read properties of undefined" surfacing as a 502.

import type { TBoxModel } from "../src/types/tbox.ts";
import type { ABoxResult, ABoxIndividual, EvidenceRef, ExtractDoc } from "../src/types/abox.ts";
import type { UnmatchedTerm } from "../src/types/project.ts";
import { localName } from "../src/lib/ontology/iri.ts";
import { badRequest } from "./http.ts";
import { MAX_DOC_CHARS, MAX_FILE_BASE64 } from "./config.ts";
import { normalizeDatatype } from "../src/lib/ontology/iri.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function strArray(v: unknown, field: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => !isStr(x))) throw badRequest(`${field} must be an array of strings`);
  return v as string[];
}

/* ───────────────────────── T-Box ───────────────────────── */

export function requireTBox(v: unknown, field = "tbox"): TBoxModel {
  if (!isObj(v)) throw badRequest(`${field} is required`);
  const classes = v.classes;
  if (!Array.isArray(classes) || classes.length === 0) throw badRequest("T-Box has no classes to work with.");

  const term = (t: unknown, kind: string) => {
    if (!isObj(t) || !isStr(t.uri) || !t.uri) throw badRequest(`Each ${kind} needs a uri`);
    return t;
  };
  for (const c of classes) term(c, "class");
  const props = (arr: unknown, kind: string) => {
    if (arr == null) return [];
    if (!Array.isArray(arr)) throw badRequest(`${kind} must be an array`);
    for (const p of arr) {
      const t = term(p, kind);
      strArray(t.domain, `${kind}.domain`);
      strArray(t.range, `${kind}.range`);
    }
    return arr;
  };
  props(v.objectProps, "objectProps");
  props(v.dataProps, "dataProps");
  if (v.subClassOf != null && !isObj(v.subClassOf)) throw badRequest("subClassOf must be an object");

  return {
    prefixes: isObj(v.prefixes) ? (v.prefixes as Record<string, string>) : {},
    baseIri: isStr(v.baseIri) ? v.baseIri : "",
    classes: classes as TBoxModel["classes"],
    objectProps: (v.objectProps ?? []) as TBoxModel["objectProps"],
    dataProps: (v.dataProps ?? []) as TBoxModel["dataProps"],
    subClassOf: (v.subClassOf ?? {}) as Record<string, string[]>,
    ...(isStr(v.ontologyIri) ? { ontologyIri: v.ontologyIri } : {}),
    ...(Array.isArray(v.imports) ? { imports: v.imports as string[] } : {}),
    ...(Array.isArray(v.restrictions) ? { restrictions: v.restrictions as TBoxModel["restrictions"] } : {}),
  };
}

/* ───────────────────────── documents ───────────────────────── */

/** Strip characters that could break out of the document delimiter in a prompt. */
function safeName(name: string): string {
  return name.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "document";
}

export function requireDocs(v: unknown, field = "documents", { allowEmpty = false } = {}): ExtractDoc[] {
  if (v == null && allowEmpty) return [];
  if (!Array.isArray(v)) throw badRequest(`${field} must be an array`);
  if (!v.length && !allowEmpty) throw badRequest("No documents provided.");

  let totalChars = 0;
  const docs: ExtractDoc[] = [];
  for (const d of v) {
    if (!isObj(d)) throw badRequest(`Each ${field} entry must be an object`);
    const text = isStr(d.text) ? d.text : "";
    const name = safeName(isStr(d.name) ? d.name : "document");
    totalChars += text.length;
    const doc: ExtractDoc = { name, text };
    if (d.asVision) {
      if (!isStr(d.pdfBase64) || !d.pdfBase64) throw badRequest(`"${name}" is marked for vision but carries no PDF data`);
      if (d.pdfBase64.length > MAX_FILE_BASE64) throw badRequest(`"${name}" is too large to send as a PDF (limit ${Math.round(MAX_FILE_BASE64 / 1e6)} MB)`);
      doc.asVision = true;
      doc.pdfBase64 = d.pdfBase64;
    }
    docs.push(doc);
  }
  if (totalChars > MAX_DOC_CHARS) {
    throw badRequest(
      `Documents are too large (${Math.round(totalChars / 1000)}k characters, limit ${Math.round(MAX_DOC_CHARS / 1000)}k). ` +
        "Remove a document or split the extraction into smaller runs.",
    );
  }
  return docs;
}

/* ───────────────────────── A-Box ───────────────────────── */

export function requireAbox(v: unknown, field = "abox"): ABoxResult {
  if (!isObj(v)) throw badRequest(`${field} is required`);
  if (!Array.isArray(v.individuals)) throw badRequest(`${field}.individuals must be an array`);
  return { individuals: v.individuals as ABoxIndividual[] };
}

export function optionalString(v: unknown, field: string, { max = 20_000 } = {}): string | undefined {
  if (v == null) return undefined;
  if (!isStr(v)) throw badRequest(`${field} must be a string`);
  if (v.length > max) throw badRequest(`${field} is too long (limit ${max} characters)`);
  return v;
}

export function requireString(v: unknown, field: string, opts?: { max?: number }): string {
  const s = optionalString(v, field, opts);
  if (!s?.trim()) throw badRequest(`${field} is required`);
  return s;
}

export function optionalStringArray(v: unknown, field: string): string[] | undefined {
  if (v == null) return undefined;
  return strArray(v, field);
}

/* ───────────────────────── model output conformance ───────────────────────── */

/**
 * A model-supplied quote becomes an *unverified* evidence reference. Locating it
 * in a document (and upgrading it to "verified") is the run service's job — it
 * knows which chunk the model was reading; this pass does not.
 */
function rawEvidence(v: unknown): EvidenceRef[] | undefined {
  if (!isStr(v) || !v.trim()) return undefined;
  return [{ quote: v.trim().slice(0, 2000), status: "unverified" }];
}

export interface ConformanceReport {
  abox: ABoxResult;
  /** human-readable notes about what was corrected or dropped */
  notes: string[];
  dropped: number;
  /**
   * Classes and properties the model used that the T-Box does not have. They
   * are dropped from the A-Box but kept here for the improvement loop (A7)
   * rather than discarded silently.
   */
  unmatched: UnmatchedTerm[];
}

/**
 * Make the model's A-Box conform to the T-Box before it ever reaches the client.
 *
 * Structured output constrains which URIs may appear, but not that the JSON is
 * well-formed, that ids are unique, that object-property targets exist, or that
 * `datatype` is a real datatype IRI. This pass fixes what is fixable and drops
 * what is not, reporting every change:
 *   - non-object / unnamed individuals and unknown classes → dropped
 *   - duplicate ids → merged into the first individual
 *   - assertions naming unknown properties → dropped
 *   - dangling object-property targets → dropped
 *   - datatype hints normalised ("decimal", "xsd:decimal" → the XSD IRI)
 *
 * Domain/range mismatches are NOT dropped: those are flag-and-keep findings the
 * review screen shows, and silently discarding them would hide real extractions.
 */
export function conformAbox(raw: unknown, tbox: TBoxModel, opts: { knownIds?: Set<string> } = {}): ConformanceReport {
  const notes: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  const classSet = new Set(tbox.classes.map((c) => c.uri));
  const dataProps = new Set(tbox.dataProps.map((p) => p.uri));
  const objProps = new Set(tbox.objectProps.map((p) => p.uri));

  let dropped = 0;
  const unmatched = new Map<string, UnmatchedTerm>();
  const noteUnmatched = (kind: UnmatchedTerm["kind"], uri: string, quote: unknown) => {
    const name = localName(uri).trim();
    if (!name || unmatched.has(`${kind}:${name}`)) return;
    unmatched.set(`${kind}:${name}`, { kind, name, definition: "", ...(isStr(quote) && quote.trim() ? { quote: quote.trim().slice(0, 400) } : {}) });
  };
  const byId = new Map<string, ABoxIndividual>();
  const order: string[] = [];

  for (const item of list) {
    if (!isObj(item) || !isStr(item.id) || !item.id.trim()) {
      dropped++;
      continue;
    }
    const id = item.id.trim();
    const classUri = isStr(item.classUri) ? item.classUri : "";
    if (!classSet.has(classUri)) {
      dropped++;
      notes.push(`dropped "${id}": class ${classUri || "(missing)"} is not in the T-Box`);
      if (classUri) noteUnmatched("class", classUri, item.sourceEvidence);
      continue;
    }
    const ind: ABoxIndividual = { id, classUri };
    if (isStr(item.label) && item.label.trim()) ind.label = item.label.trim();
    if (isStr(item.sourceEvidence) && item.sourceEvidence.trim()) ind.sourceEvidence = item.sourceEvidence.trim().slice(0, 2000);
    const indEv = rawEvidence(item.sourceEvidence);
    if (indEv) ind.evidence = indEv;
    const extraTypes = Array.isArray(item.additionalTypes) ? item.additionalTypes.filter((t): t is string => isStr(t) && classSet.has(t) && t !== classUri) : [];
    if (extraTypes.length) ind.additionalTypes = [...new Set(extraTypes)];

    if (Array.isArray(item.dataProperties)) {
      const out: NonNullable<ABoxIndividual["dataProperties"]> = [];
      for (const dp of item.dataProperties) {
        if (!isObj(dp) || !isStr(dp.propUri)) continue;
        if (!dataProps.has(dp.propUri)) {
          if (!objProps.has(dp.propUri)) noteUnmatched("dataProperty", dp.propUri, dp.quote);
          continue;
        }
        const value = isStr(dp.value) ? dp.value : dp.value == null ? "" : String(dp.value);
        const entry: NonNullable<ABoxIndividual["dataProperties"]>[number] = { propUri: dp.propUri, value };
        if (isStr(dp.lang) && dp.lang.trim()) entry.lang = dp.lang.trim();
        else {
          const dt = normalizeDatatype(isStr(dp.datatype) ? dp.datatype : undefined);
          if (dt) entry.datatype = dt;
        }
        const ev = rawEvidence(dp.quote);
        if (ev) entry.evidence = ev;
        out.push(entry);
      }
      if (out.length) ind.dataProperties = out;
    }
    if (Array.isArray(item.objectProperties)) {
      const out: NonNullable<ABoxIndividual["objectProperties"]> = [];
      for (const op of item.objectProperties) {
        if (!isObj(op) || !isStr(op.propUri)) continue;
        if (!objProps.has(op.propUri)) {
          if (!dataProps.has(op.propUri)) noteUnmatched("objectProperty", op.propUri, op.quote);
          continue;
        }
        if (!isStr(op.targetId) || !op.targetId.trim()) continue;
        const ev = rawEvidence(op.quote);
        out.push(ev ? { propUri: op.propUri, targetId: op.targetId.trim(), evidence: ev } : { propUri: op.propUri, targetId: op.targetId.trim() });
      }
      if (out.length) ind.objectProperties = out;
    }

    const existing = byId.get(id);
    if (existing) {
      notes.push(`merged a second individual with the duplicate id "${id}"`);
      existing.label ??= ind.label;
      existing.sourceEvidence ??= ind.sourceEvidence;
      if (ind.evidence?.length) existing.evidence = [...(existing.evidence ?? []), ...ind.evidence];
      if (ind.dataProperties?.length) existing.dataProperties = [...(existing.dataProperties ?? []), ...ind.dataProperties];
      if (ind.objectProperties?.length) existing.objectProperties = [...(existing.objectProperties ?? []), ...ind.objectProperties];
      continue;
    }
    byId.set(id, ind);
    order.push(id);
  }

  // Drop object-property targets that name an individual the model never emitted.
  let danglingCount = 0;
  for (const id of order) {
    const ind = byId.get(id)!;
    if (!ind.objectProperties) continue;
    const kept = ind.objectProperties.filter((op) => byId.has(op.targetId) || !!opts.knownIds?.has(op.targetId));
    danglingCount += ind.objectProperties.length - kept.length;
    if (kept.length) ind.objectProperties = kept;
    else delete ind.objectProperties;
  }
  if (danglingCount) notes.push(`dropped ${danglingCount} link${danglingCount === 1 ? "" : "s"} pointing at individuals that were never emitted`);
  if (dropped) notes.push(`dropped ${dropped} individual${dropped === 1 ? "" : "s"} that did not conform to the T-Box`);

  return { abox: { individuals: order.map((id) => byId.get(id)!) }, notes, dropped, unmatched: [...unmatched.values()] };
}
