import { gzipSync } from "node:zlib";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type Project,
  type ProjectArchive,
  type RevisionContent,
  type DocumentChunk,
} from "../../src/types/project.ts";
import type { CorpusMetadata } from "../../src/types/corpus.ts";
import { STORAGE_QUOTA_BYTES } from "../config.ts";
import { HttpError } from "../http.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject, createProject } from "./projects.ts";
import { requireRevision } from "./revisions.ts";
import { contentHash, contentStats } from "./ontology.ts";
import { uploadDocument } from "./documents.ts";

async function capture(ctx: ServiceCtx, id: string, ontologyOnly = false): Promise<ProjectArchive> {
  const project = await requireProject(ctx, id),
    [docs, revs, runs, conversations] = await Promise.all([
      ontologyOnly ? Promise.resolve([]) : ctx.store.documents.list(id),
      ctx.store.revisions.list(id),
      ontologyOnly ? Promise.resolve([]) : ctx.store.runs.list(id),
      ontologyOnly ? Promise.resolve([]) : ctx.store.conversations.list(id),
    ]);
  const documents: ProjectArchive["documents"] = [];
  for (const d of docs) {
    const bytes = await ctx.store.blobs.get(d.storagePath);
    if (!bytes) throw new HttpError(409, `Cannot make a complete archive: the original of ${d.name} is unavailable.`);
    const text = await ctx.store.documents.getText(id, d.id);
    documents.push({
      ...d,
      metadata: d,
      base64: bytes.toString("base64"),
      ...(text ? { frozen: { ...text, chunks: await ctx.store.documents.chunks(id, [d.id]) } } : {}),
    });
  }
  const revisions: ProjectArchive["revisions"] = [],
    reports: NonNullable<ProjectArchive["reports"]> = [];
  for (const r of revs.filter((r) => !ontologyOnly || r.status === "committed")) {
    const full = await requireRevision(ctx, id, r.id);
    revisions.push({ ...r, content: full.content });
    const report = await ctx.store.reports.latest(id, r.id);
    if (report) reports.push(report);
  }
  const records: NonNullable<ProjectArchive["runs"]> = [];
  for (const run of runs) {
    const bytes = await ctx.store.blobs.get(`${id}/research/${run.id}/inputs.json`);
    records.push({
      run,
      checkpoints: await ctx.store.runs.checkpoints(id, run.id),
      inputs: bytes ? JSON.parse(bytes.toString("utf8")) : null,
    });
  }
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    sourceProjectId: id,
    exportedAt: iso(ctx.now()),
    project: {
      name: project.name,
      purpose: project.purpose,
      scope: project.scope,
      competencyQuestions: project.competencyQuestions,
      settings: project.settings,
    },
    documents,
    revisions,
    currentRevisionId: project.currentRevisionId,
    conversations: conversations.map((c) => ({ title: c.title, messages: c.messages, createdAt: c.createdAt })),
    runs: records,
    reports,
  };
}
export async function exportBundle(ctx: ServiceCtx, id: string) {
  const project = await requireProject(ctx, id);
  let archive: ProjectArchive;
  if (project.settings.corpus) {
    const parent = await capture(ctx, project.settings.corpus.parentProjectId, true);
    archive = {
      ...parent,
      documents: [],
      revisions: parent.revisions
        .filter((r) => r.status === "committed")
        .map((r) => ({ ...r, content: { modules: r.content.modules, abox: null, baseIri: r.content.baseIri } })),
      conversations: [],
      runs: [],
      reports: [],
      corpora: [await capture(ctx, id)],
    };
  } else {
    archive = await capture(ctx, id);
    archive.corpora = await Promise.all(
      (await ctx.store.projects.list()).filter((p) => p.settings.corpus?.parentProjectId === id).map((p) => capture(ctx, p.id)),
    );
  }
  const name =
    project.name
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "project";
  return { bytes: gzipSync(Buffer.from(JSON.stringify(archive))), filename: `${name}.ontolab.json.gz` };
}
interface ImportScope {
  archive: ProjectArchive;
  project: Project;
  oldId: string;
  docs: Map<string, string>;
  chunks: Map<string, string>;
  revisions: Map<string, string>;
  runs: Map<string, string>;
  members: Map<string, string>;
  steps: Map<string, string>;
}
const mapped = (map: Map<string, string>, v: unknown) => (typeof v === "string" ? (map.get(v) ?? v) : v);
function rewrite<T>(value: T, s: ImportScope, scopes: Map<string, ImportScope>, field = ""): T {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, s, scopes, field)) as T;
  if (!value || typeof value !== "object") {
    const map = ["documentId", "documentIds", "headDocumentId", "variantOf"].includes(field)
      ? s.docs
      : ["chunkId", "chunkIds", "onlyChunks"].includes(field)
        ? s.chunks
        : ["runId", "sourceRunId"].includes(field)
          ? s.runs
          : [
                "revisionId",
                "baseRevisionId",
                "resultRevisionId",
                "baseGraphRevisionId",
                "draftRevisionId",
                "requestedOntologyRevisionId",
              ].includes(field)
            ? s.revisions
            : ["memberId"].includes(field)
              ? s.members
              : field === "key"
                ? s.steps
                : null;
    if (map) return mapped(map, value) as T;
    if (field === "projectId" && typeof value === "string") return (scopes.get(value)?.project.id ?? value) as T;
    return value;
  }
  const obj = value as Record<string, unknown>;
  if (field === "documentChecksums") return Object.fromEntries(Object.entries(obj).map(([id, v]) => [s.docs.get(id) ?? id, v])) as T;
  if (typeof obj.projectId === "string" && typeof obj.revisionId === "string" && typeof obj.hash === "string") {
    const parent = scopes.get(obj.projectId);
    if (!parent || !parent.revisions.has(obj.revisionId)) throw new HttpError(400, "The archive is missing a pinned ontology revision.");
    return { ...obj, projectId: parent.project.id, revisionId: parent.revisions.get(obj.revisionId) } as T;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, rewrite(v, s, scopes, k)])) as T;
}
function remapContent(content: RevisionContent, s: ImportScope, scopes: Map<string, ImportScope>): RevisionContent {
  return rewrite(content, s, scopes);
}
function archiveShape(a: ProjectArchive) {
  if (
    !a ||
    a.format !== ARCHIVE_FORMAT ||
    !a.project ||
    !Array.isArray(a.documents) ||
    !Array.isArray(a.revisions) ||
    a.documents.length > 10000 ||
    a.revisions.length > 10000
  )
    throw new HttpError(400, "The archive contains an invalid workspace.");
}
export async function importBundle(ctx: ServiceCtx, data: ProjectArchive): Promise<Project> {
  archiveShape(data);
  if (data.project.settings?.corpus) throw new HttpError(400, "Import a corpus together with its ontology package.");
  if ((data.corpora?.length ?? 0) > 1000) throw new HttpError(400, "Archive contains too many corpora.");
  for (const child of data.corpora ?? []) {
    archiveShape(child);
    if (child.corpora?.length) throw new HttpError(400, "Nested corpora are not supported.");
    if (!child.project.settings?.corpus) throw new HttpError(400, "Corpus identity is missing.");
  }
  const all = [data, ...(data.corpora ?? [])],
    scopes = new Map<string, ImportScope>(),
    created: string[] = [];
  const incomingBytes = all.reduce(
    (total, a) =>
      total +
      Buffer.byteLength(JSON.stringify(a.revisions)) +
      a.documents.reduce((n, d) => n + Buffer.byteLength(d.base64, "base64") * 2 + Buffer.byteLength(JSON.stringify(d.frozen ?? null)), 0),
    0,
  );
  if ((await ctx.store.usage()).usedBytes + incomingBytes > STORAGE_QUOTA_BYTES)
    throw new HttpError(507, "The archive exceeds the available storage quota.");
  try {
    for (const a of all) {
      const settings = { ...a.project.settings };
      delete settings.corpus;
      delete settings.externalGraph;
      delete settings.publications;
      if (settings.graphdb) settings.graphdb = { repository: settings.graphdb.repository };
      const project = await createProject(ctx, { ...a.project, settings });
      created.push(project.id);
      const oldId = a.sourceProjectId ?? (a === data ? "archive-root" : `archive-corpus-${created.length}`);
      if (scopes.has(oldId)) throw new HttpError(400, "Archive repeats a workspace identifier.");
      const docs = new Map(a.documents.map((d) => [d.id, newId("doc")])),
        revisions = new Map(a.revisions.map((r) => [r.id, newId("rev")])),
        runs = new Map((a.runs ?? []).map((r) => [r.run.id, newId("run")])),
        members = new Map((a.project.settings.corpus?.members ?? []).map((m) => [m.id, newId("src")])),
        chunks = new Map<string, string>();
      for (const d of a.documents) for (const c of d.frozen?.chunks ?? []) chunks.set(c.id, `${docs.get(d.id)}_c${c.ordinal}`);
      const steps = new Map<string, string>();
      for (const { run } of a.runs ?? [])
        for (const step of run.steps) {
          let key = step.key;
          if (step.documentId && docs.has(step.documentId)) key = key.replace(step.documentId, docs.get(step.documentId)!);
          steps.set(step.key, key);
        }
      scopes.set(oldId, { archive: a, project, oldId, docs, chunks, revisions, runs, members, steps });
    }
    const root = [...scopes.values()][0];
    for (const s of scopes.values()) {
      const a = s.archive,
        pid = s.project.id;
      for (const d of a.documents) {
        const bytes = Buffer.from(d.base64, "base64");
        if (d.frozen) {
          const id = s.docs.get(d.id)!,
            storagePath = `${pid}/documents/${id}`;
          await ctx.store.blobs.put(storagePath, bytes, d.mediaType);
          const metadata = d.metadata;
          if (!metadata) throw new HttpError(400, "Frozen document metadata is missing.");
          const document = { ...rewrite(metadata, s, scopes), id, projectId: pid, ownerId: ctx.user.id, storagePath, processing: null };
          await ctx.store.documents.create(document);
          const { chunks, ...text } = d.frozen;
          await ctx.store.documents.putText(
            pid,
            id,
            text,
            chunks.map((c) => ({ ...rewrite(c, s, scopes), id: s.chunks.get(c.id)!, projectId: pid, documentId: id })),
          );
        } else {
          const uploaded = await uploadDocument(ctx, pid, d.name, bytes, {
            allowDuplicate: true,
            chunking: a.project.settings.corpus?.chunking,
          });
          s.docs.set(d.id, uploaded.id);
          for (const c of await ctx.store.documents.chunks(pid, [uploaded.id])) s.chunks.set(`${d.id}_c${c.ordinal}`, c.id);
        }
      }
      for (const r of a.revisions) {
        const id = s.revisions.get(r.id)!,
          content = remapContent(r.content, s, scopes),
          now = iso(ctx.now());
        await ctx.store.revisions.create(
          {
            id,
            projectId: pid,
            parentId: r.parentId ? (s.revisions.get(r.parentId) ?? null) : null,
            number: r.number,
            status: r.status,
            source: r.source,
            summary: r.summary,
            createdBy: ctx.user.id,
            createdAt: r.createdAt ?? now,
            updatedAt: now,
            ...(r.committedAt ? { committedAt: r.committedAt } : {}),
            contentHash: contentHash(content),
            stats: contentStats(content),
          },
          content,
        );
      }
      const current = a.currentRevisionId ? (s.revisions.get(a.currentRevisionId) ?? null) : null;
      await ctx.store.projects.update(pid, { currentRevisionId: current });
      if (a.project.settings.corpus) {
        const c = a.project.settings.corpus;
        const metadata: CorpusMetadata = {
          ...rewrite(c, s, scopes),
          parentProjectId: root.project.id,
          parentName: root.project.name,
          version: 1,
          updateLease: undefined,
          requestedOntologyRevisionId: root.revisions.get(c.requestedOntologyRevisionId) ?? "",
          members: c.members.map((m) => ({
            ...m,
            id: s.members.get(m.id)!,
            headDocumentId: s.docs.get(m.headDocumentId)!,
            versions: m.versions.map((v) => ({ ...v, documentId: s.docs.get(v.documentId)! })),
          })),
        };
        if (
          !metadata.requestedOntologyRevisionId ||
          metadata.members.some((m) => !m.headDocumentId || m.versions.some((v) => !v.documentId))
        )
          throw new HttpError(400, "The corpus archive is missing an ontology or source version.");
        const p = await requireProject(ctx, pid);
        await ctx.store.projects.update(pid, { settings: { ...p.settings, reviewPolicy: "accepted-only", corpus: metadata } });
      }
      for (const entry of a.runs ?? []) {
        const old = entry.run,
          run = rewrite(old, s, scopes);
        run.id = s.runs.get(old.id)!;
        run.projectId = pid;
        run.ownerId = ctx.user.id;
        run.lease = null;
        run.documentChecksums = Object.fromEntries(Object.entries(old.documentChecksums).map(([id, v]) => [s.docs.get(id) ?? id, v]));
        if (["queued", "running", "awaiting_answers"].includes(run.status)) {
          run.status = "cancelled";
          run.notes = [...run.notes, "Imported without starting inference. Resume explicitly to continue unfinished work."];
        }
        if (run.corpus) run.corpus.corpusId = pid;
        await ctx.store.runs.create(run);
        for (const cp of entry.checkpoints) await ctx.store.runs.putCheckpoint(pid, { ...rewrite(cp, s, scopes), runId: run.id });
        if (entry.inputs) {
          const input = rewrite(entry.inputs, s, scopes) as Record<string, unknown>,
            original = entry.inputs as Record<string, unknown>;
          if (Array.isArray(original.documents))
            input.documents = original.documents.map((d) => {
              const doc = d as { id: string };
              return { ...rewrite(doc, s, scopes), id: s.docs.get(doc.id) ?? doc.id };
            });
          if (Array.isArray(original.chunks))
            input.chunks = (original.chunks as DocumentChunk[]).map((c) => ({ ...rewrite(c, s, scopes), id: s.chunks.get(c.id) ?? c.id }));
          if (original.documentTexts && typeof original.documentTexts === "object")
            input.documentTexts = Object.fromEntries(
              Object.entries(original.documentTexts).map(([id, v]) => [s.docs.get(id) ?? id, rewrite(v, s, scopes)]),
            );
          if (input.baseRevision && typeof input.baseRevision === "object") {
            const base = input.baseRevision as { id: string; content: RevisionContent; contentHash: string };
            base.id = s.revisions.get(base.id) ?? base.id;
            base.contentHash = contentHash(base.content);
          }
          await ctx.store.blobs.put(`${pid}/research/${run.id}/inputs.json`, Buffer.from(JSON.stringify(input)), "application/json");
        }
      }
      for (const report of a.reports ?? []) {
        const mapped = rewrite(report, s, scopes),
          revision = await ctx.store.revisions.get(pid, mapped.revisionId);
        if (revision) await ctx.store.reports.put({ ...mapped, id: newId("rpt"), projectId: pid, contentHash: revision.contentHash });
      }
      for (const c of a.conversations ?? [])
        await ctx.store.conversations.put({
          id: newId("cnv"),
          projectId: pid,
          revisionId: current,
          title: c.title,
          messages: rewrite(c.messages, s, scopes),
          createdAt: c.createdAt,
          updatedAt: iso(ctx.now()),
        });
    }
    return (await ctx.store.projects.get(root.project.id))!;
  } catch (e) {
    for (const id of created.reverse()) await ctx.store.projects.delete(id).catch(() => {});
    throw e;
  }
}
