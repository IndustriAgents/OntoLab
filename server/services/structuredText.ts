// Layout-aware text: a reading-ordered list of blocks (headings, paragraphs,
// list items, tables) serialised to Markdown-like text with exact spans for
// sections and tables. The built-in parsers (DOCX via mammoth's HTML, HTML,
// Markdown) produce blocks; the Docling sidecar returns the same shape
// (sidecar/docling/serialize.py), so chunking and evidence offsets behave the
// same whichever parser ran.

import type { PageSpan, SectionSpan, TableSpan } from "../../src/types/project.ts";

export interface Block {
  kind: "heading" | "paragraph" | "list_item" | "table";
  text: string;
  level?: number;
  page?: number;
  /** tables only: rendered as a pipe table, first row the header */
  rows?: string[][];
}

export interface StructuredText {
  text: string;
  pages: PageSpan[];
  sections: SectionSpan[];
  tables: TableSpan[];
}

const SEP = "\n\n";
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const multiLine = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]*\n+/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

export function tableToMarkdown(rows: string[][]): string {
  const grid = rows.map((r) => r.map((c) => oneLine(c).replace(/\|/g, "\\|"))).filter((r) => r.length);
  if (!grid.length || !grid.some((r) => r.some(Boolean))) return "";
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)].join("\n");
}

function render(b: Block): { body: string; level?: number } | null {
  if (b.kind === "heading") {
    const title = oneLine(b.text);
    if (!title) return null;
    const level = Math.min(6, Math.max(1, b.level ?? 1));
    return { body: `${"#".repeat(level)} ${title}`, level };
  }
  if (b.kind === "table") {
    const body = b.rows ? tableToMarkdown(b.rows) : multiLine(b.text);
    return body ? { body } : null;
  }
  const body = multiLine(b.text);
  if (!body) return null;
  return b.kind === "list_item" ? { body: `- ${body.replace(/^[-*•]\s+/, "").replace(/\n/g, "\n  ")}` } : { body };
}

export function serializeBlocks(blocks: Block[]): StructuredText {
  let text = "";
  const sections: SectionSpan[] = [];
  const tables: TableSpan[] = [];
  const pageOf: { start: number; end: number; page?: number }[] = [];
  const open: SectionSpan[] = [];

  for (const b of blocks) {
    const r = render(b);
    if (!r) continue;
    if (text) text += SEP;
    const start = text.length;
    text += r.body;
    const end = text.length;
    pageOf.push({ start, end, page: b.page });
    if (r.level) {
      // Close every open section at the same or a deeper level.
      while (open.length && open[open.length - 1].level >= r.level) open.pop()!.end = start;
      const title = r.body.slice(r.level + 1);
      const sec: SectionSpan = { level: r.level, title, path: [...open.map((s) => s.title), title], start, end: -1 };
      sections.push(sec);
      open.push(sec);
    } else if (b.kind === "table") {
      tables.push({ start, end, ...(b.page ? { page: b.page } : {}) });
    }
  }
  if (text) text += "\n";
  for (const s of sections) if (s.end < 0) s.end = text.length;

  // Pages: contiguous spans in reading order; a block without a page joins the previous page.
  const pages: PageSpan[] = [];
  let current: number | undefined;
  for (const p of pageOf) {
    if (p.page && (current === undefined || p.page > current)) current = p.page;
    if (current === undefined) continue;
    const last = pages[pages.length - 1];
    if (last && last.page === current) last.end = p.end;
    else {
      if (last) last.end = p.start;
      pages.push({ page: current, start: pages.length ? p.start : 0, end: p.end });
    }
  }
  if (pages.length) pages[pages.length - 1].end = text.length;
  return { text, pages, sections, tables };
}

/* ───────────────────────── Markdown / plain text ───────────────────────── */

/** Sections and pipe tables of Markdown-ish text, without changing the text. */
export function markdownStructure(text: string): Pick<StructuredText, "sections" | "tables"> {
  const sections: SectionSpan[] = [];
  const tables: TableSpan[] = [];
  const open: SectionSpan[] = [];
  const lineRe = /^.*$/gm;
  let m: RegExpExecArray | null;
  let tableStart = -1;
  let tableEnd = -1;
  let inFence = false;
  while ((m = lineRe.exec(text))) {
    const line = m[0];
    const start = m.index;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      while (open.length && open[open.length - 1].level >= level) open.pop()!.end = start;
      const sec: SectionSpan = { level, title: h[2], path: [...open.map((s) => s.title), h[2]], start, end: -1 };
      sections.push(sec);
      open.push(sec);
    }
    const isRow = !inFence && /^\s*\|.*\|\s*$/.test(line);
    if (isRow) {
      if (tableStart < 0) tableStart = start;
      tableEnd = start + line.length;
    } else if (tableStart >= 0) {
      tables.push({ start: tableStart, end: tableEnd });
      tableStart = -1;
    }
    if (m.index === lineRe.lastIndex) lineRe.lastIndex++;
  }
  if (tableStart >= 0) tables.push({ start: tableStart, end: tableEnd });
  for (const s of sections) if (s.end < 0) s.end = text.length;
  return { sections, tables: tables.filter((t) => text.slice(t.start, t.end).split("\n").length >= 2) };
}

/* ───────────────────────── HTML (and DOCX via mammoth's HTML) ───────────────────────── */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", deg: "°" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t\f\v\u00a0]+/g, " ");

/**
 * Blocks from HTML: headings, paragraphs, list items and tables in document
 * order. Deliberately small (no DOM): good enough for mammoth's clean HTML and
 * ordinary web pages; scripts, styles and navigation chrome are dropped.
 */
export function htmlToBlocks(html: string): Block[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style)\b[^>]*\/>/gi, "");
  const blocks: Block[] = [];
  const re = /<(h[1-6]|p|li|table|pre|blockquote|dt|dd|caption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (tag === "table") {
      const rows: string[][] = [];
      for (const tr of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        rows.push([...tr[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => stripTags(c[2])));
      }
      if (rows.length) blocks.push({ kind: "table", text: "", rows });
      continue;
    }
    // A paragraph wrapping nested block elements is handled by its children.
    if (/<(table|h[1-6]|li)\b/i.test(inner)) {
      blocks.push(...htmlToBlocks(inner));
      continue;
    }
    const text = stripTags(inner).trim();
    if (!text) continue;
    if (tag[0] === "h") blocks.push({ kind: "heading", text, level: Number(tag[1]) });
    else if (tag === "li") blocks.push({ kind: "list_item", text });
    else blocks.push({ kind: "paragraph", text });
  }
  // Pages that keep text in bare <div>s: fall back to their text.
  if (!blocks.length) {
    const text = stripTags(body.replace(/<\/(div|section|article|tr|br)>/gi, "\n\n")).trim();
    for (const para of text.split(/\n\s*\n/)) if (para.trim()) blocks.push({ kind: "paragraph", text: para.trim() });
  }
  return blocks;
}
