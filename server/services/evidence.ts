// Evidence resolution: turn a model-supplied quote into a located reference by
// finding it in the source text it claims to come from. Matching tolerates the
// differences models actually introduce (whitespace, curly quotes, dashes,
// case) but nothing more — an unfound quote stays "unverified" rather than
// being attached to the nearest-looking passage. We never invent a location.

import type { ABoxIndividual, ABoxResult, EvidenceRef } from "../../src/types/abox.ts";
import type { DocumentChunk } from "../../src/types/project.ts";

import { locateQuote } from "../../src/lib/sourceQuote.ts";
export { locateQuote } from "../../src/lib/sourceQuote.ts";

export interface EvidenceSource {
  runId?: string;
  documentId: string;
  /** the chunk the model read; null for vision-only steps */
  chunk: DocumentChunk | null;
  /** full document text, used when the step read a whole document (vision) */
  documentText?: string;
  /** Original document page spans; chunk.page is only the start of a chunk. */
  pages?: { page: number; start: number; end: number }[];
}

function resolveOne(ref: EvidenceRef, src: EvidenceSource): EvidenceRef {
  const pageAt = (start: number) => src.pages?.find((p) => start >= p.start && start < p.end)?.page;
  if (ref.status === "verified" || ref.status === "legacy")
    return ref.status === "verified" && ref.documentId === src.documentId && ref.start != null && src.pages
      ? { ...ref, page: pageAt(ref.start) }
      : ref;
  if (src.chunk) {
    const hit = locateQuote(ref.quote, src.chunk.text);
    if (hit) {
      const start = src.chunk.start + hit.start;
      return {
        documentId: src.documentId,
        chunkId: src.chunk.id,
        page: src.pages ? pageAt(start) : src.chunk.page === src.chunk.pageEnd || !src.chunk.pageEnd ? src.chunk.page : undefined,
        start,
        end: src.chunk.start + hit.end,
        quote: ref.quote,
        status: "verified",
      };
    }
    return { documentId: src.documentId, chunkId: src.chunk.id, quote: ref.quote, status: "unverified" };
  }
  // Vision step: check against the extracted text if there is any, otherwise
  // it is a vision-only reference that cannot be checked.
  if (src.documentText) {
    const hit = locateQuote(ref.quote, src.documentText);
    if (hit)
      return { documentId: src.documentId, page: pageAt(hit.start), start: hit.start, end: hit.end, quote: ref.quote, status: "verified" };
  }
  return { documentId: src.documentId, quote: ref.quote, status: "vision" };
}

const resolveList = (list: EvidenceRef[] | undefined, src: EvidenceSource) =>
  list?.map((r) => ({ ...resolveOne(r, src), ...(src.runId ? { runId: r.runId ?? src.runId } : {}) }));

/** Resolve every quote in one step's output against the text that step read. */
export function resolveEvidence(abox: ABoxResult, src: EvidenceSource): ABoxResult {
  return {
    individuals: abox.individuals.map((ind) => {
      const next: ABoxIndividual = { ...ind };
      if (ind.evidence) next.evidence = resolveList(ind.evidence, src);
      else if (ind.sourceEvidence)
        next.evidence = [
          { ...resolveOne({ quote: ind.sourceEvidence, status: "unverified" }, src), ...(src.runId ? { runId: src.runId } : {}) },
        ];
      if (ind.dataProperties)
        next.dataProperties = ind.dataProperties.map((d) => (d.evidence ? { ...d, evidence: resolveList(d.evidence, src) } : d));
      if (ind.objectProperties)
        next.objectProperties = ind.objectProperties.map((o) => (o.evidence ? { ...o, evidence: resolveList(o.evidence, src) } : o));
      return next;
    }),
  };
}

/**
 * Legacy A-Boxes (imported Turtle, older sessions) only have free-text
 * `sourceEvidence`. Surface it as a "legacy" reference with no location — we do
 * not guess where it came from.
 */
export function legacyEvidence(ind: ABoxIndividual): EvidenceRef[] {
  if (ind.evidence?.length) return ind.evidence;
  return ind.sourceEvidence ? [{ quote: ind.sourceEvidence, status: "legacy" }] : [];
}
