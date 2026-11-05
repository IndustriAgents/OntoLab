// Client-side document ingestion: extract text from .txt / .pdf / .docx and,
// for PDFs, keep the bytes so the user can optionally send the PDF as a vision
// document for diagram-heavy sheets (e.g. GRAFCET).
//
// pdf.js is imported dynamically: it and its worker are ~1.4 MB, and most
// sessions never open a PDF at all.

import type { ExtractDoc } from "../types/abox";
import { parseDoc } from "./api";
import { uid } from "./format";

/** Files above this size are refused with a clear message rather than hanging the tab. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface DocEntry {
  id: string;
  name: string;
  kind: "pdf" | "text";
  sizeBytes: number;
  text: string;
  /** base64 PDF bytes (PDFs only; dropped when a session is restored) */
  pdfBase64?: string;
  /** send to the model as a vision document instead of (or with) extracted text */
  asVision: boolean;
}

function readText(file: File): Promise<string> {
  return file.text();
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to stay well under the argument-count limit for large PDFs.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  // pdf.js takes ownership of the buffer it is given, so hand it a copy and keep ours.
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const line = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      page.cleanup();
      if (line) parts.push(`[Page ${p}] ${line}`);
    }
    return parts.join("\n\n");
  } finally {
    // Without this the worker keeps the whole document alive per upload.
    await pdf.destroy();
  }
}

export async function fileToDocEntry(file: File): Promise<DocEntry> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`too large — ${Math.round(file.size / 1e6)} MB, limit ${Math.round(MAX_FILE_BYTES / 1e6)} MB`);
  }
  const id = uid("doc");
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".docx")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text } = await parseDoc({ name: file.name, base64: bytesToBase64(bytes) });
    return { id, name: file.name, kind: "text", sizeBytes: file.size, text, asVision: false };
  }

  const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
  if (isPdf) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = await extractPdfText(bytes);
    // Kept so "Vision" can send the original PDF; encoded once here rather than
    // holding both an ArrayBuffer and a base64 string per file.
    return { id, name: file.name, kind: "pdf", sizeBytes: file.size, text, pdfBase64: bytesToBase64(bytes), asVision: false };
  }

  return { id, name: file.name, kind: "text", sizeBytes: file.size, text: await readText(file), asVision: false };
}

export function toExtractDoc(d: DocEntry): ExtractDoc {
  const vision = d.asVision && d.kind === "pdf" && !!d.pdfBase64;
  return {
    name: d.name,
    text: d.text,
    asVision: vision,
    pdfBase64: vision ? d.pdfBase64 : undefined,
  };
}
