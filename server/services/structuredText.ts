// Layout-aware text: a reading-ordered list of blocks (headings, paragraphs,
// list items, tables) serialised to Markdown-like text with exact spans for
// sections and tables. The built-in parsers (DOCX via mammoth's HTML, HTML,
// Markdown) produce blocks; the Docling sidecar returns the same shape
// (sidecar/docling/serialize.py), so chunking and evidence offsets behave the
// same whichever parser ran.

import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from "parse5";
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
  const grid = rows.map((r) => r.map((c) => oneLine(c).replace(/[\\|]/g, "\\$&"))).filter((r) => r.length);
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

type HtmlNode = DefaultTreeAdapterTypes.Node;

const { isElementNode, isTextNode } = defaultTreeAdapter;
const OMITTED_TAGS = new Set(["script", "style", "noscript", "template", "svg", "head", "nav", "footer"]);
const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "table", "pre", "blockquote", "dt", "dd", "caption"]);
const FALLBACK_BREAKS = new Set(["div", "section", "article", "tr"]);

function* htmlNodes(root: HtmlNode, descend: (node: HtmlNode) => boolean = () => true): Iterable<HtmlNode> {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElementNode(node) && OMITTED_TAGS.has(node.tagName)) continue;
    yield node;
    if ("childNodes" in node && descend(node)) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
  }
}

function htmlText(root: HtmlNode, fallback = false): string {
  const parts: string[] = [];
  for (const node of htmlNodes(root)) {
    if (isTextNode(node)) parts.push(node.value);
    else if (isElementNode(node) && node.tagName === "br") parts.push("\n");
    else if (fallback && isElementNode(node) && FALLBACK_BREAKS.has(node.tagName)) parts.push("\n\n");
  }
  return parts
    .join("")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .trim();
}

function htmlTable(table: DefaultTreeAdapterTypes.Element): string[][] {
  const rows: string[][] = [];
  for (const row of htmlNodes(table, (node) => node === table || !isElementNode(node) || node.tagName !== "table")) {
    if (!isElementNode(row) || row.tagName !== "tr") continue;
    const cells = row.childNodes.filter((node) => isElementNode(node) && (node.tagName === "td" || node.tagName === "th"));
    if (cells.length) rows.push(cells.map((cell) => htmlText(cell)));
  }
  return rows;
}

/** Extract text blocks from an inert HTML tree. This output is text, not sanitized HTML. */
export function htmlToBlocks(html: string): Block[] {
  const document = parse(html);
  const blocks: Block[] = [];
  for (const node of htmlNodes(document, (node) => !isElementNode(node) || !BLOCK_TAGS.has(node.tagName))) {
    if (!isElementNode(node) || !BLOCK_TAGS.has(node.tagName)) continue;
    const tag = node.tagName;
    if (tag === "table") {
      const rows = htmlTable(node);
      if (rows.length) blocks.push({ kind: "table", text: "", rows });
      continue;
    }
    const text = htmlText(node);
    if (!text) continue;
    if (tag[0] === "h") blocks.push({ kind: "heading", text, level: Number(tag[1]) });
    else if (tag === "li") blocks.push({ kind: "list_item", text });
    else blocks.push({ kind: "paragraph", text });
  }
  if (!blocks.length) {
    for (const para of htmlText(document, true).split(/\n\s*\n/)) {
      if (para.trim()) blocks.push({ kind: "paragraph", text: para.trim() });
    }
  }
  return blocks;
}
