import { createHash } from "node:crypto";
import type { DocumentChunk, DocumentText } from "../../src/types/project.ts";
import type { ResearchInputs } from "../../src/types/research.ts";
import type { AnswerPassage, SourceCoverage } from "../../src/types/sourceEvidence.ts";
import type { Passage } from "../graphchat/turn.ts";
import { HttpError } from "../http.ts";
import { scoreChunks } from "../store/search.ts";
import { chunkText } from "./chunking.ts";
import { requireCorpus } from "./corpora.ts";
import type { ServiceCtx } from "./context.ts";
import { requireRevision } from "./revisions.ts";

const PROFILE = "saved-text-bm25-section-1200-v1";
export const passageCitation = (p: Passage, ref: string): AnswerPassage => ({
  ref,
  key: p.key ?? p.chunk.id,
  title: p.title ?? p.where,
  where: p.where,
  evidence: {
    runId: p.runId,
    documentId: p.chunk.documentId,
    // Search passages are derived from full retained text, not extraction inputs.
    // Their key identifies the search span; do not claim an extraction chunk ID.
    chunkId: p.key ? undefined : p.chunk.id,
    page: p.chunk.page,
    start: p.chunk.start,
    end: p.chunk.end,
    quote: p.chunk.text,
    status: "verified",
  },
});

/** Load each pinned run once. Never consult live documents, including for titles. */
export async function savedSources(ctx: ServiceCtx, pid: string, revisionId: string) {
  await requireCorpus(ctx, pid);
  const revision = await requireRevision(ctx, pid, revisionId);
  if (revision.status !== "committed") throw new HttpError(409, "Save this graph version before searching its sources.");
  if (!revision.content.corpus) throw new HttpError(400, "This version has no saved corpus sources.");
  const sources = revision.content.corpus.sources;
  const coverage: SourceCoverage = {
    revisionId,
    contentHash: revision.contentHash,
    manifestHash: createHash("sha256")
      .update(JSON.stringify([PROFILE, sources]))
      .digest("hex"),
    label: `Graph version ${revision.number ?? ""}`,
    profile: PROFILE,
    total: sources.length,
    available: 0,
    unavailable: [],
  };
  const manifest: unknown[] = [];
  const membership = new Map<string, string[]>();
  const runs = new Map<string, ResearchInputs | null>();
  const passages: Passage[] = [];
  const snapshots = new Map<string, DocumentText>();
  for (const source of sources) {
    if (!runs.has(source.runId)) {
      const run = await ctx.store.runs.get(pid, source.runId);
      membership.set(source.runId, run?.documentIds ?? []);
      const bytes = run ? await ctx.store.blobs.get(`${pid}/research/${source.runId}/inputs.json`) : null;
      let inputs: ResearchInputs | null = null;
      try {
        inputs = bytes ? (JSON.parse(bytes.toString("utf8")) as ResearchInputs) : null;
      } catch {
        /* report unavailable */
      }
      runs.set(source.runId, inputs);
    }
    const inputs = runs.get(source.runId);
    const doc = inputs?.documents?.find((d) => d.id === source.documentId && d.checksum === source.checksum);
    const text = inputs?.documentTexts?.[source.documentId];
    if (
      !membership.get(source.runId)?.includes(source.documentId) ||
      !doc ||
      !text ||
      typeof text.text !== "string" ||
      !Array.isArray(text.pages)
    ) {
      coverage.unavailable.push(source.documentId);
      continue;
    }
    coverage.available++;
    const textHash = createHash("sha256").update(text.text).digest("hex");
    manifest.push([source.documentId, source.runId, textHash]);
    const chunks = chunkText(text.text, text.pages, 1200, { method: "section", sections: text.sections, overlap: 0 });
    for (const chunk of chunks) {
      const key = createHash("sha256")
        .update(JSON.stringify([pid, source.documentId, source.runId, textHash, PROFILE, chunk.start, chunk.end]))
        .digest("hex");
      const c: DocumentChunk = { ...chunk, id: key, projectId: pid, documentId: source.documentId };
      passages.push({
        key,
        title: doc.name,
        runId: source.runId,
        chunk: c,
        where: `${doc.name}${c.page ? `, page ${c.page}` : ""}${c.sectionPath?.length ? ` — ${c.sectionPath.join(" › ")}` : ""}`,
      });
      snapshots.set(key, { ...text, documentId: source.documentId, chunks: [] });
    }
  }
  coverage.manifestHash = createHash("sha256")
    .update(JSON.stringify([PROFILE, sources, manifest, coverage.unavailable]))
    .digest("hex");
  return { coverage, passages, snapshots };
}

export function rankSaved(passages: Passage[], query: string, limit: number): Passage[] {
  const byId = new Map(passages.map((p) => [p.chunk.id, p]));
  return scoreChunks(
    passages.map((p) => p.chunk),
    query,
    Math.min(50, Math.max(1, limit)),
  ).map((c) => byId.get(c.id)!);
}

export async function searchSavedEvidence(ctx: ServiceCtx, pid: string, rid: string, query: string) {
  const scope = await savedSources(ctx, pid, rid);
  return { coverage: scope.coverage, passages: rankSaved(scope.passages, query, 20).map((p, i) => passageCitation(p, `S${i + 1}`)) };
}

export async function savedPassageContext(ctx: ServiceCtx, pid: string, rid: string, key: string) {
  const scope = await savedSources(ctx, pid, rid);
  const snapshot = scope.snapshots.get(key);
  if (!snapshot) throw new HttpError(404, "This saved passage is unavailable in the selected graph version.");
  return snapshot;
}
