import { tboxHash } from "./ontology.ts";
import { mappingIsCurrent } from "../../src/lib/alignment.ts";
import { corpusUserEdit, normalizeCorpusLiterals } from "../../src/lib/corpusGraph.ts";
// Revisions: draft → validate → commit. Committed revisions are immutable; a
// change is always a new draft based on the current revision, and committing
// fails with 409 when someone else committed in between (stale parent).
// Restoring an old revision commits a NEW revision with its content.

import type { OntologyRevision, RevisionContent, RevisionDiff, RevisionSource, RevisionWithContent } from "../../src/types/project.ts";
import type { ABoxIndividual, ABoxResult, ManualEdit } from "../../src/types/abox.ts";
import type { OntoModule } from "../../src/types/validation.ts";
import { diffContents } from "../../src/lib/ontology/aboxMerge.ts";
import { HttpError } from "../http.ts";
import { ConflictError } from "../store/types.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject, touchProject } from "./projects.ts";
import { contentHash, contentStats, tboxOf } from "./ontology.ts";
import { migrateAbox } from "./migration.ts";

const MAX_MODULES = 200;
/** manual-edit audit entries kept per draft (oldest dropped first) */
const MAX_EDITS = 1000;

/** Original facts are read from immutable checkpoints or a saved parent, never trusted from an undo request. */
const corpusOriginals = new Map<string, ABoxResult>();
async function originalCorpusFacts(ctx: ServiceCtx, pid: string, rev: RevisionWithContent): Promise<ABoxResult | undefined> {
  const key = `${ctx.user.id}/${pid}/${rev.id}`,
    hit = corpusOriginals.get(key);
  if (hit) return hit;
  const run = (await ctx.store.runs.list(pid)).find((r) => r.resultRevisionId === rev.id);
  const original = run
    ? (await ctx.store.runs.checkpoints(pid, run.id)).find((c) => c.key === "finalize")?.abox
    : rev.parentId
      ? (await requireRevision(ctx, pid, rev.parentId)).content.abox
      : undefined;
  if (original) {
    corpusOriginals.set(key, original);
    if (corpusOriginals.size > 10) corpusOriginals.delete(corpusOriginals.keys().next().value!);
  }
  return original ?? undefined;
}

/** Validate untrusted revision content from a request body. */
export function parseContent(v: unknown): RevisionContent {
  if (!v || typeof v !== "object") throw new HttpError(400, "content is required");
  const c = v as Record<string, unknown>;
  if (!Array.isArray(c.modules)) throw new HttpError(400, "content.modules must be an array");
  const resolution =
    c.resolution && typeof c.resolution === "object" && Array.isArray((c.resolution as { candidates?: unknown }).candidates)
      ? (c.resolution as RevisionContent["resolution"])
      : undefined;
  if (c.modules.length > MAX_MODULES) throw new HttpError(400, `At most ${MAX_MODULES} modules per revision.`);
  const modules: OntoModule[] = c.modules.map((m, i) => {
    const mm = (m ?? {}) as Record<string, unknown>;
    if (typeof mm.turtle !== "string") throw new HttpError(400, `content.modules[${i}].turtle must be a string`);
    return {
      id: typeof mm.id === "string" && mm.id ? mm.id.slice(0, 80) : newId("mod"),
      name: typeof mm.name === "string" && mm.name ? mm.name.slice(0, 200) : `module-${i + 1}.ttl`,
      turtle: mm.turtle,
    };
  });
  let abox: ABoxResult | null = null;
  if (c.abox != null) {
    const a = c.abox as Record<string, unknown>;
    if (!Array.isArray(a.individuals)) throw new HttpError(400, "content.abox.individuals must be an array");
    abox = {
      individuals: (a.individuals as ABoxIndividual[]).filter((i) => i && typeof i.id === "string" && typeof i.classUri === "string"),
    };
  }
  const baseIri = typeof c.baseIri === "string" ? c.baseIri.slice(0, 500) : "";
  const migration = c.migration && typeof c.migration === "object" ? (c.migration as RevisionContent["migration"]) : undefined;
  const review = c.review && typeof c.review === "object" ? (c.review as RevisionContent["review"]) : undefined;
  const edits = Array.isArray(c.edits)
    ? (c.edits as ManualEdit[]).filter((e) => e && typeof e.at === "string" && typeof e.target === "string").slice(-MAX_EDITS)
    : undefined;
  return {
    modules,
    abox,
    baseIri,
    ...(resolution ? { resolution } : {}),
    ...(migration ? { migration } : {}),
    ...(review ? { review } : {}),
    ...(edits?.length ? { edits } : {}),
  };
}

export async function requireRevision(ctx: ServiceCtx, projectId: string, id: string): Promise<RevisionWithContent> {
  const rev = await ctx.store.revisions.get(projectId, id).catch(() => null);
  if (!rev) throw new HttpError(404, "Revision not found.");
  return rev;
}

/**
 * T-Box and A-Box are versioned separately (B5): walking the committed chain
 * in order, a half's version number increments only when its hash changes, and
 * each revision says which half it changed relative to its parent.
 */
export function withVersions(revs: OntologyRevision[]): OntologyRevision[] {
  const committed = revs.filter((r) => r.status === "committed").sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const versions = new Map<string, { t: number; a: number }>();
  let t = 0;
  let a = 0;
  let prev: OntologyRevision | null = null;
  for (const r of committed) {
    const tChanged = !prev || !r.stats.tboxHash || r.stats.tboxHash !== prev.stats.tboxHash;
    const aChanged = !prev || !r.stats.aboxHash || r.stats.aboxHash !== prev.stats.aboxHash;
    if (tChanged && (r.stats.modules > 0 || t > 0)) t++;
    if (aChanged && (r.stats.individuals > 0 || a > 0)) a++;
    versions.set(r.id, { t, a });
    prev = r;
  }
  const byId = new Map(revs.map((r) => [r.id, r]));
  return revs.map((r) => {
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    const tDiff = !parent || r.stats.tboxHash !== parent.stats.tboxHash;
    const aDiff = !parent ? r.stats.individuals > 0 : r.stats.aboxHash !== parent.stats.aboxHash;
    const known = !!r.stats.tboxHash && (!parent || !!parent.stats.tboxHash);
    const v = versions.get(r.id);
    return {
      ...r,
      tboxVersion: v ? v.t || null : null,
      aboxVersion: v ? v.a || null : null,
      ...(known ? { scope: tDiff && aDiff ? "both" : tDiff ? "tbox" : aDiff ? "abox" : "none" } : {}),
    } satisfies OntologyRevision;
  });
}

export async function listRevisions(ctx: ServiceCtx, projectId: string): Promise<OntologyRevision[]> {
  await requireProject(ctx, projectId);
  return withVersions(await ctx.store.revisions.list(projectId));
}

/**
 * When the T-Box changes under existing individuals, rename what was renamed
 * and flag what now uses a removed term (the report rides on the content).
 */
async function migrateIfSchemaChanged(
  ctx: ServiceCtx,
  projectId: string,
  parentId: string | null,
  content: RevisionContent,
): Promise<RevisionContent> {
  if (!parentId || !content.abox?.individuals.length || !content.modules.length) return content;
  const parent = await ctx.store.revisions.get(projectId, parentId).catch(() => null);
  if (!parent || !parent.content.modules.length) return content;
  const same =
    parent.content.modules.length === content.modules.length &&
    parent.content.modules.every((m, i) => m.turtle === content.modules[i]?.turtle);
  if (same) return content;
  try {
    const { abox, report } = migrateAbox(tboxOf(parent.content), tboxOf(content), content.abox);
    if (!report.renamed.length && !report.flagged.length) return content;
    return { ...content, abox, migration: report };
  } catch {
    return content; // an unparseable T-Box is reported by validation, not here
  }
}

/**
 * A draft's edit log covers the edits made on that draft. Content copied from
 * the parent carries the parent's log along; those entries were committed with
 * the parent and stay there.
 */
async function withoutInheritedEdits(
  ctx: ServiceCtx,
  projectId: string,
  parentId: string | null,
  content: RevisionContent,
): Promise<RevisionContent> {
  if (!parentId || !content.edits?.length) return content;
  const parent = await ctx.store.revisions.get(projectId, parentId).catch(() => null);
  const inherited = parent?.content.edits ?? [];
  if (!inherited.length) return content;
  let n = 0;
  while (n < inherited.length && n < content.edits.length && JSON.stringify(inherited[n]) === JSON.stringify(content.edits[n])) n++;
  if (n < inherited.length) return content; // not a copy of the parent's log
  const { edits: _all, ...rest } = content;
  void _all;
  const own = content.edits.slice(n);
  return own.length ? { ...rest, edits: own } : rest;
}

/** The project's current committed revision, or null for a fresh project. */
export async function currentRevision(ctx: ServiceCtx, projectId: string): Promise<RevisionWithContent | null> {
  const project = await requireProject(ctx, projectId);
  return project.currentRevisionId ? requireRevision(ctx, projectId, project.currentRevisionId) : null;
}

export interface CreateRevisionInput {
  /** Trusted recovery identity for an application action. */
  id?: string;
  /** Set by trusted corpus services; never parsed from a public revision request. */
  corpusInternal?: boolean;
  parentId?: string | null;
  content: RevisionContent;
  source: RevisionSource;
  summary: string;
  runId?: string;
}

export async function createRevision(ctx: ServiceCtx, projectId: string, input: CreateRevisionInput): Promise<OntologyRevision> {
  const project = await requireProject(ctx, projectId);
  const parentId = input.parentId === undefined ? project.currentRevisionId : input.parentId;
  if (project.settings.corpus && input.content.abox)
    input = { ...input, content: { ...input.content, abox: normalizeCorpusLiterals(input.content.abox, tboxOf(input.content)) } };
  if (parentId) await requireRevision(ctx, projectId, parentId);
  if (project.settings.corpus && !input.corpusInternal) {
    const parent = parentId ? await requireRevision(ctx, projectId, parentId) : null;
    if (!parent?.content.corpus) throw new HttpError(409, "Use corpus setup to choose a pinned ontology.");
    if (tboxHash(parent.content) !== tboxHash(input.content))
      throw new HttpError(409, "Corpus ontologies are pinned. Choose an ontology upgrade in corpus settings.");
    input = { ...input, content: corpusUserEdit(parent.content, input.content) };
  }

  input = { ...input, content: await migrateIfSchemaChanged(ctx, projectId, parentId, input.content) };
  input = { ...input, content: await withoutInheritedEdits(ctx, projectId, parentId, input.content) };
  const now = iso(ctx.now());
  const rev: OntologyRevision = {
    id: input.id ?? newId("rev"),
    projectId,
    parentId,
    number: null,
    status: "draft",
    source: input.source,
    summary: input.summary.slice(0, 2000),
    contentHash: contentHash(input.content),
    stats: contentStats(input.content),
    ...(input.runId ? { runId: input.runId } : {}),
    createdBy: ctx.user.id,
    createdAt: now,
    updatedAt: now,
  };
  const created = await ctx.store.revisions.create(rev, input.content);
  ctx.log.info("revision.draft_created", { requestId: ctx.requestId, projectId, revisionId: created.id, source: input.source });
  return created;
}

export async function updateDraft(
  ctx: ServiceCtx,
  projectId: string,
  id: string,
  content: RevisionContent,
  summary?: string,
  corpusInternal = false,
  expectedHash?: string,
): Promise<OntologyRevision> {
  const rev = await requireRevision(ctx, projectId, id);
  if (rev.status !== "draft") throw new HttpError(409, "Committed revisions cannot be changed — start a new draft.");
  if (rev.content.corpus && content.abox) content = { ...content, abox: normalizeCorpusLiterals(content.abox, tboxOf(content)) };
  if (rev.content.corpus && !corpusInternal) {
    if (tboxHash(rev.content) !== tboxHash(content)) throw new HttpError(409, "Choose an ontology upgrade through corpus settings.");
    content = corpusUserEdit(rev.content, content, await originalCorpusFacts(ctx, projectId, rev));
  }

  content = await withoutInheritedEdits(ctx, projectId, rev.parentId, content);
  try {
    return await ctx.store.revisions.updateDraft(
      projectId,
      id,
      {
        summary: summary?.slice(0, 2000) ?? rev.summary,
        contentHash: contentHash(content),
        stats: contentStats(content),
        updatedAt: iso(ctx.now()),
      },
      content,
      expectedHash ?? (ctx.store.revisionPreconditions ? rev.contentHash : undefined),
    );
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, e.message);
    throw e;
  }
}

/** Re-point a stale draft at the current revision (the user chose to keep their version). */
export async function rebaseDraft(ctx: ServiceCtx, projectId: string, id: string): Promise<OntologyRevision> {
  const project = await requireProject(ctx, projectId);
  if (project.settings.corpus)
    throw new HttpError(409, "The corpus graph changed. Review a fresh update against the latest graph version; this draft is preserved.");
  const rev = await requireRevision(ctx, projectId, id);
  if (rev.status !== "draft") throw new HttpError(409, "Only drafts can be rebased.");
  return ctx.store.revisions.updateDraft(
    projectId,
    id,
    {
      summary: rev.summary,
      contentHash: rev.contentHash,
      stats: rev.stats,
      updatedAt: iso(ctx.now()),
      parentId: project.currentRevisionId,
    },
    rev.content,
  );
}

export async function commitRevision(ctx: ServiceCtx, projectId: string, id: string, expectedHash?: string): Promise<OntologyRevision> {
  const rev = await requireRevision(ctx, projectId, id);
  if (rev.status !== "draft") throw new HttpError(409, "This revision is already committed.");
  if (rev.content.review?.alignment?.some((mapping) => mapping.status === "accepted" && !mappingIsCurrent(mapping, rev.content)))
    throw new HttpError(
      409,
      "Accepted mappings refer to changed ontology inputs. Run alignment again or return those mappings to review before saving this version.",
    );
  if (rev.content.corpus) {
    if (rev.content.corpus.losses.some((l) => l.decision === "pending"))
      throw new HttpError(409, "Review facts losing source support before saving this graph version.");
    const project = await requireProject(ctx, projectId),
      members = project.settings.corpus?.members ?? [];
    if (
      rev.source !== "restore" &&
      rev.content.corpus.sources.some(
        (source) => !members.some((m) => m.id === source.memberId && !m.removed && m.headDocumentId === source.documentId),
      )
    )
      throw new HttpError(
        409,
        "Corpus source versions changed while this draft was prepared. Review an updated extraction plan. This draft is preserved.",
      );
  }
  try {
    const committed = await ctx.store.revisions.commit(projectId, id, rev.parentId, iso(ctx.now()), expectedHash);
    ctx.log.info("revision.committed", { requestId: ctx.requestId, projectId, revisionId: id, number: committed.number ?? 0 });
    return committed;
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, e.message);
    throw e;
  }
}

export async function discardDraft(ctx: ServiceCtx, projectId: string, id: string): Promise<void> {
  const rev = await requireRevision(ctx, projectId, id);
  if (rev.status !== "draft") throw new HttpError(409, "Committed revisions are kept in history and cannot be deleted.");
  await ctx.store.revisions.delete(projectId, id);
}

/** Restore = commit a new revision whose content is an older revision's. */
export async function restoreRevision(ctx: ServiceCtx, projectId: string, id: string): Promise<OntologyRevision> {
  const old = await requireRevision(ctx, projectId, id);
  if (old.status !== "committed") throw new HttpError(409, "Only committed revisions can be restored.");
  const draft = await createRevision(ctx, projectId, {
    content: old.content,
    source: "restore",
    corpusInternal: !!old.content.corpus,
    summary: `Restored revision ${old.number}`,
  });
  const committed = await commitRevision(ctx, projectId, draft.id);
  await touchProject(ctx, projectId);
  return committed;
}

export async function compareRevisions(ctx: ServiceCtx, projectId: string, fromId: string | null, toId: string): Promise<RevisionDiff> {
  const to = await requireRevision(ctx, projectId, toId);
  const from = fromId
    ? await requireRevision(ctx, projectId, fromId)
    : to.parentId
      ? await requireRevision(ctx, projectId, to.parentId)
      : null;
  return diffContents(from?.content ?? null, to.content);
}
