// Split a document's text into bounded chunks at paragraph boundaries. Each
// chunk records exact character offsets (chunk.text === text.slice(start, end))
// and the page(s) it spans, which is what lets evidence resolve to a location.

import type { PageSpan, SectionSpan } from "../../src/types/project.ts";
import type { ChunkMethod } from "../../src/types/research.ts";

export interface TextChunk {
  ordinal: number;
  start: number;
  end: number;
  text: string;
  page?: number;
  pageEnd?: number;
  sectionPath?: string[];
  overlap?: number;
}

/** Paragraph spans: runs of text separated by blank lines. */
function paragraphs(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /\n[ \t]*\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ start: last, end: text.length });
  return out.filter((p) => text.slice(p.start, p.end).trim().length > 0);
}

/** Break an over-long paragraph at sentence ends (or hard, as a last resort). */
function splitLong(text: string, span: { start: number; end: number }, max: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = span.start;
  while (span.end - s > max) {
    const window = text.slice(s, s + max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("\n"));
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.3) cut = max - 1;
    out.push({ start: s, end: s + cut + 1 });
    s += cut + 1;
    while (s < span.end && /\s/.test(text[s])) s++;
  }
  if (s < span.end) out.push({ start: s, end: span.end });
  return out;
}

function pageAt(pages: PageSpan[], offset: number): number | undefined {
  if (!pages.length) return undefined;
  for (const p of pages) if (offset >= p.start && offset <= p.end) return p.page;
  // offsets in the gap between two pages belong to the next page
  return pages.find((p) => p.start >= offset)?.page ?? pages[pages.length - 1].page;
}

/** Headings the offset sits under, outermost first (deepest section containing it). */
export function sectionPathAt(sections: SectionSpan[], offset: number): string[] | undefined {
  let best: SectionSpan | undefined;
  for (const s of sections) if (s.start <= offset && offset < s.end && (!best || s.level > best.level || s.start > best.start)) best = s;
  return best?.path;
}

/**
 * Where an overlapping chunk may start: `want` chars before `start`, moved
 * forward to the next paragraph, line or sentence boundary so the repeated
 * context never begins mid-word.
 */
function overlapStart(text: string, floor: number, start: number, want: number): number {
  if (want <= 0) return start;
  const from = Math.max(floor, start - want);
  const window = text.slice(from, start);
  for (const re of [/\n[ \t]*\n/g, /\n/g, /[.!?]\s+/g]) {
    re.lastIndex = 0;
    const m = re.exec(window);
    if (m && m.index + m[0].length < window.length) return from + m.index + m[0].length;
  }
  const sp = window.indexOf(" ");
  return sp >= 0 && sp + 1 < window.length ? from + sp + 1 : start;
}

export interface ChunkOptions {
  method?: ChunkMethod;
  /** share of a chunk repeated at the start of the next one (0–0.3) */
  overlap?: number;
  sections?: SectionSpan[];
}

export function chunkText(text: string, pages: PageSpan[], maxChars: number, opts: ChunkOptions = {}): TextChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("Chunk size must be a positive integer.");
  const sectionCuts = opts.method === "section"
    ? [...new Set([0, ...(opts.sections ?? []).map((s) => s.start), text.length])].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b)
    : [0, text.length];
  const boundaries = new Set(sectionCuts.slice(1, -1));
  const spans = opts.method === "fixed"
    ? Array.from({ length: Math.ceil(text.length / maxChars) }, (_, i) => ({ start: i * maxChars, end: Math.min(text.length, (i + 1) * maxChars) }))
    : sectionCuts.slice(0, -1).flatMap((start, i) => paragraphs(text.slice(start, sectionCuts[i + 1])).map((p) => ({ start: p.start + start, end: p.end + start })))
      .flatMap((p) => (p.end - p.start > maxChars ? splitLong(text, p, maxChars) : [p]));
  const base: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const sp of spans) {
    if (cur && (sp.end - cur.start > maxChars || sectionCuts.some((cut) => cut > cur!.start && cut <= sp.start))) {
      base.push(cur);
      cur = null;
    }
    cur = cur ? { start: cur.start, end: sp.end } : { ...sp };
  }
  if (cur) base.push(cur);

  // Overlap: each chunk after the first also carries the tail of the previous
  // one, so a fact stated across the boundary is seen whole by one call.
  const want = Math.round(maxChars * Math.min(0.3, Math.max(0, opts.overlap ?? 0)));
  return base.map((b, i) => {
    // Section mode never repeats context across a heading boundary.
    const sectionStart = sectionCuts.filter((n) => n <= b.start).at(-1) ?? 0;
    const floor = i === 0 ? b.start : Math.max(base[i - 1].start, sectionStart);
    const start = i === 0 || boundaries.has(b.start) ? b.start : opts.method === "fixed"
      ? Math.max(floor, b.start - want)
      : overlapStart(text, floor, b.start, want);
    const page = pageAt(pages, start);
    const pageEnd = pageAt(pages, Math.max(start, b.end - 1));
    const sectionPath = opts.sections?.length ? sectionPathAt(opts.sections, b.start) : undefined;
    return {
      ordinal: i,
      start,
      end: b.end,
      text: text.slice(start, b.end),
      ...(page !== undefined ? { page } : {}),
      ...(pageEnd !== undefined && pageEnd !== page ? { pageEnd } : {}),
      ...(sectionPath?.length ? { sectionPath } : {}),
      ...(b.start > start ? { overlap: b.start - start } : {}),
    };
  });
}
