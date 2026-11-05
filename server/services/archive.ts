import { exportBundle, importBundle } from "./archiveV2.ts";
// Exports and the portable project archive.
//
// Turtle exports come from an explicitly chosen revision (the current committed
// one by default, a draft only when the caller names it). An export whose
// revision has schema errors needs an explicit acknowledgment.
//
// The archive is a versioned, gzipped JSON document holding the project's
// metadata, document originals, every revision and the conversations — the
// pilot's backup mechanism. Importing always creates a NEW project with new ids.

import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_EXPANDED_BYTES } from "../config.ts";

import { ARCHIVE_FORMAT, ARCHIVE_VERSION, type Project, type ProjectArchive, type RevisionContent } from "../../src/types/project.ts";
import { serializeABox } from "../../src/lib/ontology/aboxSerializer.ts";
import { HttpError } from "../http.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { createProject, requireProject } from "./projects.ts";
import { requireRevision } from "./revisions.ts";
import { schemaIssues, latestReport } from "./validation.ts";
import { contentHash, contentStats, graphAbox, mergedModulesTurtle, reviewPolicyOf, tboxOf } from "./ontology.ts";
import { uploadDocument } from "./documents.ts";
import { validateChunkSettings } from "./research.ts";

const decompress = promisify(gunzip);

export type ExportScope = "abox" | "tbox" | "combined";

export async function exportTurtle(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  scope: ExportScope,
  acknowledged: boolean,
  opts: { provenance?: "none" | "source" | "reified" } = {},
): Promise<{ turtle: string; filename: string; errors: number }> {
  const project = await requireProject(ctx, projectId);
  const rev = await requireRevision(ctx, projectId, revisionId);
  const errors = (await schemaIssues(ctx, projectId, revisionId)).filter((i) => i.severity === "error").length;
  if (errors && scope !== "tbox" && !acknowledged) {
    throw new HttpError(
      409,
      `This revision has ${errors} validation error${errors === 1 ? "" : "s"}. Review them, or confirm that you want to export anyway.`,
    );
  }
  const base =
    project.name
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "ontolab";
  const tag = rev.number != null ? `r${rev.number}` : "draft";
  const tboxTurtle = mergedModulesTurtle(rev.content);
  if (scope === "tbox") return { turtle: tboxTurtle, filename: `${base}-${tag}-tbox.ttl`, errors };
  const tbox = tboxOf(rev.content);
  // rejected facts are never exported; with "accepted-only", candidates are not either
  const abox = serializeABox(graphAbox(rev.content, reviewPolicyOf(project)), tbox, rev.content.baseIri || tbox.baseIri, {
    provenance: opts.provenance ?? "source",
  }).turtle;
  if (scope === "abox") return { turtle: abox, filename: `${base}-${tag}-abox.ttl`, errors };
  return { turtle: `${tboxTurtle}\n\n# ── A-Box ──\n${abox}`, filename: `${base}-${tag}.ttl`, errors };
}

export async function exportReport(ctx: ServiceCtx, projectId: string, revisionId: string, format: "json" | "md") {
  const report = await latestReport(ctx, projectId, revisionId);
  if (!report) throw new HttpError(404, "This revision has not been validated yet.");
  if (format === "json")
    return { body: JSON.stringify(report, null, 2), contentType: "application/json", filename: `validation-${revisionId}.json` };
  const rev = await requireRevision(ctx, projectId, revisionId);
  const lines = [
    `# Validation report — ${rev.number ? `revision ${rev.number}` : "draft"}`,
    "",
    `Generated ${report.createdAt}${report.stale ? " — **stale: the revision changed after this report**" : ""}`,
    "",
    `- Errors: ${report.counts.errors}`,
    `- Warnings: ${report.counts.warnings}`,
    "",
    "## Schema findings",
    ...(report.schemaIssues.length ? report.schemaIssues.map((i) => `- **${i.severity}** ${i.where}: ${i.message}`) : ["None."]),
    "",
    "## SHACL findings",
    ...(report.shaclIssues.length ? report.shaclIssues.map((i) => `- **${i.severity}** ${i.where}: ${i.message}`) : ["None."]),
    "",
    "## Reasoning",
    ...(report.reasoner
      ? [
          `${report.reasoner.consistent ? "Consistent" : "**Inconsistent**"} · ${report.reasoner.unsatisfiable} unsatisfiable class(es) · ${report.reasoner.inferredTypes} individual(s) with inferred types (${report.reasoner.reasoner}, ${report.reasoner.tier.toUpperCase()})`,
          ...report.reasoner.incomplete.map((m) => `> Not checked: ${m}`),
          "",
        ]
      : []),
    ...((report.reasonerIssues ?? []).length
      ? (report.reasonerIssues ?? []).flatMap((i) => [
          `- **${i.severity}** ${i.where}: ${i.message}`,
          ...(i.explanation ?? []).map((e) => `  - ${e}`),
        ])
      : [report.reasoner ? "No clashes or unsatisfiable classes." : "Not run."]),
    "",
    "## Competency questions",
    ...(report.cqResults.length
      ? report.cqResults.flatMap((c) => [
          `### ${c.question}`,
          "```sparql",
          c.sparql,
          "```",
          c.error ? `Error: ${c.error}` : `${c.rows.length} row(s)${c.truncated ? " (truncated)" : ""}`,
          "",
        ])
      : ["None run."]),
  ];
  return { body: lines.join("\n"), contentType: "text/markdown; charset=utf-8", filename: `validation-${revisionId}.md` };
}

/* ───────────────────────── archive ───────────────────────── */

export async function exportArchive(ctx: ServiceCtx, projectId: string): Promise<{ bytes: Buffer; filename: string }> {
  return exportBundle(ctx, projectId);
}

async function parseArchive(bytes: Buffer): Promise<ProjectArchive> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new HttpError(413, "The archive exceeds the upload size limit.");
  let text: string;
  try {
    const expanded =
      bytes[0] === 0x1f && bytes[1] === 0x8b ? await decompress(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES }) : bytes;
    if (expanded.length > MAX_ARCHIVE_EXPANDED_BYTES) throw new HttpError(413, "The expanded archive exceeds the size limit.");
    text = expanded.toString("utf8");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new HttpError(413, "The expanded archive exceeds the size limit.");
    throw new HttpError(400, "The archive could not be decompressed.");
  }
  let data: ProjectArchive;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The archive is not valid JSON.");
  }
  if (data?.format !== ARCHIVE_FORMAT) throw new HttpError(400, "This file is not an OntoLab project archive.");
  if (typeof data.version !== "number" || data.version > ARCHIVE_VERSION) {
    throw new HttpError(400, `Archive version ${data.version} is newer than this server supports (${ARCHIVE_VERSION}).`);
  }
  if (!data.project || !Array.isArray(data.documents) || !Array.isArray(data.revisions))
    throw new HttpError(400, "The archive is incomplete.");
  return data;
}

/**
 * Re-create an archived project under the current user. Committed revisions
 * are replayed in order (so numbering and history survive), drafts come back as
 * drafts, documents are re-uploaded and re-parsed.
 */
export async function importArchive(ctx: ServiceCtx, bytes: Buffer): Promise<Project> {
  const data = await parseArchive(bytes);
  if (data.version >= 2) return importBundle(ctx, data);
  const project = await createProject(ctx, {
    name: `${String(data.project.name || "Imported project").slice(0, 180)}`,
    purpose: data.project.purpose,
    scope: data.project.scope,
    competencyQuestions: data.project.competencyQuestions,
    settings: data.project.settings,
  });
  try {
    const documentIds = new Map<string, string>();
    // Originals must be uploaded before variants with identical file bytes.
    for (const d of [...data.documents].sort((a, b) => Number(!!a.variantOf) - Number(!!b.variantOf))) {
      const chunking = d.preprocessing?.settings ? validateChunkSettings(d.preprocessing.settings) : undefined;
      const uploaded = await uploadDocument(ctx, project.id, d.name, Buffer.from(d.base64, "base64"), {
        chunking,
        allowDuplicate: !!d.variantOf,
      });
      documentIds.set(d.id, uploaded.id);
    }
    for (const d of data.documents) {
      const originalId = d.variantOf ? documentIds.get(d.variantOf) : undefined;
      if (originalId) {
        const uploaded = await ctx.store.documents.get(project.id, documentIds.get(d.id)!);
        if (uploaded) await ctx.store.documents.update(project.id, uploaded.id, { ...uploaded, variantOf: originalId });
      }
    }
    const idMap = new Map<string, string>();
    const committed = data.revisions.filter((r) => r.status === "committed").sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const drafts = data.revisions.filter((r) => r.status === "draft");
    let current: string | null = null;
    for (const r of committed) {
      const id = newId("rev");
      idMap.set(r.id, id);
      const content: RevisionContent = { modules: r.content.modules ?? [], abox: r.content.abox ?? null, baseIri: r.content.baseIri ?? "" };
      const now = iso(ctx.now());
      await ctx.store.revisions.create(
        {
          id,
          projectId: project.id,
          parentId: current,
          number: null,
          status: "draft",
          source: r.source,
          summary: r.summary,
          contentHash: contentHash(content),
          stats: contentStats(content),
          createdBy: ctx.user.id,
          createdAt: r.createdAt ?? now,
          updatedAt: now,
        },
        content,
      );
      await ctx.store.revisions.commit(project.id, id, current, r.committedAt ?? now);
      current = id;
    }
    for (const r of drafts) {
      const content: RevisionContent = { modules: r.content.modules ?? [], abox: r.content.abox ?? null, baseIri: r.content.baseIri ?? "" };
      const now = iso(ctx.now());
      await ctx.store.revisions.create(
        {
          id: newId("rev"),
          projectId: project.id,
          parentId: current,
          number: null,
          status: "draft",
          source: r.source,
          summary: r.summary,
          contentHash: contentHash(content),
          stats: contentStats(content),
          createdBy: ctx.user.id,
          createdAt: r.createdAt ?? now,
          updatedAt: now,
        },
        content,
      );
    }
    for (const c of data.conversations ?? []) {
      const now = iso(ctx.now());
      await ctx.store.conversations.put({
        id: newId("cnv"),
        projectId: project.id,
        revisionId: current,
        title: c.title ?? "Conversation",
        // proposals point at draft ids that no longer exist in the new project
        messages: (c.messages ?? []).map((m) =>
          m.proposal
            ? {
                ...m,
                proposal: {
                  ...m.proposal,
                  applied: m.proposal.applied ?? false,
                  draftRevisionId: idMap.get(m.proposal.draftRevisionId) ?? "",
                },
              }
            : m,
        ),
        createdAt: c.createdAt ?? now,
        updatedAt: now,
      });
    }
  } catch (e) {
    // A half-imported project is worse than none.
    await ctx.store.projects.delete(project.id).catch(() => {});
    throw e;
  }
  ctx.log.info("archive.imported", { requestId: ctx.requestId, projectId: project.id });
  return (await ctx.store.projects.get(project.id))!;
}
