/** Bounded external authoring, with server-owned evidence and review metadata. */
import type { ABoxResult, EvidenceRef, ABoxIndividual, FactReview } from "../../src/types/abox.ts";
import type { DocumentChunk, RevisionContent } from "../../src/types/project.ts";
import type { CorpusPlan } from "../../src/types/corpus.ts";
import type { ServiceCtx } from "../services/context.ts";
import { iso } from "../services/context.ts";
import { requireCorpus, planUpdate } from "../services/corpora.ts";
import { requireRevision, createRevision } from "../services/revisions.ts";
import { locateQuote } from "../services/evidence.ts";
import { tboxOf } from "../services/ontology.ts";
import { validateABox } from "../../src/lib/ontology/aboxValidator.ts";
import { mergeAboxes } from "../../src/lib/ontology/aboxMerge.ts";
import { withoutSources, preserveCorpusDecisions, respectCorpusEdits } from "../../src/lib/corpusGraph.ts";
import { HttpError } from "../http.ts";
import { digest, readState, writeState, stale } from "./state.ts";

export interface Submission {
  id: string;
  projectId: string;
  plan: CorpusPlan;
  chunks: DocumentChunk[];
  batches: Record<string, { hash: string; chunkIds: string[]; abox: ABoxResult }>;
  resultRevisionId?: string;
  createdAt: string;
}
const path = (pid: string, id: string) => `${pid}/agent/${id}.json`;
export async function getSubmission(ctx: ServiceCtx, pid: string, id: string) {
  await requireCorpus(ctx, pid);
  const saved = await readState<Submission>(ctx, path(pid, id));
  if (!saved) throw new HttpError(404, "Work package not found.");
  return saved;
}
async function indexSubmission(ctx: ServiceCtx, pid: string, id: string) {
  const indexPath = `${pid}/agent/work-packages.json`;
  const ids = (await readState<string[]>(ctx, indexPath)) ?? [];
  if (!ids.includes(id)) await writeState(ctx, indexPath, [id, ...ids].slice(0, 100));
}
export async function listSubmissions(ctx: ServiceCtx, pid: string) {
  const ids = (await readState<string[]>(ctx, `${pid}/agent/work-packages.json`)) ?? [];
  const saved = await Promise.all(ids.map((id) => readState<Submission>(ctx, path(pid, id))));
  return saved
    .filter((s): s is Submission => !!s)
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      chunks: s.chunks.length,
      covered: new Set(Object.values(s.batches).flatMap((b) => b.chunkIds)).size,
      resultRevisionId: s.resultRevisionId,
    }));
}
export async function prepareSubmission(ctx: ServiceCtx, pid: string, id: string) {
  const old = await readState<Submission>(ctx, path(pid, id));
  if (old) {
    await indexSubmission(ctx, pid, id);
    return old;
  }
  const plan = await planUpdate(ctx, pid, "changes", [], { external: true });
  if (plan.errors.length) throw new HttpError(409, plan.errors.join(" "));
  if (!plan.processDocumentIds.length && !plan.removeDocumentIds.length) throw new HttpError(409, "This graph is already up to date.");
  const chunks = await ctx.store.documents.chunks(pid, plan.processDocumentIds);
  if (chunks.length > 10000) throw new HttpError(413, "Prepare a smaller source selection (at most 10,000 chunks).");
  const saved: Submission = { id, projectId: pid, plan, chunks, batches: {}, createdAt: iso(ctx.now()) };
  await writeState(ctx, path(pid, id), saved);
  await indexSubmission(ctx, pid, id);
  return saved;
}
async function assertCurrent(ctx: ServiceCtx, saved: Submission) {
  const current = await planUpdate(ctx, saved.projectId, "changes", [], { external: true });
  if (current.hash !== saved.plan.hash)
    stale("Sources, ontology or graph changed. Prepare a new work package; submitted batches remain saved.");
}
export async function submitBatch(
  ctx: ServiceCtx,
  pid: string,
  id: string,
  batchId: string,
  chunkIds: string[],
  input: ABoxResult,
  replaceHash?: string,
) {
  const saved = await getSubmission(ctx, pid, id);
  const hash = digest({ chunkIds, input });
  const previous = saved.batches[batchId];
  if (previous) {
    if (previous.hash === hash) return { batchId, batchHash: hash, received: previous.abox.individuals.length, duplicate: true };
    if (replaceHash !== previous.hash)
      stale("This batch ID has different content. Read its current hash, then supply replaceHash to correct it.");
  }
  if (saved.resultRevisionId) stale("This work package was finalized. Start another update to add facts.");
  await assertCurrent(ctx, saved);
  const chunks = new Map(saved.chunks.filter((c) => chunkIds.includes(c.id)).map((c) => [c.id, c]));
  if (!chunkIds.length || chunks.size !== new Set(chunkIds).size)
    throw new HttpError(400, "Every batch must reference chunks in its work package.");
  if (Object.entries(saved.batches).some(([key, b]) => key !== batchId && b.chunkIds.some((c) => chunkIds.includes(c))))
    stale("A chunk was already submitted. Reuse the original batch ID to retry.");
  const review: FactReview = {
    status: "candidate",
    by: "auto",
    at: iso(ctx.now()),
    reason: "External assistant proposal; quotation locations checked, semantic support requires review.",
  };
  const evidence = (refs?: EvidenceRef[]): EvidenceRef[] =>
    (refs ?? []).slice(0, 20).map((ref) => {
      const chunk = chunks.get(ref.chunkId ?? "");
      if (!chunk) throw new HttpError(400, "Evidence must reference a chunk included in this batch.");
      const hit = locateQuote(ref.quote, chunk.text);
      return {
        documentId: chunk.documentId,
        chunkId: chunk.id,
        quote: ref.quote,
        page: chunk.page,
        status: hit ? "verified" : "unverified",
        review: true,
        ...(hit ? { start: chunk.start + hit.start, end: chunk.start + hit.end } : {}),
      };
    });
  const claim = (refs?: EvidenceRef[]) => {
    const ev = evidence(refs);
    return {
      evidence: ev,
      review: { ...review },
      origins: [
        ...new Map(ev.map((e) => [e.documentId, { kind: "document" as const, documentId: e.documentId, chunkId: e.chunkId }])).values(),
      ],
    };
  };
  const individuals: ABoxIndividual[] = input.individuals.map((i) => ({
    id: i.id,
    classUri: i.classUri,
    ...(i.label ? { label: i.label } : {}),
    ...claim(i.evidence),
    dataProperties: i.dataProperties?.map((d) => ({
      propUri: d.propUri,
      value: d.value,
      ...(d.datatype ? { datatype: d.datatype } : {}),
      ...(d.lang ? { lang: d.lang } : {}),
      ...claim(d.evidence),
    })),
    objectProperties: i.objectProperties?.map((o) => ({ propUri: o.propUri, targetId: o.targetId, ...claim(o.evidence) })),
  }));
  // Even claims without quotes retain their source membership and remain candidates.
  for (const i of individuals)
    for (const c of [i, ...(i.dataProperties ?? []), ...(i.objectProperties ?? [])])
      if (!c.origins?.length)
        c.origins = [...chunks.values()].map((chunk) => ({ kind: "document", documentId: chunk.documentId, chunkId: chunk.id }));
  saved.batches[batchId] = { hash, chunkIds: [...new Set(chunkIds)], abox: { individuals } };
  await writeState(ctx, path(pid, id), saved);
  return { batchId, batchHash: hash, received: individuals.length, duplicate: false };
}
export async function finalizeSubmission(ctx: ServiceCtx, pid: string, id: string) {
  const saved = await getSubmission(ctx, pid, id);
  if (saved.resultRevisionId) return requireRevision(ctx, pid, saved.resultRevisionId);
  await assertCurrent(ctx, saved);
  const covered = new Set(Object.values(saved.batches).flatMap((b) => b.chunkIds));
  if (saved.chunks.some((c) => !covered.has(c.id)))
    throw new HttpError(
      409,
      `${saved.chunks.length - covered.size} chunks remain. Submit a batch for each chunk, including an empty result when no facts were found.`,
    );
  const base = await requireRevision(ctx, pid, saved.plan.baseRevisionId);
  const schema = await requireRevision(ctx, saved.plan.ontology.projectId, saved.plan.ontology.revisionId);
  const pruned = withoutSources(base.content.abox ?? { individuals: [] }, new Set(saved.plan.removeDocumentIds));
  const incoming = mergeAboxes(Object.values(saved.batches).map((b) => b.abox)).abox;
  const previous = base.content.abox ?? { individuals: [] };
  const proposed = respectCorpusEdits(preserveCorpusDecisions(incoming, previous), previous, base.content.corpus!.suppressed);
  const abox = mergeAboxes([pruned.abox, proposed]).abox;
  const content: RevisionContent = {
    ...base.content,
    modules: schema.content.modules,
    abox,
    corpus: {
      ...base.content.corpus!,
      ontology: saved.plan.ontology,
      planHash: saved.plan.hash,
      losses: pruned.losses,
      sources: [
        ...base.content.corpus!.sources.filter((s) => !saved.plan.removeDocumentIds.includes(s.documentId)),
        ...saved.plan.sources
          .filter((s) => s.document && saved.plan.processDocumentIds.includes(s.document.id))
          .map((s) => ({
            memberId: s.member.id,
            documentId: s.document!.id,
            checksum: s.document!.checksum,
            fingerprint: s.fingerprint,
            chunks: s.document!.chunkCount,
            cached: 0,
            screened: 0,
            runId: "",
          })),
      ],
    },
  };
  const errors = validateABox(abox, tboxOf(content), content.baseIri).filter((e) => e.severity === "error");
  if (errors.length)
    throw new HttpError(
      422,
      `Fact submission has schema errors: ${errors
        .slice(0, 5)
        .map((e) => e.message)
        .join("; ")}. Correct the affected batches using replaceHash, then finalize again.`,
    );
  const revisionId = `rev_${digest(id).slice(0, 20)}`;
  const existing = await ctx.store.revisions.get(pid, revisionId);
  const revision =
    existing ??
    (await createRevision(ctx, pid, {
      id: revisionId,
      parentId: base.id,
      content,
      source: "extraction",
      summary: "External assistant extraction — review proposed facts and evidence",
      corpusInternal: true,
    }));
  saved.resultRevisionId = revision.id;
  await writeState(ctx, path(pid, id), saved);
  return revision;
}
