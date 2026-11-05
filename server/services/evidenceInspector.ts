import { createHash } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { EvidenceRef, FactReview } from "../../src/types/abox.ts";
import type { DocumentChunk, DocumentText, ExtractionRun, ProjectDocument, RevisionWithContent } from "../../src/types/project.ts";
import type { ResearchInputs } from "../../src/types/research.ts";
import type {
  EvidenceInspection,
  EvidenceInputBlock,
  EvidenceRequest,
  EvidenceSource,
  EvidenceStructure,
  EvidenceTarget,
  SavedEvidenceText,
} from "../../src/types/evidence.ts";
import { listFacts, factKey } from "../../src/lib/ontology/factReview.ts";
import { localName } from "../../src/lib/ontology/iri.ts";
import { buildTboxEvidence } from "../../src/lib/tboxEvidence.ts";
import { parsedEvidenceTable, quoteMatch, reviewLabel } from "../../src/lib/evidence.ts";
import { HttpError } from "../http.ts";
import { requireString } from "../validation.ts";
import type { ServiceCtx } from "./context.ts";
import { requireProject } from "./projects.ts";
import { requireRevision } from "./revisions.ts";
import { runResearch } from "./research.ts";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const string = (v: unknown, field: string, max = 200) => requireString(v, field, { max });
const optional = (v: unknown, field: string, max = 200) => (v === undefined ? undefined : string(v, field, max));
const offset = (v: unknown, field: string) => {
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || Number(v) < 0) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return Number(v);
};

export function parseEvidenceRequest(value: unknown): EvidenceRequest {
  const b = object(value),
    t = object(b.target);
  let target: EvidenceTarget;
  switch (t.kind) {
    case "fact":
      target = { kind: "fact", revisionId: string(t.revisionId, "revisionId"), factKey: string(t.factKey, "factKey", 10000) };
      break;
    case "term": {
      const runId = optional(t.runId, "runId"),
        revisionId = optional(t.revisionId, "revisionId");
      if (!runId && !revisionId) throw new HttpError(400, "A term requires a run or revision.");
      target = { kind: "term", runId, revisionId, termId: string(t.termId, "termId", 2000), stepKey: optional(t.stepKey, "stepKey") };
      break;
    }
    case "passage":
      target = {
        kind: "passage",
        documentId: string(t.documentId, "documentId"),
        chunkId: string(t.chunkId, "chunkId"),
        runId: optional(t.runId, "runId"),
        stepKey: optional(t.stepKey, "stepKey"),
      };
      break;
    case "document":
      target = { kind: "document", documentId: string(t.documentId, "documentId") };
      break;
    case "answer":
      target = {
        kind: "answer",
        conversationId: string(t.conversationId, "conversationId"),
        messageId: string(t.messageId, "messageId"),
        ref: string(t.ref, "ref"),
      };
      break;
    case "reference":
      target = {
        kind: "reference",
        documentId: optional(t.documentId, "documentId"),
        runId: optional(t.runId, "runId"),
        chunkId: optional(t.chunkId, "chunkId"),
        quote: typeof t.quote === "string" ? t.quote.slice(0, 4000) : "",
        start: offset(t.start, "start"),
        end: offset(t.end, "end"),
        page: offset(t.page, "page"),
        stepKey: optional(t.stepKey, "stepKey"),
        preview: t.preview === true,
      };
      break;
    default:
      throw new HttpError(400, "Select a valid evidence target.");
  }
  const sourceIndex = offset(b.sourceIndex, "sourceIndex") ?? 0;
  if (sourceIndex > 10000 || (b.part !== undefined && b.part !== "overview" && b.part !== "input"))
    throw new HttpError(400, "Invalid evidence view.");
  return { target, sourceIndex, part: b.part === "input" ? "input" : "overview" };
}

interface RunSource {
  run: ExtractionRun;
  inputs: ResearchInputs | null;
}
async function readRun(ctx: ServiceCtx, pid: string, runId: string): Promise<RunSource> {
  const run = await ctx.store.runs.get(pid, runId);
  if (!run) throw new HttpError(404, "Evidence run not found.");
  const bytes = await ctx.store.blobs.get(`${pid}/research/${runId}/inputs.json`);
  return { run, inputs: bytes ? (JSON.parse(bytes.toString("utf8")) as ResearchInputs) : null };
}
export async function savedEvidenceText(ctx: ServiceCtx, pid: string, runId: string, documentId: string): Promise<SavedEvidenceText> {
  await requireProject(ctx, pid);
  const { run, inputs } = await readRun(ctx, pid, runId);
  if (!run.documentIds.includes(documentId)) throw new HttpError(404, "Document is not an input to this run.");
  const text = inputs?.documentTexts?.[documentId],
    doc = inputs?.documents.find((d) => d.id === documentId);
  if (!text) throw new HttpError(404, "Historical full text is unavailable. Current text has not been substituted.");
  return {
    ...text,
    name: doc?.name ?? "Retained source",
    parsing: doc?.parsing,
    chunks: (inputs?.chunks ?? []).filter((c) => c.documentId === documentId).map(({ text: _text, projectId: _pid, ...c }) => c),
  };
}

function factReview(rev: RevisionWithContent, key: string): FactReview | undefined {
  for (const i of rev.content.abox?.individuals ?? []) {
    if (factKey(i.id, "type") === key) return i.review;
    for (const d of i.dataProperties ?? []) if (factKey(i.id, "data", d) === key) return d.review;
    for (const o of i.objectProperties ?? []) if (factKey(i.id, "link", o) === key) return o.review;
  }
}
interface Resolved {
  title: string;
  refs: EvidenceRef[];
  revision?: RevisionWithContent;
  assertion?: EvidenceInspection["assertion"];
  query?: EvidenceInspection["query"];
  message?: string;
  stepKey?: string;
}
async function resolveTarget(ctx: ServiceCtx, pid: string, target: EvidenceTarget): Promise<Resolved> {
  if (target.kind === "fact") {
    const revision = await requireRevision(ctx, pid, target.revisionId);
    const f = listFacts(revision.content.abox ?? { individuals: [] }).find((f) => f.key === target.factKey);
    if (!f) throw new HttpError(404, "Assertion not found in the selected revision.");
    const title = `${f.label || f.individualId} ${f.kind === "type" ? `is a ${localName(f.classUri ?? "")}` : `${localName(f.propUri ?? "")} ${f.value ?? f.targetId ?? ""}`}`;
    const legacy = f.kind === "type" ? revision.content.abox?.individuals.find((i) => i.id === f.individualId)?.sourceEvidence : undefined;
    return {
      title,
      refs: f.evidence.length ? f.evidence : legacy ? [{ quote: legacy, status: "legacy" }] : [],
      revision,
      assertion: { key: f.key, status: f.status, review: factReview(revision, f.key) },
    };
  }
  if (target.kind === "term") {
    const revision = target.revisionId ? await requireRevision(ctx, pid, target.revisionId) : undefined;
    if (target.runId) {
      const report = await runResearch(ctx, pid, target.runId);
      if (revision && report.run.resultRevisionId !== revision.id) throw new HttpError(404, "Term build does not belong to this revision.");
      if (target.stepKey && !report.run.steps.some((s) => s.key === target.stepKey)) throw new HttpError(404, "Term stage not found.");
      const term = buildTboxEvidence(report, revision).terms.find((t) => t.id === target.termId);
      if (!term) throw new HttpError(404, "Term not found in the selected build.");
      const citations = term.citations.filter((c) => !target.stepKey || c.callId === target.stepKey);
      if (target.stepKey && !citations.length) throw new HttpError(404, "Term has no citation from this stage.");
      return {
        title: term.label,
        revision,
        stepKey: target.stepKey,
        refs: citations.map((c) => ({ ...c, stepKey: c.callId, runId: target.runId, status: c.located ? "verified" : "unverified" })),
      };
    }
    const evidence = revision!.content.review?.termEvidence?.filter((e) => `${e.kind}:${e.term}` === target.termId) ?? [];
    if (!evidence.length) throw new HttpError(404, "Term evidence not found in the selected revision.");
    return { title: evidence[0].term, revision, refs: evidence.map((e) => ({ ...e, status: e.located ? "verified" : "unverified" })) };
  }
  if (target.kind === "answer") {
    const c = await ctx.store.conversations.get(pid, target.conversationId);
    const m = c?.messages.find((m) => m.id === target.messageId && m.role === "assistant");
    if (!c || !m) throw new HttpError(404, "Answer not found in this conversation.");
    const revision = c.revisionId ? await requireRevision(ctx, pid, c.revisionId) : undefined;
    const citation = m.citations?.find((e) => e.ref === target.ref);
    if (citation) return { title: `Answer citation ${target.ref}`, refs: [citation.evidence], revision };
    const q = m.agent?.runs.find((q) => q.id === target.ref);
    if (!q) throw new HttpError(404, "Citation not found in this answer.");
    return {
      title: `Answer query ${q.id}`,
      refs: [],
      revision,
      query: {
        id: q.id,
        query: q.query.slice(0, 32000),
        rows: q.rows.slice(0, 100),
        rowCount: q.rowCount,
        repositoryId: q.repositoryId,
        error: q.error,
      },
      message: "These recorded query results support the answer. No document citation is attached to this query.",
    };
  }
  if (target.kind === "reference")
    return {
      title: target.preview ? "Preview source passage" : "Source evidence",
      stepKey: target.stepKey,
      refs: [{ ...target, status: "unverified" }],
    };
  if (target.kind === "document")
    return { title: "Document evidence", refs: [{ documentId: target.documentId, quote: "", status: "legacy" }] };
  return {
    title: "Source passage",
    refs: [{ documentId: target.documentId, chunkId: target.chunkId, runId: target.runId, quote: "", status: "unverified" }],
    stepKey: target.stepKey,
  };
}

interface LoadedSource {
  ref: EvidenceRef;
  run?: ExtractionRun;
  inputs?: ResearchInputs | null;
  doc?: ResearchInputs["documents"][number];
  chunk?: DocumentChunk;
  text?: Omit<DocumentText, "chunks">;
  partial?: boolean;
  missing?: string;
  stepKey?: string;
  original?: ProjectDocument;
}
async function loadSource(ctx: ServiceCtx, pid: string, ref: EvidenceRef, resolved: Resolved, inferredRun?: string): Promise<LoadedSource> {
  const s: LoadedSource = { ref: { ...ref }, stepKey: resolved.stepKey ?? ref.stepKey };
  const explicitRun = ref.runId ?? resolved.revision?.content.corpus?.sources.find((d) => d.documentId === ref.documentId)?.runId;
  const runId = explicitRun ?? inferredRun;
  if (runId && ref.documentId) {
    const { run, inputs } = await readRun(ctx, pid, runId);
    if (!run.documentIds.includes(ref.documentId)) {
      if (explicitRun) throw new HttpError(404, "Document is not an input to this evidence run.");
      return loadSource(ctx, pid, ref, { ...resolved, revision: undefined });
    }
    s.ref.runId = runId;
    s.run = run;
    s.inputs = inputs;
    s.doc = inputs?.documents.find((d) => d.id === ref.documentId);
    s.text = inputs?.documentTexts?.[ref.documentId];
    s.chunk = inputs?.chunks.find((c) => c.id === ref.chunkId && c.documentId === ref.documentId);
    if (ref.chunkId && inputs && !s.chunk) throw new HttpError(404, "Chunk is not an input to this evidence run.");
    if (!s.text && s.chunk) {
      s.text = { documentId: ref.documentId, text: s.chunk.text, pages: [], sections: [], tables: [] };
      s.partial = true;
      s.missing = "Only the saved chunk is available; the full document was not recorded.";
    }
    if (!s.text) s.missing = "Historical text unavailable. Current text has not been substituted.";
  } else if (ref.documentId) {
    const doc = await ctx.store.documents.get(pid, ref.documentId);
    if (!doc) {
      s.missing = "The original document is no longer available and no run snapshot is attached.";
      return s;
    }
    s.doc = doc;
    const text = await ctx.store.documents.getText(pid, doc.id);
    if (text) s.text = { ...text, documentId: doc.id };
    else s.missing = "This document has no parsed text. Inspect the retained original where available.";
    if (ref.chunkId) {
      s.chunk = (await ctx.store.documents.chunks(pid, [doc.id])).find((c) => c.id === ref.chunkId);
      if (!s.chunk) throw new HttpError(404, "Chunk not found in this document.");
    }
  } else s.missing = "No source document was recorded for this evidence.";
  if (s.stepKey) {
    const step = s.run?.steps.find((step) => step.key === s.stepKey);
    const stageChunks = step?.chunkIds ?? (step?.chunkId ? [step.chunkId] : []);
    if (!step || (s.chunk && (stageChunks.length ? !stageChunks.includes(s.chunk.id) : step.documentId !== s.ref.documentId)))
      throw new HttpError(404, "Source is not an input to this stage.");
  } else if (s.chunk) s.stepKey = s.run?.steps.find((step) => step.chunkId === s.chunk!.id || step.chunkIds?.includes(s.chunk!.id))?.key;
  else s.stepKey = s.run?.steps.find((step) => step.kind === "vision" && step.documentId === ref.documentId)?.key;
  if (
    s.ref.status === "unverified" &&
    !s.text?.text.trim() &&
    s.run?.steps.some((step) => step.key === s.stepKey && step.kind === "vision")
  )
    s.ref.status = "vision";
  const currentDoc = ref.documentId ? await ctx.store.documents.get(pid, ref.documentId) : null;
  const expectedChecksum = s.doc?.checksum ?? (ref.documentId ? s.run?.documentChecksums[ref.documentId] : undefined);
  if (currentDoc && expectedChecksum && currentDoc.checksum === expectedChecksum) s.original = currentDoc;
  if (!s.ref.quote && s.chunk) s.ref = { ...s.ref, quote: s.chunk.text, start: s.chunk.start, end: s.chunk.end, page: s.chunk.page };
  return s;
}

async function inferredRun(ctx: ServiceCtx, pid: string, resolved: Resolved): Promise<string | undefined> {
  if (!resolved.revision || resolved.refs.every((r) => r.runId || !r.documentId)) return undefined;
  const runs = await ctx.store.runs.list(pid);
  let rev: RevisionWithContent | undefined = resolved.revision;
  for (let depth = 0; rev && depth < 50; depth++) {
    const found = runs.find((r) => r.resultRevisionId === rev!.id);
    if (found) return found.id;
    rev = rev.parentId ? ((await ctx.store.revisions.get(pid, rev.parentId)) ?? undefined) : undefined;
  }
}

function projectSource(s: LoadedSource): EvidenceSource {
  const base = s.partial ? s.chunk!.start : 0;
  const localRef = {
    ...s.ref,
    start: s.ref.start === undefined ? undefined : s.ref.start - base,
    end: s.ref.end === undefined ? undefined : s.ref.end - base,
  };
  const match = quoteMatch(
    localRef,
    s.text?.text,
    s.chunk ? { ...s.chunk, start: s.chunk.start - base, end: s.chunk.end - base } : undefined,
  );
  const recordedTextHash = !s.partial ? (s.doc?.parsing?.textHash ?? s.doc?.preprocessing?.textHash) : undefined;
  const textHash = s.text && !s.partial ? hash(s.text.text) : undefined;
  const start = "start" in match ? match.start : undefined,
    end = "end" in match ? match.end : undefined;
  const anchor = Math.max(0, Math.min(s.text?.text.length ?? 0, start ?? (s.chunk ? s.chunk.start - base : 0)));
  const from = Math.max(0, anchor - 650),
    to = Math.min(s.text?.text.length ?? 0, Math.max(anchor + 2800, Math.min(end ?? 0, anchor + 10000)));
  const globalHighlight = start !== undefined && end !== undefined ? { start: start + base, end: end + base } : undefined;
  const range = globalHighlight ?? (s.chunk ? { start: s.chunk.start, end: s.chunk.end } : undefined);
  const table = range && !s.partial ? s.text?.tables?.find((t) => t.start < range.end && t.end > range.start) : undefined;
  const doc = s.doc;
  const paths = range
    ? [...new Set(s.text?.sourceSpans?.filter((p) => p.start < range.end && p.end > range.start).map((p) => p.path) ?? [])]
    : [];
  const confidence =
    typeof s.ref.confidence === "number" && Number.isFinite(s.ref.confidence) && s.ref.confidence >= 0 && s.ref.confidence <= 1
      ? s.ref.confidence
      : undefined;
  const threshold = s.ref.check?.threshold ?? (s.ref.claim ? s.run?.config?.nliReviewThreshold : undefined);
  const support =
    confidence === undefined
      ? "unrecorded"
      : s.ref.review
        ? "review"
        : threshold !== undefined
          ? confidence >= threshold
            ? "passed"
            : "review"
          : s.ref.review === false
            ? "passed"
            : "score-only";
  return {
    reference: {
      quote: s.ref.quote.slice(0, 4000),
      status: s.ref.status,
      start: globalHighlight?.start,
      end: globalHighlight?.end,
      page: s.ref.page,
      claim: s.ref.claim,
      confidence,
      review: s.ref.review,
    },
    match: match.kind,
    support,
    integrity: recordedTextHash && textHash ? (recordedTextHash === textHash ? "match" : "mismatch") : "not-recorded",
    textHash,
    recordedTextHash,
    document: doc
      ? {
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          mediaType: doc.mediaType,
          checksum: doc.checksum,
          parsing: doc.parsing,
          createdAt: doc.createdAt,
          ocr: doc.ocr,
        }
      : undefined,
    snapshot: !!s.run,
    unavailable: s.missing,
    excerpt: s.text
      ? {
          text: s.text.text.slice(from, to),
          start: from + base,
          end: to + base,
          total: s.partial ? s.chunk!.end : s.text.text.length,
          highlight:
            start !== undefined && end !== undefined
              ? { start: Math.max(0, start - from), end: Math.min(to - from, end - from) }
              : undefined,
        }
      : undefined,
    section:
      s.chunk?.sectionPath ??
      (range ? s.text?.sections?.filter((sec) => sec.start < range.end && sec.end > range.start).at(-1)?.path : undefined),
    paths: paths.slice(0, 30),
    pathCount: paths.length,
    table: table && s.text ? parsedEvidenceTable(s.text.text, table, globalHighlight) : undefined,
    originalAvailable: !!s.original,
    stepKey: s.stepKey,
  };
}

function block(label: string, state: EvidenceInputBlock["state"], value?: unknown, note?: string): EvidenceInputBlock {
  const text = value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { label, state, text: text?.slice(0, 24000), truncated: !!text && text.length > 24000, note };
}
async function modelInputs(ctx: ServiceCtx, pid: string, s: LoadedSource): Promise<EvidenceInputBlock[]> {
  if (!s.run) return [block("Generation input", "unavailable", undefined, "Select a retained run to inspect recorded model inputs.")];
  const cps = await ctx.store.runs.checkpoints(pid, s.run.id),
    cp = cps.find((cp) => cp.key === s.stepKey);
  const input = cp?.trace?.input;
  if (!cp) return [block("Generation input", "unavailable", undefined, "No successful checkpoint was recorded for this source stage.")];
  if (cp.via === "screen")
    return [block("Generation input", "unavailable", undefined, "Relevance screening skipped this passage. No extraction call was made.")];
  const blocks: EvidenceInputBlock[] = [];
  if (cp.via === "cache")
    blocks.push(
      block(
        "Generation input",
        "reused",
        undefined,
        "This result was reused. The original call's complete prompt context was not recorded here.",
      ),
    );
  else if (s.run.steps.find((step) => step.key === s.stepKey)?.kind === "vision") {
    blocks.push(
      block(
        "Vision document",
        "recorded",
        { name: s.doc?.name, checksum: s.ref.documentId ? s.run.documentChecksums[s.ref.documentId] : undefined },
        "The stage read the retained document as images. Inspect Original file where available; no text passage substitutes for those images.",
      ),
    );
  } else {
    const hasSamples = Array.isArray(input?.sampledDocuments);
    const sampled = hasSamples
      ? (input!.sampledDocuments as unknown[]).map(object).filter((p) => p.chunkId === s.ref.chunkId && typeof p.text === "string")
      : [];
    const recordedChunk = Array.isArray(input?.chunkIds) && input.chunkIds.includes(s.ref.chunkId);
    const passage = hasSamples
      ? sampled.length
        ? sampled.map((p) => p.text).join("\n\n")
        : undefined
      : typeof input?.text === "string"
        ? input.text
        : s.chunk?.text;
    const state =
      passage === undefined ? "unavailable" : hasSamples || typeof input?.text === "string" || recordedChunk ? "recorded" : "reconstructed";
    blocks.push(
      block(
        "Generation passage",
        state,
        passage,
        hasSamples && !sampled.length
          ? "This planned chunk is absent from the recorded passages sent to this stage."
          : state === "reconstructed"
            ? "Saved source chunk. Exact generation inputs were not recorded for this checkpoint."
            : "Saved source input; the complete rendered provider request is not recorded.",
      ),
    );
    for (const [key, label] of [
      ["context", "Added context"],
      ["schema", "Selected ontology schema"],
      ["knownIndividuals", "Known individuals"],
      ["requirementsText", "Requirements guidance"],
    ]) {
      if (input?.[key] != null) blocks.push(block(label, "recorded", input[key]));
    }
  }
  if (cp.trace?.diagnostics?.embedder != null)
    blocks.push(block("Retrieval backend", "recorded", cp.trace.diagnostics.embedder, "Backend identity recorded by this stage."));
  const tokenization = s.chunk?.tokenization;
  blocks.push(
    tokenization && s.chunk
      ? block(
          "Embedding source spans",
          "reconstructed",
          tokenization.embeddingPassages.map((p) => ({
            start: p.start,
            end: p.end,
            tokens: p.tokens,
            text: s.chunk!.text.slice(p.start - s.chunk!.start, p.end - s.chunk!.start),
          })),
          `Source slices from saved UTF-16 spans. Tokenizer: ${tokenization.embedding.tokenizer}. Added section context and the complete embedding request were not recorded; this does not prove that an embedding call occurred.`,
        )
      : block("Embedding input", "unavailable", undefined, "Exact embedding inputs were not recorded for this stage."),
  );
  blocks.push(
    block(
      "Support check",
      s.ref.check ? "recorded" : "unavailable",
      s.ref.check,
      s.ref.check ? undefined : "The contextual premise and backend were not recorded for this quotation.",
    ),
  );
  return blocks;
}

export async function inspectEvidence(ctx: ServiceCtx, pid: string, request: EvidenceRequest): Promise<EvidenceInspection> {
  const project = await requireProject(ctx, pid);
  const r = await resolveTarget(ctx, pid, request.target);
  if (r.refs.length > 1000) throw new HttpError(413, "This target has too many evidence references to inspect at once.");
  const sourceIndex = request.sourceIndex ?? 0;
  if (sourceIndex >= Math.max(1, r.refs.length)) throw new HttpError(404, "Evidence source not found.");
  const runId = await inferredRun(ctx, pid, r);
  // Read metadata once per distinct document/run, rather than loading every source's full text.
  const selected = r.refs[sourceIndex] ? await loadSource(ctx, pid, r.refs[sourceIndex], r, runId) : undefined;
  const savedRuns = new Map<string, Promise<RunSource>>();
  const sources = await Promise.all(
    r.refs.map(async (ref, index) => {
      const explicit = ref.runId ?? r.revision?.content.corpus?.sources.find((d) => d.documentId === ref.documentId)?.runId;
      let id = explicit ?? runId;
      let name = ref.documentId ? (await ctx.store.documents.get(pid, ref.documentId))?.name : undefined;
      if (id && ref.documentId) {
        if (id === selected?.run?.id) {
          if (!selected.run.documentIds.includes(ref.documentId)) throw new HttpError(404, "Evidence source is outside its run.");
          name = selected.inputs?.documents.find((d) => d.id === ref.documentId)?.name;
        } else {
          if (!savedRuns.has(id)) savedRuns.set(id, readRun(ctx, pid, id));
          const saved = await savedRuns.get(id)!;
          if (!saved.run.documentIds.includes(ref.documentId)) {
            if (explicit) throw new HttpError(404, "Evidence source is outside its run.");
            id = undefined;
          } else name = saved.inputs?.documents.find((d) => d.id === ref.documentId)?.name;
        }
      }
      return { index, name: name ?? "Recorded source", documentId: ref.documentId, runId: id, chunkId: ref.chunkId, page: ref.page };
    }),
  );
  const source = selected ? projectSource(selected) : undefined;
  const history: EvidenceInspection["history"] = [];
  if (selected?.doc)
    history.push({
      label: "Source processing version",
      detail: `${selected.doc.name} · ${selected.doc.parsing?.version ?? "Parser version not recorded"}`,
      at: selected.doc.parsing?.createdAt ?? selected.doc.createdAt,
    });
  if (selected?.run)
    history.push({
      label: "Retained run inputs",
      detail: `${selected.run.provider} / ${selected.run.model} · ${selected.run.id}`,
      at: selected.run.createdAt,
    });
  if (selected?.stepKey) history.push({ label: "Source stage", detail: selected.stepKey });
  if (r.revision)
    history.push({
      label: r.revision.status === "draft" ? "Draft graph" : `Saved graph version ${r.revision.number ?? ""}`,
      detail: r.revision.summary || r.revision.id,
      at: r.revision.committedAt ?? r.revision.createdAt,
    });
  if (r.assertion)
    history.push({
      label: reviewLabel(r.assertion.review),
      detail: r.assertion.review?.reason ?? "Review state of this assertion in the selected version.",
      at: r.assertion.review?.at,
    });
  return {
    version: 1,
    target: request.target,
    title: r.title,
    assertion: r.assertion,
    revision: r.revision
      ? {
          id: r.revision.id,
          status: r.revision.status,
          number: r.revision.number,
          contentHash: r.revision.contentHash,
          current: project.currentRevisionId === r.revision.id,
        }
      : undefined,
    sources,
    totalSources: sources.length,
    sourceIndex,
    source,
    query: r.query,
    message: r.message ?? (!sources.length ? "No quoted source was recorded for this target." : undefined),
    history,
    inputs: request.part === "input" && selected ? await modelInputs(ctx, pid, selected) : undefined,
  };
}

/** Re-resolve the association before reading bytes; never accept a client storage path. */
export async function evidenceOriginal(ctx: ServiceCtx, pid: string, request: EvidenceRequest) {
  await requireProject(ctx, pid);
  const r = await resolveTarget(ctx, pid, request.target);
  const ref = r.refs[request.sourceIndex ?? 0];
  if (!ref) throw new HttpError(404, "Evidence source not found.");
  const s = await loadSource(ctx, pid, ref, r, await inferredRun(ctx, pid, r));
  if (!s.original) throw new HttpError(410, "The original file for this source version is unavailable.");
  const bytes = await ctx.store.blobs.get(s.original.storagePath);
  if (!bytes) throw new HttpError(410, "The original file is no longer in storage.");
  const expected = s.doc?.checksum ?? (s.ref.documentId ? s.run?.documentChecksums[s.ref.documentId] : undefined);
  if (!expected || hash(bytes) !== expected) throw new HttpError(409, "The original file does not match its recorded checksum.");
  return { bytes, doc: s.original };
}

/** Original XML locations use the recorded parser's sibling-ordinal grammar. No client XPath or file path is evaluated. */
export async function evidenceStructure(
  ctx: ServiceCtx,
  pid: string,
  request: EvidenceRequest,
  elementIndex: number,
): Promise<EvidenceStructure> {
  if (!Number.isSafeInteger(elementIndex) || elementIndex < 0) throw new HttpError(400, "Invalid structural location.");
  const inspection = await inspectEvidence(ctx, pid, { ...request, part: "overview" });
  const path = inspection.source?.paths[elementIndex];
  if (!path) throw new HttpError(404, "No original structural location is recorded for this passage.");
  const { bytes, doc } = await evidenceOriginal(ctx, pid, request);
  if (!/xml/.test(doc.mediaType) && !/\.xml$/i.test(doc.name))
    throw new HttpError(404, "Original element inspection is available for XML sources.");
  if (bytes.length > 10 * 1024 * 1024)
    throw new HttpError(413, "This XML file exceeds the element-preview limit. Download the original to inspect it.");
  const source = bytes.toString("utf8");
  if (/<!ENTITY\b/i.test(source) || /<!DOCTYPE[^>]*\[/i.test(source))
    throw new HttpError(422, "Custom XML entity declarations are unsupported.");
  const errors: string[] = [];
  const parsed = new DOMParser({
    errorHandler: { warning: (m) => errors.push(m), error: (m) => errors.push(m), fatalError: (m) => errors.push(m) },
  }).parseFromString(source, "application/xml");
  if (errors.length || !parsed.documentElement) throw new HttpError(422, "The original XML cannot be safely inspected.");
  const steps = path.split("/").filter(Boolean);
  if (steps.length > 128) throw new HttpError(400, "Structural path is too deep.");
  let element: Element | undefined;
  for (let i = 0; i < steps.length; i++) {
    const match = /^([\w:.-]+)\[([1-9]\d{0,5})\]$/.exec(steps[i]);
    if (!match) throw new HttpError(422, "The recorded path uses an unsupported location grammar.");
    const candidates: Element[] =
      i === 0 ? [parsed.documentElement] : Array.from(element?.childNodes ?? []).filter((n): n is Element => n.nodeType === 1);
    element = candidates.filter((e) => e.tagName === match[1])[Number(match[2]) - 1];
    if (!element) throw new HttpError(404, "The recorded element is not present in the original.");
  }
  if (!element) throw new HttpError(404, "Original element unavailable.");
  const compact = (s: string) => s.replace(/\s+/g, " ").trim();
  const xml = new XMLSerializer().serializeToString(element);
  const elementText = compact(element.textContent ?? "");
  const result: EvidenceStructure = {
    path,
    text: elementText.slice(0, 32000),
    xml: xml.slice(0, 64000),
    truncated: xml.length > 64000 || elementText.length > 32000,
  };
  if ((element.localName || element.tagName) === "table") {
    const originalRows = Array.from(element.getElementsByTagName("*")).filter((e) => (e.localName || e.tagName) === "tr");
    const span = (v: string | null) => Math.min(100, Math.max(1, Number.parseInt(v ?? "1", 10) || 1));
    let cells = 0;
    const rows: NonNullable<EvidenceStructure["table"]>["rows"] = [];
    for (const [i, row] of originalRows.entries()) {
      const rowCells = Array.from(row.childNodes).filter(
        (n): n is Element => n.nodeType === 1 && ["td", "th"].includes((n as Element).localName || (n as Element).tagName),
      );
      if (cells + rowCells.length > 5000 || rows.length >= 100) break;
      cells += rowCells.length;
      const shown = rowCells.map((c) => ({
        text: compact(c.textContent ?? ""),
        header: (c.localName || c.tagName) === "th" || (row.parentNode as Element)?.localName === "thead",
        colspan: span(c.getAttribute("colspan")),
        rowspan: span(c.getAttribute("rowspan")),
      }));
      const mapped = inspection.source?.table?.rows[i];
      rows.push({
        cells: shown,
        highlighted:
          !!mapped?.highlighted && shown.length === mapped.cells.length && shown.every((c, j) => c.text === compact(mapped.cells[j])),
      });
    }
    const wrap = element.parentNode?.nodeType === 1 ? (element.parentNode as Element) : element;
    const caption = Array.from(wrap.getElementsByTagName("*")).find((e) => e.localName === "caption");
    const footnotes = Array.from(wrap.getElementsByTagName("*")).find((e) => e.localName === "table-wrap-foot");
    result.table = {
      rows,
      truncated: rows.length < originalRows.length,
      caption: caption ? compact(caption.textContent ?? "") : undefined,
      footnotes: footnotes ? compact(footnotes.textContent ?? "") : undefined,
    };
  }
  return result;
}
