import { randomUUID, createHash } from "node:crypto";
import type { ChunkExperiment, ChunkSettings, ResearchInputs, RunResearch } from "../../src/types/research.ts";
import type { ExtractionRun, ProjectDocument, DocumentChunk } from "../../src/types/project.ts";
import { chunkMetrics, chunkSettingsKey } from "../../src/lib/research.ts";
import { CHUNK_CHARS, CHUNK_OVERLAP, MAX_DOCUMENTS_PER_PROJECT, STORAGE_QUOTA_BYTES } from "../config.ts";
import { HttpError } from "../http.ts";
import { iso, type ServiceCtx } from "./context.ts";
import { requireProject, touchProject } from "./projects.ts";
import { requireDocument } from "./documents.ts";
import { buildTokenChunks, validateTokenSettings } from "./tokenChunking.ts";
import { embeddingProfiles } from "../ml/tokenization.ts";
import { chunkText, sectionPathAt } from "./chunking.ts";
import type { StoredDocumentText } from "../store/types.ts";
import { chunkCoverage } from "../../src/lib/chunkCoverage.ts";

const preprocessingVersion = (settings: ChunkSettings) => (settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1");

// Coalesce previews and saves within this server, and bound the transient preview cache.
const previews = new Map<string, { value: ChunkExperiment; bytes: number; expires: number }>();
const previewing = new Map<string, Promise<ChunkExperiment>>();
const saving = new Map<string, Promise<ProjectDocument>>();
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
let previewBytes = 0;

function sourceKey(doc: ProjectDocument, text: StoredDocumentText): string {
  return JSON.stringify([
    doc.checksum,
    doc.parser,
    doc.parsing?.version,
    textHash(text.text),
    text.pages.map((p) => [p.page, p.start, p.end]),
    text.sections?.map((s) => [s.start, s.end, s.level, s.title, s.path]),
  ]);
}

async function savedChunks(ctx: ServiceCtx, pid: string, doc: ProjectDocument, text: StoredDocumentText, settings: ChunkSettings) {
  const hash = textHash(text.text);
  const candidates = [doc, ...(await ctx.store.documents.list(pid)).filter((d) => d.id !== doc.id)];
  for (const candidate of candidates) {
    const record = candidate.preprocessing;
    if (
      candidate.parseState !== "parsed" ||
      !candidate.chunkCount ||
      (candidate.variantOf ?? candidate.id) !== (doc.variantOf ?? doc.id) ||
      !record ||
      record.version !== preprocessingVersion(settings) ||
      record.textHash !== hash ||
      chunkSettingsKey(record.settings) !== chunkSettingsKey(settings)
    )
      continue;
    const savedText = candidate.id === doc.id ? text : await ctx.store.documents.getText(pid, candidate.id);
    if (!savedText || sourceKey(candidate, savedText) !== sourceKey(doc, text)) continue;
    const chunks = await ctx.store.documents.chunks(pid, [candidate.id]);
    const tokenMetadataChanged =
      settings.unit === "tokens" &&
      chunks.some(
        (c) =>
          c.page !== text.pages.find((p) => c.start >= p.start && c.start < p.end)?.page ||
          c.pageEnd !== text.pages.find((p) => c.end - 1 >= p.start && c.end - 1 < p.end)?.page ||
          JSON.stringify(c.sectionPath ?? []) !== JSON.stringify(sectionPathAt(text.sections ?? [], c.start) ?? []),
      );
    if (
      chunks.length !== candidate.chunkCount ||
      chunks.some((c) => c.start < 0 || c.end > text.text.length || c.end <= c.start || c.text !== text.text.slice(c.start, c.end)) ||
      tokenMetadataChanged ||
      (settings.unit === "tokens" && (chunks.some((c) => !c.tokenization) || !chunkCoverage(chunks, text.text.length).complete))
    )
      continue;
    return { document: candidate, chunks };
  }
  return null;
}

function storedPreview(
  did: string,
  settings: ChunkSettings,
  hash: string,
  saved: NonNullable<Awaited<ReturnType<typeof savedChunks>>>,
): ChunkExperiment {
  const chunks = saved.chunks.map((c) => ({ ...c, id: `${did}_preview${c.ordinal}`, documentId: did }));
  const first = chunks[0]?.tokenization;
  return {
    settings,
    textHash: hash,
    chunks,
    metrics: chunkMetrics(chunks),
    reusedDocumentId: saved.document.id,
    ...(first
      ? {
          tokenization: {
            generation: { ...first.generation, count: chunks.reduce((n, c) => n + c.tokenization!.generation.count, 0) },
            embedding: {
              ...first.embedding,
              count: chunks.reduce((n, c) => n + c.tokenization!.embeddingPassages.reduce((a, p) => a + p.tokens, 0), 0),
            },
            embeddingPassages: chunks.reduce((n, c) => n + c.tokenization!.embeddingPassages.length, 0),
            fullCoverage: true,
          },
        }
      : {}),
  };
}

export const chunkDefaults = (): ChunkSettings => ({ method: "paragraph", maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP });
export const chunkModels = () => ({ embeddings: embeddingProfiles() });
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function validateChunkSettings(input: unknown): ChunkSettings {
  if (!input || typeof input !== "object") throw new HttpError(400, "Chunk settings are required.");
  const s = input as ChunkSettings;
  if (s.unit !== undefined && !["tokens", "characters"].includes(s.unit)) throw new HttpError(400, "Unknown chunk size unit.");
  if (!["paragraph", "section", "fixed"].includes(s.method)) throw new HttpError(400, "Unknown chunking method.");
  if (!Number.isInteger(s.maxChars) || s.maxChars < 200 || s.maxChars > 60_000)
    throw new HttpError(400, "Chunk size must be an integer from 200 to 60,000 characters.");
  if (typeof s.overlap !== "number" || !Number.isFinite(s.overlap) || s.overlap < 0 || s.overlap > 0.3)
    throw new HttpError(400, "Overlap must be between 0 and 0.30.");
  return {
    method: s.method,
    maxChars: s.maxChars,
    overlap: s.overlap,
    ...(s.unit === "tokens" ? { unit: "tokens", tokens: validateTokenSettings(s.tokens!) } : {}),
  };
}

export async function previewChunks(ctx: ServiceCtx, pid: string, did: string, input: unknown): Promise<ChunkExperiment> {
  await requireProject(ctx, pid);
  const doc = await requireDocument(ctx, pid, did);
  if (doc.parseState !== "parsed") throw new HttpError(409, "Parse this document before experimenting with chunks.");
  const settings = validateChunkSettings(input);
  const text = await ctx.store.documents.getText(pid, did);
  if (!text) throw new HttpError(409, "Parse this document before experimenting with chunks.");
  const saved = await savedChunks(ctx, pid, doc, text, settings);
  if (saved) return storedPreview(did, settings, textHash(text.text), saved);
  const key = JSON.stringify([ctx.user.id, pid, did, sourceKey(doc, text), chunkSettingsKey(settings)]);
  const cached = previews.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const pending = previewing.get(key);
  if (pending) return pending;
  const computing = computePreview(pid, did, text, settings);
  previewing.set(key, computing);
  try {
    const value = await computing;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes <= MAX_PREVIEW_BYTES) {
      for (const [id, entry] of previews) {
        if (id === key || entry.expires <= Date.now() || previews.size >= 32 || previewBytes + bytes > MAX_PREVIEW_BYTES) {
          previews.delete(id);
          previewBytes -= entry.bytes;
        }
      }
      previews.set(key, { value, bytes, expires: Date.now() + 5 * 60_000 });
      previewBytes += bytes;
    }
    return value;
  } finally {
    previewing.delete(key);
  }
}

async function computePreview(pid: string, did: string, text: StoredDocumentText, settings: ChunkSettings): Promise<ChunkExperiment> {
  const tokenized = settings.unit === "tokens" ? await buildTokenChunks(text, settings) : null;
  const chunks = (tokenized?.chunks ?? chunkText(text.text, text.pages, settings.maxChars, { ...settings, sections: text.sections })).map(
    (c) => ({
      ...c,
      id: `${did}_preview${c.ordinal}`,
      documentId: did,
      projectId: pid,
    }),
  );
  return {
    settings,
    textHash: textHash(text.text),
    chunks,
    metrics: chunkMetrics(chunks),
    ...(tokenized ? { tokenization: tokenized.tokenization } : {}),
  };
}

/** Save an independent input variant. Never rewrite chunks underneath a historical or active run. */
export async function saveChunkVariant(
  ctx: ServiceCtx,
  pid: string,
  did: string,
  input: unknown,
  expectedHash: unknown,
): Promise<ProjectDocument> {
  await requireProject(ctx, pid);
  const doc = await requireDocument(ctx, pid, did);
  const settings = validateChunkSettings(input);
  const key = JSON.stringify([ctx.user.id, pid, doc.variantOf ?? doc.id]);
  const previous = saving.get(key);
  const operation = (async () => {
    await previous?.catch(() => {});
    return saveConfiguration(ctx, pid, did, settings, expectedHash);
  })();
  saving.set(key, operation);
  try {
    return await operation;
  } finally {
    if (saving.get(key) === operation) saving.delete(key);
  }
}

async function saveConfiguration(
  ctx: ServiceCtx,
  pid: string,
  did: string,
  input: ChunkSettings,
  expectedHash: unknown,
): Promise<ProjectDocument> {
  const started = Date.now();
  const experiment = await previewChunks(ctx, pid, did, input);
  if (expectedHash !== experiment.textHash)
    throw new HttpError(409, "The source text changed. Preview the experiment again before saving.");
  if (experiment.reusedDocumentId) return requireDocument(ctx, pid, experiment.reusedDocumentId);
  const doc = await requireDocument(ctx, pid, did);
  // First configuration publishes chunks on the parsed source. Later configurations create independent variants.
  if (!doc.chunkCount && !(await ctx.store.runs.list(pid)).some((r) => r.documentIds.includes(did))) {
    const text = await ctx.store.documents.getText(pid, did);
    if (!text || textHash(text.text) !== experiment.textHash) throw new HttpError(409, "Source text changed. Preview again.");
    if (!experiment.chunks.length) throw new HttpError(409, "No readable text to chunk. Inspect the extracted text first.");
    const chunks = experiment.chunks.map((c, i) => ({ ...c, id: `${did}_c${i}` }));
    const patch: Partial<ProjectDocument> = {
      parseState: "parsed",
      chunkCount: chunks.length,
      preprocessing: {
        version: experiment.settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1",
        settings: experiment.settings,
        textHash: experiment.textHash,
        createdAt: iso(ctx.now()),
        durationMs: Date.now() - started,
      },
    };
    if (ctx.store.documents.claimProcessing) {
      const holder = randomUUID();
      const claim = await ctx.store.documents.claimProcessing(
        pid,
        did,
        holder,
        iso(new Date(ctx.now().getTime() + 600_000)),
        iso(ctx.now()),
        true,
      );
      if (!claim) throw new HttpError(409, "Chunk configuration is already being applied. Refresh the document.");
      const updated = await ctx.store.documents.finishProcessing!(pid, did, holder, patch, { text, chunks });
      if (!updated) throw new HttpError(409, "The document changed while applying chunks. Refresh and try again.");
      return updated;
    }
    await ctx.store.documents.putText(pid, did, text, chunks);
    return ctx.store.documents.update(pid, did, patch);
  }
  if ((await ctx.store.documents.list(pid)).length >= MAX_DOCUMENTS_PER_PROJECT)
    throw new HttpError(409, "Document limit reached. Remove an unused document before saving a variant.");
  const usage = await ctx.store.usage();
  const text = await ctx.store.documents.getText(pid, did);
  if (!text || textHash(text.text) !== experiment.textHash) throw new HttpError(409, "Source text changed. Preview again.");
  const bytes = await ctx.store.blobs.get(doc.storagePath);
  if (!bytes) throw new HttpError(410, "Original file is no longer available.");
  const addedBytes = bytes.length + Buffer.byteLength(JSON.stringify(text)) + Buffer.byteLength(JSON.stringify(experiment.chunks));
  if (usage.usedBytes + addedBytes > STORAGE_QUOTA_BYTES) throw new HttpError(507, "Storage quota exceeded by this document variant.");
  // A stable id plus insert-only storage also prevents duplicates across server processes.
  const identity = JSON.stringify([
    doc.variantOf ?? doc.id,
    sourceKey(doc, text),
    preprocessingVersion(experiment.settings),
    chunkSettingsKey(experiment.settings),
  ]);
  const id = `doc_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  const storagePath = `${pid}/documents/${id}`;
  const extension = /\.[a-z0-9]+$/i.exec(doc.name)?.[0] ?? ".txt";
  const stem = doc.name
    .slice(0, doc.name.length - extension.length)
    .replace(/ · experiment .+$/, "")
    .slice(0, 130);
  const holder = randomUUID();
  const publish = ctx.store.documents.finishProcessing;
  const variant: ProjectDocument = {
    ...doc,
    id,
    storagePath,
    name: `${stem} · experiment ${experiment.settings.method} ${experiment.settings.tokens?.generation.maxTokens ?? experiment.settings.maxChars}${experiment.settings.unit === "tokens" ? "t" : "c"} ${Math.round(experiment.settings.overlap * 100)}pct${extension}`,
    variantOf: doc.variantOf ?? doc.id,
    parseState: publish ? "pending" : "parsed",
    processing: publish
      ? {
          stage: "chunking",
          holder,
          expiresAt: iso(new Date(ctx.now().getTime() + 600_000)),
          settings: experiment.settings,
        }
      : null,
    chunkCount: experiment.chunks.length,
    createdAt: iso(ctx.now()),
    preprocessing: {
      version: experiment.settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1",
      settings: experiment.settings,
      textHash: experiment.textHash,
      createdAt: iso(ctx.now()),
      durationMs: Date.now() - started,
    },
  };
  await ctx.store.blobs.put(storagePath, bytes, doc.mediaType);
  let created = false;
  let savedVariant = variant;
  try {
    await ctx.store.documents.create(variant);
    created = true;
    const chunks = experiment.chunks.map((c) => ({ ...c, id: `${id}_c${c.ordinal}`, documentId: id }));
    if (publish) {
      const published = await publish(pid, id, holder, { parseState: "parsed" }, { text, chunks });
      if (!published) throw new HttpError(409, "The configuration changed while saving. Refresh and retry.");
      savedVariant = published;
    } else await ctx.store.documents.putText(pid, id, text, chunks);
  } catch (error) {
    if (created) {
      if (!publish || (await ctx.store.documents.get(pid, id))?.processing?.holder === holder) {
        await ctx.store.documents.delete(pid, id).catch(() => {});
        await ctx.store.blobs.delete(storagePath).catch(() => {});
      }
    } else {
      const existing = await savedChunks(ctx, pid, doc, text, experiment.settings);
      if (existing) return existing.document;
      if (await ctx.store.documents.get(pid, id)) throw new HttpError(409, "This configuration is being saved. Retry to reuse it.");
    }
    throw error;
  }
  await touchProject(ctx, pid);
  return savedVariant;
}

const inputPath = (pid: string, runId: string) => `${pid}/research/${runId}/inputs.json`;

export async function snapshotRunInputs(
  ctx: ServiceCtx,
  run: ExtractionRun,
  docs: ProjectDocument[],
  chunks: DocumentChunk[],
  requirements: unknown,
): Promise<void> {
  const base = run.baseRevisionId ? await ctx.store.revisions.get(run.projectId, run.baseRevisionId) : null;
  const inputs: ResearchInputs = {
    documentTexts: Object.fromEntries(
      await Promise.all(
        docs.map(async (doc) => [doc.id, { documentId: doc.id, ...(await ctx.store.documents.getText(run.projectId, doc.id))! }]),
      ),
    ),
    version: 1,
    recordedAt: iso(ctx.now()),
    requirements,
    baseRevision: run.alignment
      ? { id: run.baseRevisionId!, contentHash: run.alignment.inputHash, content: run.alignment.content }
      : base
        ? { id: base.id, contentHash: base.contentHash, content: base.content }
        : null,
    documents: docs.map(({ storagePath: _path, ownerId: _owner, ...doc }) => doc),
    chunks,
  };
  await ctx.store.blobs.put(inputPath(run.projectId, run.id), Buffer.from(JSON.stringify(inputs)), "application/json");
}

export async function runResearch(ctx: ServiceCtx, pid: string, runId: string): Promise<RunResearch> {
  await requireProject(ctx, pid);
  const run = await ctx.store.runs.get(pid, runId);
  if (!run) throw new HttpError(404, "Run not found.");
  const [checkpoints, bytes] = await Promise.all([ctx.store.runs.checkpoints(pid, runId), ctx.store.blobs.get(inputPath(pid, runId))]);
  const { toView } = await import("./runs.ts");
  return {
    version: 1,
    run: toView(run, checkpoints, ctx.now()),
    checkpoints,
    inputs: bytes ? (JSON.parse(bytes.toString("utf8")) as ResearchInputs) : null,
  };
}
