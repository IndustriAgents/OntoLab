// Documents: private upload, parse + chunk (with overlap and section paths),
// preview, retry, removal.
//
// The original bytes go to private object storage under a stable id with their
// sha256; extracted text and chunks (with offsets and pages) go to the database.
// A parse failure is recorded on that document only — it never discards other
// uploads, and the original stays so the parse can be retried.

import { randomUUID, createHash } from "node:crypto";
import type { DocumentChunk, DocumentText, ProjectDocument } from "../../src/types/project.ts";
import type { ChunkSettings } from "../../src/types/research.ts";
import { HttpError } from "../http.ts";
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  PARSER_TIMEOUT_MS,
  MAX_DOCUMENTS_PER_PROJECT,
  MAX_UPLOAD_BYTES,
  STORAGE_QUOTA_BYTES,
} from "../config.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject, touchProject } from "./projects.ts";
import { detectKind, parseDocument } from "./parsing.ts";
import { buildTokenChunks } from "./tokenChunking.ts";
import { chunkText } from "./chunking.ts";

const SAFE_NAME = /[^\p{L}\p{N} ._()-]+/gu;

export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document";
  return base.replace(SAFE_NAME, "_").slice(0, 200) || "document";
}

export async function requireDocument(ctx: ServiceCtx, projectId: string, id: string): Promise<ProjectDocument> {
  const doc = await ctx.store.documents.get(projectId, id).catch(() => null);
  if (!doc) throw new HttpError(404, "Document not found.");
  return doc;
}

export async function listDocuments(ctx: ServiceCtx, projectId: string): Promise<ProjectDocument[]> {
  await requireProject(ctx, projectId);
  return ctx.store.documents.list(projectId);
}

async function parseAndStore(
  ctx: ServiceCtx,
  doc: ProjectDocument,
  bytes: Buffer,
  chunking?: ChunkSettings,
  holder?: string,
  initialChunks = true,
): Promise<ProjectDocument | null> {
  const started = Date.now();
  try {
    const parsed = await parseDocument(doc.name, bytes);
    const settings = chunking ??
      doc.preprocessing?.settings ?? { method: "paragraph" as const, maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP };
    const pieces = !(chunking || (!holder && initialChunks))
      ? []
      : settings.unit === "tokens"
        ? (await buildTokenChunks(parsed, settings)).chunks
        : chunkText(parsed.text, parsed.pages, settings.maxChars, { ...settings, sections: parsed.sections });
    const chunks: DocumentChunk[] = pieces.map((c) => ({
      id: `${doc.id}_c${c.ordinal}`,
      documentId: doc.id,
      projectId: doc.projectId,
      ...c,
    }));
    const output = {
      text: { text: parsed.text, pages: parsed.pages, sections: parsed.sections, tables: parsed.tables, sourceSpans: parsed.sourceSpans },
      chunks,
    };
    const hash = createHash("sha256").update(parsed.text).digest("hex");
    const patch: Partial<ProjectDocument> = {
      kind: parsed.kind,
      parseState: "parsed",
      parseError: "",
      processing: null,
      parsing: {
        version: parsed.version ?? `${parsed.parser}-${parsed.kind}-v1`,
        sourceHash: doc.checksum,
        textHash: hash,
        createdAt: iso(ctx.now()),
        warnings: [
          ...(parsed.warnings ?? []),
          ...(!parsed.text.trim() ? ["No readable text found. For scanned files, enable an OCR parser and reprocess the original."] : []),
        ],
      },
      pageCount: parsed.pages.length,
      charCount: parsed.text.length,
      chunkCount: chunks.length,
      parser: parsed.parser,
      sectionCount: parsed.sections.length,
      tableCount: parsed.tables.length,
      ocr: parsed.ocr,
      preprocessing: !chunks.length
        ? null
        : {
            version: settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1",
            settings,
            textHash: hash,
            createdAt: iso(ctx.now()),
            durationMs: Date.now() - started,
          },
    };
    let updated: ProjectDocument | null;
    if (holder) updated = await ctx.store.documents.finishProcessing!(doc.projectId, doc.id, holder, patch, output);
    else {
      await ctx.store.documents.putText(doc.projectId, doc.id, output.text, chunks);
      updated = await ctx.store.documents.update(doc.projectId, doc.id, patch);
    }
    ctx.log.info("document.parsed", {
      requestId: ctx.requestId,
      projectId: doc.projectId,
      documentId: doc.id,
      chunks: chunks.length,
      ms: Date.now() - started,
    });
    return updated;
  } catch (e) {
    const message = e instanceof HttpError ? e.message : "The file could not be read.";
    ctx.log.warn("document.parse_failed", {
      requestId: ctx.requestId,
      projectId: doc.projectId,
      documentId: doc.id,
      ms: Date.now() - started,
    });
    const patch = { parseState: "failed" as const, parseError: message, processing: null };
    return holder
      ? ctx.store.documents.finishProcessing!(doc.projectId, doc.id, holder, patch)
      : ctx.store.documents.update(doc.projectId, doc.id, patch);
  }
}

export async function uploadDocument(
  ctx: ServiceCtx,
  projectId: string,
  rawName: string,
  bytes: Buffer,
  options: { chunking?: ChunkSettings; allowDuplicate?: boolean; deferParsing?: boolean; variantOf?: string } = {},
): Promise<ProjectDocument> {
  const project = await requireProject(ctx, projectId);
  const name = sanitizeName(rawName);
  if (!bytes.length) throw new HttpError(400, `${name} is empty.`);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      `${name} is ${(bytes.length / 1e6).toFixed(1)} MB — the limit is ${Math.round(MAX_UPLOAD_BYTES / 1e6)} MB per file.`,
    );
  }
  const existing = await ctx.store.documents.list(projectId);
  if (!project.settings.corpus && existing.length >= MAX_DOCUMENTS_PER_PROJECT) {
    throw new HttpError(
      409,
      `This project already has ${existing.length} documents — the limit is ${MAX_DOCUMENTS_PER_PROJECT}. Remove some before adding more.`,
    );
  }
  const { kind, mediaType } = detectKind(name, bytes);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const dup = existing.find((d) => d.checksum === checksum);
  if (dup && !options.allowDuplicate) throw new HttpError(409, `${name} is identical to “${dup.name}”, which is already in this project.`);

  const usage = await ctx.store.usage();
  // Originals plus roughly the same again for extracted text and chunks.
  if (usage.usedBytes + bytes.length * 2 > STORAGE_QUOTA_BYTES) {
    throw new HttpError(
      507,
      `Storage quota exceeded: ${(usage.usedBytes / 1e6).toFixed(1)} of ${Math.round(STORAGE_QUOTA_BYTES / 1e6)} MB used. Delete documents or projects, or export and remove old projects.`,
    );
  }

  const id = newId("doc");
  const storagePath = `${projectId}/documents/${id}`;
  await ctx.store.blobs.put(storagePath, bytes, mediaType);
  let doc: ProjectDocument = {
    id,
    projectId,
    ownerId: ctx.user.id,
    name,
    mediaType,
    kind,
    sizeBytes: bytes.length,
    checksum,
    storagePath,
    parseState: "pending",
    processing: { stage: "queued", settings: options.chunking },
    variantOf: options.variantOf,
    charCount: 0,
    chunkCount: 0,
    createdAt: iso(ctx.now()),
  };
  try {
    doc = await ctx.store.documents.create(doc);
  } catch (e) {
    await ctx.store.blobs.delete(storagePath).catch(() => {});
    throw e;
  }
  ctx.log.info("document.uploaded", { requestId: ctx.requestId, projectId, documentId: id, bytes: bytes.length });
  if (!options.deferParsing || !ctx.store.documents.claimProcessing)
    doc = (await parseAndStore(ctx, doc, bytes, options.chunking, undefined, !options.deferParsing))!;
  await touchProject(ctx, projectId);
  return doc;
}

export async function retryParse(ctx: ServiceCtx, projectId: string, id: string, deferParsing = false): Promise<ProjectDocument> {
  const doc = await requireDocument(ctx, projectId, id);
  if ((await ctx.store.runs.list(projectId)).some((r) => r.documentIds.includes(id))) {
    throw new HttpError(409, "This document is an input to a saved run. Save a chunking variant in Research to preserve its history.");
  }
  if (doc.parseState === "pending") throw new HttpError(409, "This document is already queued or parsing.");
  if (doc.parseState === "parsed" && (await requireProject(ctx, projectId)).settings.corpus)
    throw new HttpError(409, "Reparse this source as a new version from the corpus. Existing parsed versions are immutable.");
  const bytes = await ctx.store.blobs.get(doc.storagePath);
  if (!bytes) throw new HttpError(410, "The original file is no longer in storage — remove the document and upload it again.");
  if (deferParsing && ctx.store.documents.claimProcessing)
    return ctx.store.documents.update(projectId, id, {
      parseState: "pending",
      parseError: "",
      processing: { stage: "queued", settings: doc.preprocessing?.settings },
    });
  return (await parseAndStore(ctx, doc, bytes, undefined, undefined, !deferParsing))!;
}

export async function removeDocument(ctx: ServiceCtx, projectId: string, id: string): Promise<void> {
  if ((await requireProject(ctx, projectId)).settings.corpus)
    throw new HttpError(409, "Remove this source from the corpus instead. Its file versions are retained for historical evidence.");
  const doc = await requireDocument(ctx, projectId, id);
  const runs = await ctx.store.runs.list(projectId);
  const busy = runs.find(
    (r) => (r.status === "running" || r.status === "queued" || r.status === "awaiting_answers") && r.documentIds.includes(id),
  );
  if (busy) throw new HttpError(409, "This document is used by an active run. Cancel the run first.");
  await ctx.store.documents.delete(projectId, id);
  await ctx.store.blobs.delete(doc.storagePath).catch(() => {});
  ctx.log.info("document.removed", { requestId: ctx.requestId, projectId, documentId: id });
}

export async function documentText(ctx: ServiceCtx, projectId: string, id: string): Promise<DocumentText> {
  await requireDocument(ctx, projectId, id);
  const text = await ctx.store.documents.getText(projectId, id);
  if (!text) throw new HttpError(409, "This document has not been parsed.");
  const chunks = await ctx.store.documents.chunks(projectId, [id]);
  return {
    documentId: id,
    textHash: createHash("sha256").update(text.text).digest("hex"),
    text: text.text,
    pages: text.pages,
    sections: text.sections ?? [],
    tables: text.tables ?? [],
    sourceSpans: text.sourceSpans,
    chunks: chunks.map(({ text: _t, projectId: _p, ...rest }) => rest),
  };
}

export async function documentFile(ctx: ServiceCtx, projectId: string, id: string): Promise<{ bytes: Buffer; doc: ProjectDocument }> {
  const doc = await requireDocument(ctx, projectId, id);
  const bytes = await ctx.store.blobs.get(doc.storagePath);
  if (!bytes) throw new HttpError(410, "The original file is no longer in storage.");
  return { bytes, doc };
}

/** Lease protects against concurrent workers, stale completions and deleted documents. */
export async function processDocument(ctx: ServiceCtx, projectId: string, id: string): Promise<ProjectDocument | null> {
  if (!ctx.store.documents.claimProcessing) return null;
  const now = ctx.now();
  const holder = randomUUID();
  const doc = await ctx.store.documents.claimProcessing(
    projectId,
    id,
    holder,
    iso(new Date(now.getTime() + Math.max(600_000, PARSER_TIMEOUT_MS * 2))),
    iso(now),
  );
  if (!doc) return null;
  const bytes = await ctx.store.blobs.get(doc.storagePath);
  if (!bytes)
    return ctx.store.documents.finishProcessing!(projectId, id, holder, {
      parseState: "failed",
      parseError: "The original file is no longer in storage.",
    });
  return parseAndStore(ctx, doc, bytes, doc.processing?.settings, holder);
}

/** Reparse into a new document; runs and evidence keep their original input. */
export async function reprocessDocument(ctx: ServiceCtx, projectId: string, id: string): Promise<ProjectDocument> {
  await requireProject(ctx, projectId);
  const doc = await requireDocument(ctx, projectId, id);
  const bytes = await ctx.store.blobs.get(doc.storagePath);
  if (!bytes) throw new HttpError(410, "The original file is no longer in storage.");
  return uploadDocument(ctx, projectId, doc.name, bytes, {
    deferParsing: true,
    allowDuplicate: true,
    variantOf: doc.variantOf ?? doc.id,
    chunking: doc.preprocessing?.settings,
  });
}
