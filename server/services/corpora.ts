import { validateABox } from "../../src/lib/ontology/aboxValidator.ts";
import { createHash } from "node:crypto";
import type { Project, ProjectDocument, RevisionContent } from "../../src/types/project.ts";
import type {
  CorpusMetadata,
  CorpusPlan,
  CorpusRunContext,
  CorpusSourceView,
  CorpusUpdateMode,
  OntologyPin,
} from "../../src/types/corpus.ts";
import type { ResearchInputs, ChunkSettings } from "../../src/types/research.ts";
import { corpusChanges, withoutSources, retainLostFact, corpusIdentityIndex, decideCorpusReplacement } from "../../src/lib/corpusGraph.ts";
import { chunkSettingsKey } from "../../src/lib/research.ts";
import { ConflictError } from "../store/types.ts";
import { HttpError } from "../http.ts";
import { MAX_SOURCES_PER_CORPUS } from "../config.ts";
import { defaultGenerationBudget, embeddingProfiles } from "../ml/tokenization.ts";
import { listProviders, resolveModel } from "../providers.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject } from "./projects.ts";
import { createRevision, currentRevision, requireRevision, listRevisions, updateDraft } from "./revisions.ts";
import { tboxHash, tboxOf, contentHash, contentStats } from "./ontology.ts";
import { uploadDocument } from "./documents.ts";
import { previewChunks, saveChunkVariant, validateChunkSettings } from "./research.ts";
import { createRun, estimateRun, retryRun, PROMPT_VERSION } from "./runs.ts";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
      ),
    )
    .digest("hex");
export async function requireCorpus(ctx: ServiceCtx, id: string) {
  const p = await requireProject(ctx, id);
  if (!p.settings.corpus) throw new HttpError(404, "Corpus not found.");
  await requireProject(ctx, p.settings.corpus.parentProjectId);
  return p;
}
async function pinFor(ctx: ServiceCtx, parentId: string, revisionId: string): Promise<OntologyPin> {
  const revision = await requireRevision(ctx, parentId, revisionId);
  if (revision.status !== "committed" || !revision.content.modules.length)
    throw new HttpError(409, "Choose a saved ontology version before creating or upgrading a corpus.");
  tboxOf(revision.content);
  const meta = (await listRevisions(ctx, parentId)).find((r) => r.id === revisionId)!;
  const parent = await requireProject(ctx, parentId);
  return {
    projectId: parentId,
    revisionId,
    number: meta.tboxVersion ?? revision.number!,
    hash: tboxHash(revision.content),
    name: parent.name,
  };
}
async function mutate(ctx: ServiceCtx, id: string, fn: (meta: CorpusMetadata) => CorpusMetadata | Promise<CorpusMetadata>) {
  for (let n = 0; n < 8; n++) {
    const p = await requireCorpus(ctx, id),
      c = p.settings.corpus!;
    const next = await fn(structuredClone(c));
    try {
      return await ctx.store.projects.compareAndSwapSettings(
        id,
        p.settings,
        { ...p.settings, corpus: { ...next, version: c.version + 1 } },
        iso(ctx.now()),
      );
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new HttpError(409, "Corpus sources changed repeatedly. Refresh and try again.");
}
export async function listCorpora(ctx: ServiceCtx, parentId: string) {
  const parent = await requireProject(ctx, parentId);
  if (parent.settings.corpus) throw new HttpError(400, "Corpora belong to an ontology project.");
  return (await ctx.store.projects.list())
    .filter(
      (p) =>
        (p.settings.corpus?.parentProjectId === parentId && p.currentRevisionId) || p.settings.externalGraph?.parentProjectId === parentId,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createCorpus(
  ctx: ServiceCtx,
  parentId: string,
  input: { name?: string; ontologyRevisionId?: string; provider?: string; model?: string },
  identity?: string,
) {
  const parent = await requireProject(ctx, parentId);
  if (parent.settings.corpus) throw new HttpError(400, "Nested corpora are not supported.");
  const name = input.name?.trim();
  if (!name || name.length > 200) throw new HttpError(400, "Enter a corpus name of 1–200 characters.");
  const ontology = await pinFor(ctx, parentId, input.ontologyRevisionId ?? parent.currentRevisionId ?? "");
  const schema = await requireRevision(ctx, parentId, ontology.revisionId);
  const enabled = listProviders().find((p) => p.enabled),
    provider = input.provider ?? parent.settings.provider ?? enabled?.id,
    model = input.model ?? parent.settings.model;
  const resolved = provider ? resolveModel(provider, model, { structured: true }) : null;
  const profile =
    embeddingProfiles().find((p) =>
      parent.settings.models?.embeddings === "provider"
        ? p.backend === "provider"
        : ["off", "hash"].includes(parent.settings.models?.embeddings ?? "")
          ? p.backend === "hash"
          : p.backend === "local",
    ) ?? embeddingProfiles()[0];
  const chunking: ChunkSettings = resolved
    ? {
        method: "section",
        maxChars: 12000,
        overlap: 0.12,
        unit: "tokens",
        tokens: {
          embedding: { profile: profile.id, maxTokens: Math.min(256, profile.inputLimit) },
          generation: defaultGenerationBudget(resolved.provider, resolved.model),
        },
      }
    : { method: "section", maxChars: 12000, overlap: 0.12 };
  const now = iso(ctx.now()),
    p: Project = {
      id: identity ?? newId("cor"),
      ownerId: ctx.user.id,
      name,
      purpose: "Knowledge extracted from this corpus",
      scope: "",
      competencyQuestions: [],
      settings: {
        ...(resolved ? { provider: resolved.provider, model: resolved.model } : {}),
        models: parent.settings.models,
        budget: parent.settings.budget,
        reviewPolicy: "accepted-only",
        corpus: {
          parentProjectId: parentId,
          parentName: parent.name,
          version: 1,
          members: [],
          requestedOntologyRevisionId: ontology.revisionId,
          chunking,
        },
      },
      currentRevisionId: null,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
  const incomplete = identity ? await ctx.store.projects.get(identity) : null;
  if (!incomplete) await ctx.store.projects.create(p);
  try {
    const content: RevisionContent = {
      modules: schema.content.modules,
      abox: { individuals: [] },
      baseIri: schema.content.baseIri,
      corpus: { reviewPolicy: "accepted-only", ontology, sources: [], suppressed: [], losses: [] },
    };
    const seed = {
      id: identity ? `rev_${hash(identity).slice(0, 20)}` : newId("rev"),
      projectId: p.id,
      parentId: null,
      number: 0,
      status: "committed" as const,
      source: "import" as const,
      summary: `Corpus created using ontology version ${ontology.number}`,
      contentHash: contentHash(content),
      stats: contentStats(content),
      createdBy: ctx.user.id,
      createdAt: now,
      updatedAt: now,
      committedAt: now,
    };
    if (!(await ctx.store.revisions.get(p.id, seed.id))) await ctx.store.revisions.create(seed, content);
    await ctx.store.projects.update(p.id, { currentRevisionId: seed.id });
  } catch (e) {
    await ctx.store.projects.delete(p.id);
    throw e;
  }
  return (await ctx.store.projects.get(p.id))!;
}
export async function corpusDetail(ctx: ServiceCtx, id: string) {
  const p = await requireCorpus(ctx, id);
  const graph = await currentRevision(ctx, id);
  const documents = await ctx.store.documents.list(id);
  return { corpus: p, graph, documents, revisions: await listRevisions(ctx, id) };
}
export async function addCorpusDocument(ctx: ServiceCtx, id: string, name: string, bytes: Buffer, memberId?: string) {
  let p = await requireCorpus(ctx, id);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const c = p.settings.corpus!,
    duplicate = c.members.find((m) => m.versions.some((v) => v.checksum === checksum));
  if (duplicate) {
    const version = duplicate.versions.find((v) => v.checksum === checksum)!;
    return {
      duplicate: true,
      member: duplicate,
      document: await ctx.store.documents.get(id, version.documentId),
      message: duplicate.removed
        ? "Already retained in this corpus. Restore the source to include it again."
        : version.documentId === duplicate.headDocumentId
          ? "Already in this corpus."
          : "This file is already retained as an earlier source version. The current version was kept.",
    };
  }
  if (memberId && !c.members.some((m) => m.id === memberId && !m.removed)) throw new HttpError(404, "Source not found.");
  if (!memberId && c.members.length >= MAX_SOURCES_PER_CORPUS)
    throw new HttpError(
      409,
      `This corpus has reached its limit of ${MAX_SOURCES_PER_CORPUS} source documents. Replacements and existing versions remain available.`,
    );
  const doc = await uploadDocument(ctx, id, name, bytes, { deferParsing: true, allowDuplicate: true, chunking: c.chunking });
  let attached = false;
  p = await mutate(ctx, id, (meta) => {
    const dup = meta.members.find((m) => m.versions.some((v) => v.checksum === checksum));
    if (dup) return meta;
    if (!memberId && meta.members.length >= MAX_SOURCES_PER_CORPUS)
      throw new HttpError(409, `This corpus has reached its limit of ${MAX_SOURCES_PER_CORPUS} source documents.`);
    if (memberId) {
      const member = meta.members.find((m) => m.id === memberId && !m.removed);
      if (!member) throw new HttpError(409, "Source was removed while uploading. Add it as a new source instead.");
      if (member.headDocumentId !== c.members.find((m) => m.id === memberId)!.headDocumentId)
        throw new HttpError(409, "A newer source version was uploaded first. Refresh before replacing it.");
      member.headDocumentId = doc.id;
      member.name = doc.name;
      member.versions.push({
        documentId: doc.id,
        checksum,
        number: Math.max(...member.versions.map((v) => v.number)) + 1,
        createdAt: doc.createdAt,
      });
    } else
      meta.members.push({
        id: newId("src"),
        name: doc.name,
        headDocumentId: doc.id,
        removed: false,
        versions: [{ documentId: doc.id, checksum, number: 1, createdAt: doc.createdAt }],
      });
    attached = true;
    return meta;
  });
  const member = p.settings.corpus!.members.find((m) => m.versions.some((v) => v.checksum === checksum))!;
  if (!member.versions.some((v) => v.documentId === doc.id)) {
    await ctx.store.documents.delete(id, doc.id);
    await ctx.store.blobs.delete(doc.storagePath);
    return {
      duplicate: true,
      member,
      document: await ctx.store.documents.get(id, member.headDocumentId),
      message: "Already in this corpus.",
    };
  }
  void attached;
  return { duplicate: false, member, document: doc };
}
export async function setSourceState(ctx: ServiceCtx, id: string, memberId: string, input: { removed?: boolean; documentId?: string }) {
  return mutate(ctx, id, (c) => {
    const m = c.members.find((m) => m.id === memberId);
    if (!m) throw new HttpError(404, "Source not found.");
    if (input.documentId) {
      if (!m.versions.some((v) => v.documentId === input.documentId)) throw new HttpError(404, "Source version not found.");
      m.headDocumentId = input.documentId;
    }
    if (input.removed !== undefined) m.removed = input.removed;
    return c;
  });
}
export async function sourceImpact(ctx: ServiceCtx, id: string, memberId: string) {
  const p = await requireCorpus(ctx, id),
    m = p.settings.corpus!.members.find((m) => m.id === memberId);
  if (!m) throw new HttpError(404, "Source not found.");
  const current = await currentRevision(ctx, id),
    impact = withoutSources(current?.content.abox ?? { individuals: [] }, new Set(m.versions.map((v) => v.documentId)));
  return { lost: impact.losses.length, retained: impact.retained };
}
export async function setPreparation(ctx: ServiceCtx, id: string, memberId: string, documentId: string) {
  const doc = await ctx.store.documents.get(id, documentId);
  if (!doc || doc.parseState !== "parsed" || !doc.chunkCount) throw new HttpError(409, "Prepare this source before selecting its chunks.");
  return mutate(ctx, id, (c) => {
    const m = c.members.find((m) => m.id === memberId && !m.removed);
    if (!m) throw new HttpError(404, "Source not found.");
    const known = m.versions.find((v) => v.documentId === doc.id || v.documentId === doc.variantOf);
    if (!known) throw new HttpError(409, "These chunks belong to another source version. Refresh and use the current version.");
    if (!m.versions.some((v) => v.documentId === doc.id))
      m.versions.push({ documentId: doc.id, checksum: doc.checksum, number: known.number, createdAt: doc.createdAt, preparation: true });
    const headVersion = m.versions.find((v) => v.documentId === m.headDocumentId);
    if (headVersion?.checksum !== doc.checksum || headVersion.number !== known.number)
      throw new HttpError(409, "The source file changed while preparing chunks. Refresh and prepare its current version.");
    m.headDocumentId = doc.id;
    return c;
  });
}
export async function prepareSource(ctx: ServiceCtx, id: string, memberId: string) {
  const p = await requireCorpus(ctx, id),
    m = p.settings.corpus!.members.find((m) => m.id === memberId && !m.removed);
  if (!m) throw new HttpError(404, "Source not found.");
  const settings = p.settings.corpus!.chunking;
  if (!settings) throw new HttpError(409, "Choose preparation models and budgets in corpus settings.");
  const preview = await previewChunks(ctx, id, m.headDocumentId, settings);
  const doc = await saveChunkVariant(ctx, id, m.headDocumentId, settings, preview.textHash);
  await setPreparation(ctx, id, memberId, doc.id);
  return doc;
}
export async function updateCorpusSettings(
  ctx: ServiceCtx,
  id: string,
  input: { name?: string; ontologyRevisionId?: string; provider?: string; model?: string; chunking?: ChunkSettings },
) {
  const p = await requireCorpus(ctx, id);
  if (input.ontologyRevisionId) await pinFor(ctx, p.settings.corpus!.parentProjectId, input.ontologyRevisionId);
  if (input.chunking) input.chunking = validateChunkSettings(input.chunking);
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200))
    throw new HttpError(400, "Enter a corpus name of 1–200 characters.");
  const provider = input.provider ?? p.settings.provider,
    model = input.model ?? p.settings.model;
  if (provider) resolveModel(provider, model, { structured: true });
  for (let n = 0; n < 8; n++) {
    const current = await requireCorpus(ctx, id);
    const meta = current.settings.corpus!;
    try {
      const next = await ctx.store.projects.compareAndSwapSettings(
        id,
        current.settings,
        {
          ...current.settings,
          provider,
          model,
          corpus: {
            ...meta,
            version: meta.version + 1,
            ...(input.ontologyRevisionId ? { requestedOntologyRevisionId: input.ontologyRevisionId } : {}),
            ...(input.chunking ? { chunking: input.chunking } : {}),
          },
        },
        iso(ctx.now()),
      );
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > 200) throw new HttpError(400, "Enter a corpus name of 1–200 characters.");
        return ctx.store.projects.update(id, { name });
      }
      return next;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new HttpError(409, "Corpus settings changed. Refresh and try again.");
}
export function corpusSourceFingerprint(doc: ProjectDocument, p: Project, pin: OntologyPin) {
  return hash([
    doc.checksum,
    doc.parsing?.textHash,
    doc.preprocessing?.textHash,
    doc.preprocessing ? chunkSettingsKey(doc.preprocessing.settings) : null,
    pin.hash,
    p.settings.provider,
    p.settings.model,
    p.settings.models,
    p.settings.grounding,
    PROMPT_VERSION,
  ]);
}
export async function planUpdate(
  ctx: ServiceCtx,
  id: string,
  mode: CorpusUpdateMode = "changes",
  selected: string[] = [],
  options: { external?: boolean } = {},
): Promise<CorpusPlan> {
  const p = await requireCorpus(ctx, id),
    c = p.settings.corpus!,
    base = await currentRevision(ctx, id);
  if (!base?.content.corpus) throw new HttpError(409, "Corpus graph setup is incomplete.");
  const ontology = await pinFor(ctx, c.parentProjectId, c.requestedOntologyRevisionId),
    documents = await ctx.store.documents.list(id),
    previous = base.content.corpus.sources,
    errors: string[] = [],
    warnings: string[] = [];
  const sources: CorpusSourceView[] = c.members.map((member) => {
    const document = documents.find((d) => d.id === member.headDocumentId) ?? null,
      old = previous.find((s) => s.memberId === member.id),
      key = document ? corpusSourceFingerprint(document, p, ontology) : "";
    let status: CorpusSourceView["status"], reason: string;
    if (member.removed) {
      status = old ? "removal-pending" : "removed";
      reason = old ? "Review the effect of removing this source." : "Retained for graph history.";
    } else if (!document || document.parseState === "failed") {
      status = "attention";
      reason = document?.parseError ?? "Source file is unavailable.";
    } else if (document.parseState === "pending" || document.processing) {
      status = "preparing";
      reason = "Parsing and creating chunks automatically.";
    } else if (!document.chunkCount) {
      status = "attention";
      reason = "Create chunks before extracting knowledge.";
    } else if (old?.documentId === document.id && old.fingerprint === key) {
      status = "included";
      reason = "This source version and extraction configuration are already included.";
    } else {
      status = old ? "updated" : "new";
      reason = !old
        ? "Ready for its first extraction."
        : old.documentId !== document.id
          ? "A new source version or chunk preparation needs processing."
          : ontology.hash !== base.content.corpus!.ontology.hash
            ? "The selected ontology upgrade requires reprocessing."
            : "Extraction settings changed.";
    }
    return { member, document, status, reason, fingerprint: key, ...(old ? { previous: old } : {}) };
  });
  const active = sources.filter((s) => !s.member.removed),
    process = active.filter(
      (s) => mode === "rebuild" || (mode === "reprocess" && selected.includes(s.member.id)) || s.status !== "included",
    ),
    processDocumentIds = process.flatMap((s) => (s.document ? [s.document.id] : []));
  for (const s of process) if (["attention", "preparing"].includes(s.status)) errors.push(`${s.member.name}: ${s.reason}`);
  const removeDocumentIds = previous
    .filter(
      (old) => mode === "rebuild" || !active.some((s) => s.member.id === old.memberId) || process.some((s) => s.member.id === old.memberId),
    )
    .map((s) => s.documentId);
  const impact = withoutSources(base.content.abox ?? { individuals: [] }, new Set(removeDocumentIds));
  if (ontology.hash !== base.content.corpus.ontology.hash)
    warnings.push(
      "The current graph keeps its existing ontology until this upgrade is reviewed and saved. All active sources are reconsidered.",
    );
  let estimatedUsd: number | null = null,
    calls = 0,
    inputTokens = 0,
    outputTokens = 0;
  if (!options.external && process.length && !errors.length && p.settings.provider && p.settings.model) {
    try {
      const estimate = await estimateRun(ctx, id, {
        kind: "extraction",
        documentIds: processDocumentIds,
        mode: "automatic",
        provider: p.settings.provider,
        model: p.settings.model,
        options: { incremental: true },
        corpus: {
          corpusId: id,
          mode,
          baseGraphRevisionId: base.id,
          baseContent: { ...base.content, modules: (await requireRevision(ctx, c.parentProjectId, ontology.revisionId)).content.modules },
          nextSources: [],
          membersVersion: c.version,
        },
      });
      estimatedUsd = estimate.usd;
      calls = estimate.modelCalls;
      inputTokens = estimate.inputTokens;
      outputTokens = estimate.outputTokens;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Cannot estimate extraction.");
    }
  }
  if (!options.external && process.length && (!p.settings.provider || !p.settings.model))
    errors.push("Choose an extraction model in corpus settings.");
  const plan: CorpusPlan = {
    corpusId: id,
    hash: hash([
      base.id,
      mode,
      [...selected].sort(),
      ontology.revisionId,
      sources.map((s) => [s.member.id, s.member.headDocumentId, s.member.removed, s.fingerprint]),
    ]),
    mode,
    ontology,
    currentOntology: base.content.corpus.ontology,
    baseRevisionId: base.id,
    sources,
    processDocumentIds,
    removeDocumentIds,
    reused: active.length - process.length,
    errors,
    warnings,
    estimatedUsd,
    calls,
    inputTokens,
    outputTokens,
    affected: { lost: impact.losses.length, retained: impact.retained },
  };
  return plan;
}
export async function startUpdate(
  ctx: ServiceCtx,
  id: string,
  input: { hash: string; mode?: CorpusUpdateMode; selected?: string[]; interactive?: boolean },
) {
  const plan = await planUpdate(ctx, id, input.mode ?? "changes", input.selected ?? []);
  if (plan.hash !== input.hash)
    throw new HttpError(409, "Sources, ontology or extraction settings changed. Review the refreshed extraction plan.");
  if (plan.errors.length) throw new HttpError(409, plan.errors.join("\n"));
  if (!plan.processDocumentIds.length && !plan.removeDocumentIds.length && plan.ontology.hash === plan.currentOntology.hash)
    return { upToDate: true };
  const existingRuns = await ctx.store.runs.list(id);
  const same = existingRuns
    .filter((r) => r.corpus?.planHash === plan.hash && r.status !== "cancelled")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (same?.resultRevisionId) {
    const existing = await requireRevision(ctx, id, same.resultRevisionId);
    if (existing.status === "draft") return { revision: existing };
  }
  if (same && ["queued", "running", "awaiting_answers"].includes(same.status)) return { run: same };
  const runId = same?.status === "failed" ? same.id : newId("run");
  await mutate(ctx, id, async (meta) => {
    if (meta.updateLease && meta.updateLease.id !== runId) {
      const prior = await ctx.store.runs.get(id, meta.updateLease.id);
      if (
        (prior && ["queued", "running", "awaiting_answers"].includes(prior.status)) ||
        (!prior && new Date(meta.updateLease.expiresAt) > ctx.now())
      )
        throw new HttpError(409, "Another corpus update is starting or running. Open its progress before starting another.");
    }
    return { ...meta, updateLease: { id: runId, expiresAt: iso(new Date(ctx.now().getTime() + 300000)) } };
  });
  if (same?.status === "failed") return { run: await retryRun(ctx, id, same.id) };
  const p = await requireCorpus(ctx, id),
    base = await requireRevision(ctx, id, plan.baseRevisionId),
    schema = await requireRevision(ctx, plan.ontology.projectId, plan.ontology.revisionId),
    pruned = withoutSources(base.content.abox ?? { individuals: [] }, new Set(plan.removeDocumentIds)),
    state = base.content.corpus!;
  const keepSources = state.sources.filter((s) => !plan.removeDocumentIds.includes(s.documentId)),
    nextSources = [
      ...keepSources,
      ...plan.sources
        .filter((s) => s.document && plan.processDocumentIds.includes(s.document.id))
        .map((s) => ({
          memberId: s.member.id,
          documentId: s.document!.id,
          fingerprint: s.fingerprint,
          checksum: s.document!.checksum,
          runId: "",
          chunks: s.document!.chunkCount,
          cached: 0,
          screened: 0,
        })),
    ];
  const baseContent: RevisionContent = {
    ...base.content,
    modules: schema.content.modules,
    abox: pruned.abox,
    corpus: { ...state, planHash: plan.hash, ontology: plan.ontology, sources: nextSources, losses: pruned.losses, mode: plan.mode },
  };
  if (!plan.processDocumentIds.length) {
    const draft = await createRevision(ctx, id, {
      content: baseContent,
      source: "extraction",
      summary: "Review source removal and ontology changes",
      corpusInternal: true,
    });
    await mutate(ctx, id, (m) => ({ ...m, updateLease: undefined }));
    return { revision: draft };
  }
  const corpus: CorpusRunContext = {
    identityIndex: corpusIdentityIndex(base.content.abox ?? { individuals: [] }),
    planHash: plan.hash,
    corpusId: id,
    mode: plan.mode,
    baseGraphRevisionId: base.id,
    baseContent,
    nextSources,
    membersVersion: p.settings.corpus!.version,
  };
  const run = await createRun(ctx, id, {
    id: runId,
    kind: "extraction",
    baseRevisionId: base.id,
    documentIds: plan.processDocumentIds,
    mode: input.interactive ? "interactive" : "automatic",
    provider: p.settings.provider!,
    model: p.settings.model!,
    options: { incremental: true, resolveEntities: true, verifyEvidence: true, evidenceGate: "flag" },
    corpus,
  });
  return { run };
}
export async function updateChanges(ctx: ServiceCtx, id: string, revisionId: string) {
  await requireCorpus(ctx, id);
  const revision = await requireRevision(ctx, id, revisionId);
  if (!revision.content.corpus) throw new HttpError(404, "Corpus graph version not found.");
  const base = revision.parentId ? await requireRevision(ctx, id, revision.parentId) : null,
    current = await currentRevision(ctx, id);
  const changes = corpusChanges(base?.content.abox ?? { individuals: [] }, revision.content.abox ?? { individuals: [] });
  const findings = validateABox(revision.content.abox ?? { individuals: [] }, tboxOf(revision.content), revision.content.baseIri);
  changes.conflicts = [
    ...new Set(
      findings
        .filter((f) => ["functional", "disjoint", "inconsistent"].includes(f.code ?? ""))
        .map((f) => `${f.id ?? f.where}|${f.prop ?? ""}`),
    ),
  ];
  return { revision, base, current, changes, findings, stale: revision.status === "draft" && revision.parentId !== current?.id };
}
export async function decideSourceLosses(ctx: ServiceCtx, id: string, revisionId: string, keys: string[], decision: "remove" | "manual") {
  await requireCorpus(ctx, id);
  const revision = await requireRevision(ctx, id, revisionId);
  if (!revision.content.corpus) throw new HttpError(404, "Corpus update not found.");
  const requested = new Set(keys);
  const pending = revision.content.corpus.losses.filter((l) => requested.has(l.key) && l.decision === "pending");
  if (pending.length !== requested.size) throw new HttpError(409, "These source losses changed. Refresh the graph update before deciding.");
  let content = revision.content;
  for (const loss of pending) {
    if (decision === "manual") content = retainLostFact(content, loss);
    else
      content = {
        ...content,
        corpus: { ...content.corpus!, losses: content.corpus!.losses.map((l) => (l.key === loss.key ? { ...l, decision } : l)) },
      };
  }
  return updateDraft(ctx, id, revisionId, content, undefined, true);
}
export async function decideReplacement(
  ctx: ServiceCtx,
  id: string,
  revisionId: string,
  beforeKey: string,
  afterKey: string,
  decision: "proposed" | "previous",
) {
  await requireCorpus(ctx, id);
  const revision = await requireRevision(ctx, id, revisionId);
  const content = decideCorpusReplacement(revision.content, beforeKey, afterKey, decision, iso(ctx.now()));
  if (!content) throw new HttpError(409, "This replacement changed. Refresh the graph update before deciding.");
  return updateDraft(ctx, id, revisionId, content, undefined, true);
}
export async function resolveRelationship(
  ctx: ServiceCtx,
  id: string,
  revisionId: string,
  input: { id: string; targetId?: string; create?: { id: string; label: string; classUri: string }; dismiss?: boolean },
) {
  await requireCorpus(ctx, id);
  const revision = await requireRevision(ctx, id, revisionId),
    content = structuredClone(revision.content),
    abox = content.abox;
  if (!abox) throw new HttpError(404, "Graph not found.");
  const link = abox.unresolved?.find((l) => l.id === input.id);
  if (!link) throw new HttpError(404, "Unresolved relationship not found.");
  if (input.dismiss) link.status = "dismissed";
  else {
    let target = input.targetId;
    if (input.create) {
      if (!input.create.id.trim() || abox.individuals.some((i) => i.id === input.create!.id))
        throw new HttpError(409, "Choose a new entity identifier.");
      if (!tboxOf(content).classes.some((c) => c.uri === input.create!.classUri))
        throw new HttpError(400, "Choose a class in this corpus ontology.");
      abox.individuals.push({
        ...input.create,
        origins: [{ kind: "manual", types: [input.create.classUri] }],
        review: { status: "accepted", by: "user" },
      });
      target = input.create.id;
    }
    if (!target || !abox.individuals.some((i) => i.id === target))
      throw new HttpError(400, "Choose an existing target or create the missing entity.");
    const subject = abox.individuals.find((i) => i.id === link.subjectId);
    if (!subject) throw new HttpError(409, "The source entity is unavailable. Keep this proposal until that entity is restored.");
    (subject.objectProperties ??= []).push({
      propUri: link.propUri,
      targetId: target,
      evidence: link.evidence,
      origins: link.origins,
      review: { status: "accepted", by: "user" },
    });
    abox.unresolved = abox.unresolved!.filter((l) => l.id !== link.id);
  }
  return updateDraft(ctx, id, revisionId, content, undefined, true);
}

export async function reparseSource(ctx: ServiceCtx, id: string, memberId: string) {
  const p = await requireCorpus(ctx, id),
    meta = p.settings.corpus!,
    member = meta.members.find((m) => m.id === memberId && !m.removed);
  if (!member) throw new HttpError(404, "Source not found.");
  const source = await ctx.store.documents.get(id, member.headDocumentId);
  if (!source) throw new HttpError(404, "Source version not found.");
  const bytes = await ctx.store.blobs.get(source.storagePath);
  if (!bytes) throw new HttpError(410, "Original file is unavailable.");
  const document = await uploadDocument(ctx, id, source.name, bytes, {
    deferParsing: true,
    allowDuplicate: true,
    chunking: meta.chunking,
    variantOf: source.id,
  });
  await mutate(ctx, id, (m) => {
    const row = m.members.find((s) => s.id === memberId);
    if (!row || row.removed || row.headDocumentId !== source.id)
      throw new HttpError(409, "Source changed while preparing a processing version. Refresh first.");
    const current = row.versions.find((v) => v.documentId === source.id)!;
    row.versions.push({
      documentId: document.id,
      checksum: document.checksum,
      number: current.number,
      createdAt: document.createdAt,
      preparation: true,
    });
    row.headDocumentId = document.id;
    return m;
  });
  return document;
}
export async function evidenceSnapshot(ctx: ServiceCtx, id: string, runId: string, documentId: string) {
  await requireCorpus(ctx, id);
  const run = await ctx.store.runs.get(id, runId);
  if (!run?.documentIds.includes(documentId)) throw new HttpError(404, "Saved extraction source not found.");
  const bytes = await ctx.store.blobs.get(`${id}/research/${runId}/inputs.json`);
  if (!bytes) throw new HttpError(404, "This extraction has no retained text snapshot.");
  const inputs = JSON.parse(bytes.toString("utf8")) as ResearchInputs;
  const text = inputs.documentTexts?.[documentId];
  if (!text) throw new HttpError(404, "No full text snapshot was recorded for this source.");
  return {
    ...text,
    chunks: inputs.chunks
      .filter((c) => c.documentId === documentId)
      .map(({ text: _text, projectId: _pid, ...c }) => {
        void _text;
        void _pid;
        return c;
      }),
  };
}
