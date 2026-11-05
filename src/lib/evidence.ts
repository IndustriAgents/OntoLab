import type { EvidenceRef, FactReview } from "../types/abox";
import type { EvidenceTable, QuoteMatch } from "../types/evidence";
import { locateQuoteDetailed } from "./sourceQuote";

export function quoteMatch(ref: EvidenceRef, text: string | undefined, chunk?: { text: string; start: number; end: number }) {
  if (text === undefined) return { kind: (ref.status === "vision" ? "vision" : "unrecorded") as QuoteMatch };
  if (!ref.quote.trim()) return { kind: (ref.status === "vision" ? "vision" : "unrecorded") as QuoteMatch };
  // An explicit historical location must reproduce the quote. Never move it to another occurrence.
  if (ref.start != null && ref.end != null) {
    if (ref.start < 0 || ref.end <= ref.start || ref.end > text.length) return { kind: "mismatch" as const };
    const hit = locateQuoteDetailed(ref.quote, text.slice(ref.start, ref.end));
    return hit ? { kind: hit.kind, start: ref.start + hit.start, end: ref.start + hit.end } : { kind: "mismatch" as const };
  }
  const hit = locateQuoteDetailed(ref.quote, chunk?.text ?? text);
  return hit
    ? { kind: hit.kind, start: (chunk?.start ?? 0) + hit.start, end: (chunk?.start ?? 0) + hit.end }
    : { kind: (ref.status === "vision" ? "vision" : "not-found") as QuoteMatch };
}

export const quoteMatchLabel: Record<QuoteMatch, string> = {
  exact: "Exact quote match",
  normalized: "Located after normalization",
  partial: "Partial quote located",
  "not-found": "Quote not located",
  mismatch: "Source location mismatch",
  vision: "Vision only",
  unrecorded: "No location recorded",
};
export function reviewLabel(review?: FactReview): string {
  if (!review) return "Legacy acceptance";
  if (review.status === "candidate") return "Awaiting review";
  if (review.status === "rejected") return review.by === "user" ? "Rejected by reviewer" : "Rejected automatically";
  return review.by === "user" ? "Accepted by reviewer" : "Accepted automatically";
}

/** A view of the recorded pipe table, with row offsets in parsed text. Not an original-layout claim. */
export function parsedEvidenceTable(
  text: string,
  span: { start: number; end: number },
  highlight?: { start: number; end: number },
): EvidenceTable | undefined {
  const lines = text.slice(span.start, span.end).split("\n");
  if (lines.length < 2 || !/^\s*\|?\s*:?-{3,}/.test(lines[1])) return undefined;
  let offset = span.start;
  const rows: EvidenceTable["rows"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = offset;
    offset += line.length + 1;
    if (i === 1) continue;
    if (rows.length >= 100) break;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((s) => s.trim().replace(/\\\|/g, "|"));
    if (cells.length > 40) return undefined;
    rows.push({ cells, header: i === 0, highlighted: !!highlight && highlight.start < start + line.length && highlight.end > start });
  }
  return { representation: "parsed", rows, truncated: lines.length - 1 > rows.length };
}
