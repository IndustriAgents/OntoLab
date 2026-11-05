// Server-side document parsing. Text is extracted once, at upload, and kept
// with page boundaries, section headings and table spans, so evidence can point
// at "page 4, section 3.2" and chunks carry the headings they sit under.
//
// Two parsers behind one interface:
//   - the Docling sidecar (sidecar/docling) when PARSER_URL is set: layout
//     analysis, reading order, real tables, OCR for scans and images;
//   - the built-in Node parsers otherwise: pdf.js (text per page, headings
//     guessed from font size), mammoth's HTML for DOCX (headings and tables
//     kept), Excel worksheets, HTML, Markdown and plain text.
// MinerU is deliberately not used: it is AGPL.

import { xmlText } from "./xmlText.ts";
import mammoth from "mammoth";
import type { DocumentKind, PageSpan, SectionSpan, TableSpan } from "../../src/types/project.ts";
import { HttpError } from "../http.ts";
import { PARSER_TIMEOUT_MS, PARSER_TOKEN, PARSER_URL } from "../config.ts";
import { htmlToBlocks, markdownStructure, serializeBlocks } from "./structuredText.ts";
import { spreadsheetText } from "./spreadsheetText.ts";

export interface ParsedDocument {
  version?: string;
  warnings?: string[];
  sourceSpans?: { start: number; end: number; path: string }[];
  kind: DocumentKind;
  mediaType: string;
  text: string;
  pages: PageSpan[];
  sections: SectionSpan[];
  tables: TableSpan[];
  parser: "node" | "docling";
  ocr: boolean;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|log)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const DOCLING_ONLY: Record<string, { kind: DocumentKind; mediaType: string }> = {
  pptx: { kind: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  tif: { kind: "image", mediaType: "image/tiff" },
  tiff: { kind: "image", mediaType: "image/tiff" },
};

export function detectKind(name: string, bytes: Buffer): { kind: DocumentKind; mediaType: string } {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mediaType: "application/pdf" };
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith(".docx") && zip)
    return { kind: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (ext === "xlsx" || ext === "xls")
    return {
      kind: ext,
      mediaType: ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.ms-excel",
    };
  if (DOCLING_ONLY[ext]) {
    if (!PARSER_URL)
      throw new HttpError(
        415,
        `${name}: ${ext.toUpperCase()} files need the Docling parser. Ask your administrator to set PARSER_URL, or upload PDF, DOCX, HTML, XML or text.`,
      );
    return DOCLING_ONLY[ext];
  }
  if (HTML_EXT.test(lower)) {
    if (bytes.subarray(0, 8192).includes(0)) throw new HttpError(415, `${name} does not look like an HTML file.`);
    return { kind: "html", mediaType: "text/html" };
  }
  if (lower.endsWith(".xml")) {
    if (bytes.subarray(0, 8192).includes(0)) throw new HttpError(415, `${name} must be UTF-8 XML text.`);
    return { kind: "text", mediaType: "application/xml" };
  }
  if (TEXT_EXT.test(lower)) {
    // Reject binaries that merely carry a text extension.
    if (bytes.subarray(0, 8192).includes(0)) throw new HttpError(415, `${name} does not look like a text file.`);
    return { kind: "text", mediaType: lower.endsWith(".md") || lower.endsWith(".markdown") ? "text/markdown" : "text/plain" };
  }
  throw new HttpError(
    415,
    `${name}: unsupported file type. Upload PDF, DOCX, XLSX, XLS, HTML, XML or plain-text (.txt, .md) files${PARSER_URL ? ", or PPTX and images" : ""}.`,
  );
}

/* ───────────────────────── PDF (pdf.js) ───────────────────────── */

interface PdfLine {
  text: string;
  height: number;
}

async function parsePdf(bytes: Buffer): Promise<{ text: string; pages: PageSpan[]; sections: SectionSpan[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true })
    .promise;
  try {
    let text = "";
    const pages: PageSpan[] = [];
    // Heading candidates: short lines set noticeably larger than body text.
    const lines: { start: number; end: number; line: PdfLine }[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Respect pdf.js line breaks so paragraphs survive for chunking.
      let pageText = "";
      const pageLines: PdfLine[] = [];
      let cur: PdfLine = { text: "", height: 0 };
      for (const it of content.items) {
        if (!("str" in it)) continue;
        pageText += it.str;
        cur.text += it.str;
        cur.height = Math.max(cur.height, Math.abs(it.height || it.transform?.[3] || 0));
        if (it.hasEOL) {
          pageText += "\n";
          pageLines.push(cur);
          cur = { text: "", height: 0 };
        } else {
          pageText += " ";
          cur.text += " ";
        }
      }
      if (cur.text.trim()) pageLines.push(cur);
      pageText = pageText
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      page.cleanup();
      if (text) text += "\n\n";
      const start = text.length;
      text += pageText;
      pages.push({ page: p, start, end: text.length });
      // Map each pdf.js line back onto the normalised page text.
      let at = start;
      for (const l of pageLines) {
        const norm = l.text.replace(/\s+/g, " ").trim();
        if (!norm) continue;
        const idx = text.indexOf(norm, at);
        if (idx < 0) continue;
        lines.push({ start: idx, end: idx + norm.length, line: { text: norm, height: l.height } });
        at = idx + norm.length;
      }
    }
    return { text, pages, sections: pdfSections(text, lines) };
  } finally {
    await doc.destroy();
  }
}

/** Headings from font size: lines at least 15% taller than the median body line, short and not sentence-like. */
export function pdfSections(text: string, lines: { start: number; end: number; line: PdfLine }[]): SectionSpan[] {
  const heights = lines
    .map((l) => l.line.height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (heights.length < 5) return [];
  const median = heights[Math.floor(heights.length / 2)];
  const candidates = lines.filter((l) => {
    const t = l.line.text;
    return (
      l.line.height >= median * 1.15 &&
      t.length >= 2 &&
      t.length <= 120 &&
      !/[.;,:]$/.test(t) &&
      !/@|https?:\/\//i.test(t) &&
      !/^k\s*eywords\b/i.test(t) &&
      /\p{L}/u.test(t)
    );
  });
  if (!candidates.length || candidates.length > lines.length / 3) return [];
  // A publication title often wraps across adjacent lines of the same size.
  // Keep those lines in one section so chunking never presents a title fragment
  // as a separate document identity. Do not join numbered sections or pages.
  const first = { ...candidates[0] };
  candidates[0] = first;
  if (first.start === 0) {
    while (candidates.length > 1) {
      const next = candidates[1];
      if (
        Math.abs(first.line.height - next.line.height) > 0.5 ||
        !/^[ \t]*\n[ \t]*$/.test(text.slice(first.end, next.start)) ||
        /^\s*(?:\d+[.)]?|[IVX]+\.)\s/.test(next.line.text) ||
        first.line.text.length + next.line.text.length > 300
      )
        break;
      first.line = { ...first.line, text: `${first.line.text} ${next.line.text}` };
      first.end = next.end;
      candidates.splice(1, 1);
    }
  }
  // Bigger type = higher level.
  const sizes = [...new Set(candidates.map((c) => Math.round(c.line.height * 2) / 2))].sort((a, b) => b - a).slice(0, 4);
  const sections: SectionSpan[] = [];
  const open: SectionSpan[] = [];
  for (const c of candidates) {
    const size = Math.round(c.line.height * 2) / 2;
    const level = Math.max(1, sizes.indexOf(size) + 1 || sizes.length);
    while (open.length && open[open.length - 1].level >= level) open.pop()!.end = c.start;
    const sec: SectionSpan = { level, title: c.line.text, path: [...open.map((s) => s.title), c.line.text], start: c.start, end: -1 };
    sections.push(sec);
    open.push(sec);
  }
  for (const s of sections) if (s.end < 0) s.end = text.length;
  return sections;
}

/* ───────────────────────── Docling sidecar ───────────────────────── */

interface DoclingResponse {
  text?: string;
  pages?: PageSpan[];
  sections?: SectionSpan[];
  tables?: TableSpan[];
  ocr?: boolean;
  error?: string;
}

const isSpan = (s: { start?: unknown; end?: unknown }, max: number) =>
  Number.isInteger(s.start) &&
  Number.isInteger(s.end) &&
  (s.start as number) >= 0 &&
  (s.end as number) <= max &&
  (s.start as number) <= (s.end as number);

export async function parseWithDocling(name: string, bytes: Buffer, url = PARSER_URL): Promise<Omit<ParsedDocument, "kind" | "mediaType">> {
  let res: Response;
  try {
    res = await fetch(`${url}/parse`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        ...(PARSER_TOKEN ? { "x-token": PARSER_TOKEN } : {}),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(PARSER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(
      503,
      `The document parser is unreachable (${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "connection failed"}). Retry the upload later.`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as DoclingResponse;
  if (!res.ok) {
    if (res.status === 415) throw new HttpError(415, `${name}: the parser does not support this file type.`);
    throw new HttpError(422, `Could not read ${name}: ${body.error ?? `parser error ${res.status}`}`);
  }
  const text = typeof body.text === "string" ? body.text : "";
  // Never trust offsets blindly: a span outside the text would break evidence.
  const keep = <T extends { start?: unknown; end?: unknown }>(list: T[] | undefined) =>
    Array.isArray(list) ? list.filter((s) => isSpan(s, text.length)) : [];
  return {
    text,
    pages: keep(body.pages),
    sections: keep(body.sections).map((s) => ({ ...s, path: Array.isArray(s.path) ? s.path.map(String) : [String(s.title)] })),
    tables: keep(body.tables),
    parser: "docling",
    ocr: !!body.ocr,
  };
}

/* ───────────────────────── entry point ───────────────────────── */

export async function parseDocument(name: string, bytes: Buffer): Promise<ParsedDocument> {
  const { kind, mediaType } = detectKind(name, bytes);

  // Workbooks use the same deterministic parser with or without the sidecar.
  if (kind === "xlsx" || kind === "xls") return { kind, mediaType, ...spreadsheetText(name, bytes), parser: "node", ocr: false };

  if (mediaType === "application/xml") {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n");
    return { kind, mediaType, ...xmlText(text), parser: "node", ocr: false };
  }

  // Remaining non-text formats prefer Docling when present.
  if (PARSER_URL && kind !== "text") return { kind, mediaType, ...(await parseWithDocling(name, bytes)) };

  if (kind === "pdf") {
    try {
      const pdf = await parsePdf(bytes);
      return { kind, mediaType, ...pdf, tables: [], parser: "node", ocr: false };
    } catch (e) {
      throw new HttpError(422, `Could not read ${name}: ${e instanceof Error ? e.message : "invalid PDF"}`);
    }
  }
  if (kind === "docx") {
    try {
      const html = (await mammoth.convertToHtml({ buffer: bytes })).value;
      const st = serializeBlocks(htmlToBlocks(html));
      if (st.text.trim()) return { kind, mediaType, ...st, pages: [], parser: "node", ocr: false };
      // Documents mammoth cannot map to HTML still have raw text.
      const raw = (await mammoth.extractRawText({ buffer: bytes })).value.replace(/\r\n/g, "\n").trim();
      return { kind, mediaType, text: raw, pages: [], sections: [], tables: [], parser: "node", ocr: false };
    } catch {
      throw new HttpError(422, `Could not read ${name}. Is it a valid .docx file?`);
    }
  }
  if (kind === "html") {
    const st = serializeBlocks(htmlToBlocks(bytes.toString("utf8")));
    return { kind, mediaType, ...st, pages: [], parser: "node", ocr: false };
  }
  const text = bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  return {
    kind,
    mediaType,
    text,
    pages: [],
    ...(mediaType === "application/xml" ? { sections: [], tables: [] } : markdownStructure(text)),
    parser: "node",
    ocr: false,
  };
}
