import { requirementsHistory, requirementsIdentity } from "../../src/lib/requirementsVersions.ts";
// Projects: create, list (with dashboard counters), update, delete, sample.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Project, ProjectSummary, ProjectSettings } from "../../src/types/project.ts";
import { CHUNK_CHARS, CHUNK_OVERLAP } from "../config.ts";
import { HttpError } from "../http.ts";
import { ConflictError, NotFoundError } from "../store/types.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { createRevision, commitRevision } from "./revisions.ts";
import { uploadDocument } from "./documents.ts";

const ACTIVE = new Set(["queued", "running", "awaiting_answers"]);

export interface ProjectInput {
  name?: string;
  purpose?: string;
  scope?: string;
  competencyQuestions?: string[];
  settings?: ProjectSettings;
  archived?: boolean;
}

function clean(input: ProjectInput): ProjectInput {
  const out: ProjectInput = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new HttpError(400, "Project name is required.");
    if (name.length > 200) throw new HttpError(400, "Project name is too long (200 characters max).");
    out.name = name;
  }
  if (input.purpose !== undefined) out.purpose = String(input.purpose).slice(0, 10_000);
  if (input.scope !== undefined) out.scope = String(input.scope).slice(0, 10_000);
  if (input.competencyQuestions !== undefined) {
    if (!Array.isArray(input.competencyQuestions)) throw new HttpError(400, "competencyQuestions must be an array");
    out.competencyQuestions = input.competencyQuestions
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  if (input.settings !== undefined) {
    const s = input.settings ?? {};
    out.settings = {
      ...(typeof s.baseIri === "string" ? { baseIri: s.baseIri.slice(0, 500) } : {}),
      ...(typeof s.provider === "string" ? { provider: s.provider.slice(0, 40) } : {}),
      ...(typeof s.model === "string" ? { model: s.model.slice(0, 120) } : {}),
      ...(Array.isArray(s.savedQueries)
        ? {
            savedQueries: s.savedQueries
              .filter((q) => q && typeof q.question === "string" && typeof q.sparql === "string")
              .slice(0, 100)
              .map((q) => ({ question: q.question.slice(0, 2000), sparql: q.sparql.slice(0, 20_000) })),
          }
        : {}),
      ...(s.graphdb && typeof s.graphdb === "object"
        ? {
            graphdb: {
              ...(typeof s.graphdb.repository === "string" && /^[A-Za-z0-9_.-]{0,100}$/.test(s.graphdb.repository)
                ? { repository: s.graphdb.repository }
                : {}),
              ...(typeof s.graphdb.graph === "string" ? { graph: s.graphdb.graph.trim().slice(0, 500) } : {}),
              // written by the publish endpoint; a settings save carries it through
              ...(s.graphdb.published && typeof s.graphdb.published === "object" ? { published: s.graphdb.published } : {}),
            },
          }
        : {}),
      // Requirements are edited through their own endpoint (which validates
      // them); a settings save just carries them through unchanged.
      ...(s.requirements && typeof s.requirements === "object" && Array.isArray(s.requirements.cqs) && Array.isArray(s.requirements.stories)
        ? { requirements: s.requirements }
        : {}),
      ...(s.budget && typeof s.budget === "object"
        ? {
            budget: {
              ...(typeof s.budget.maxUsdPerRun === "number" && s.budget.maxUsdPerRun >= 0 ? { maxUsdPerRun: s.budget.maxUsdPerRun } : {}),
              ...(typeof s.budget.maxUsdTotal === "number" && s.budget.maxUsdTotal >= 0 ? { maxUsdTotal: s.budget.maxUsdTotal } : {}),
            },
          }
        : {}),
      ...(s.models && typeof s.models === "object"
        ? {
            models: {
              ...(["local", "provider", "hash", "off"].includes(String(s.models.embeddings)) ? { embeddings: s.models.embeddings } : {}),
              ...(["local", "provider", "lexical", "off"].includes(String(s.models.nli)) ? { nli: s.models.nli } : {}),
            },
          }
        : {}),
      ...(Array.isArray(s.grounding) ? { grounding: s.grounding.filter((g) => ["wikidata", "geonames", "umls"].includes(g)) } : {}),
      ...(s.reviewPolicy === "all" || s.reviewPolicy === "exclude-rejected" || s.reviewPolicy === "accepted-only"
        ? { reviewPolicy: s.reviewPolicy }
        : {}),
    };
  }
  if (input.archived !== undefined) out.archived = !!input.archived;
  return out;
}

export async function requireProject(ctx: ServiceCtx, id: string): Promise<Project> {
  const p = await ctx.store.projects.get(id).catch((e) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!p) throw new HttpError(404, "Project not found.");
  return p;
}

export async function createProject(ctx: ServiceCtx, input: ProjectInput, identity?: string): Promise<Project> {
  const c = clean({ name: input.name ?? "", ...input });
  const now = iso(ctx.now());
  const project: Project = {
    id: identity ?? newId("prj"),
    ownerId: ctx.user.id,
    name: c.name!,
    purpose: c.purpose ?? "",
    scope: c.scope ?? "",
    competencyQuestions: c.competencyQuestions ?? [],
    settings: c.settings ?? {},
    currentRevisionId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const created = await ctx.store.projects.create(project);
  ctx.log.info("project.created", { requestId: ctx.requestId, projectId: created.id });
  return created;
}

export async function listProjects(ctx: ServiceCtx): Promise<ProjectSummary[]> {
  const projects = await ctx.store.projects.list();
  const out: ProjectSummary[] = [];
  for (const p of projects.filter((p) => !p.settings.corpus && !p.settings.externalGraph)) {
    const [docs, revs, runs] = await Promise.all([
      ctx.store.documents.list(p.id),
      ctx.store.revisions.list(p.id),
      ctx.store.runs.list(p.id),
    ]);
    const current = revs.find((r) => r.id === p.currentRevisionId);
    const active = runs.find((r) => ACTIVE.has(r.status));
    out.push({
      ...p,
      documentCount: docs.length,
      revisionNumber: current?.number ?? null,
      activeRun: active ? { id: active.id, status: active.status } : null,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateProject(ctx: ServiceCtx, id: string, input: ProjectInput): Promise<Project> {
  const existing = await requireProject(ctx, id);
  const patch = clean(input);
  if (existing.settings.corpus && patch.settings?.reviewPolicy && patch.settings.reviewPolicy !== "accepted-only")
    throw new HttpError(400, "Corpus graphs publish accepted facts only. Review candidate claims before using them in answers or exports.");
  // A query saved on the Validate page belongs to its competency question too.
  const s = patch.settings;
  if (s && existing.settings.requirements) s.requirements = existing.settings.requirements;
  if (s?.requirements && s.savedQueries?.length) {
    const sparql = new Map(s.savedQueries.map((q) => [q.question, q.sparql]));
    s.requirements = {
      ...s.requirements,
      cqs: s.requirements.cqs.map((q) => (sparql.has(q.text) ? { ...q, sparql: sparql.get(q.text) } : q)),
    };
  }
  if (s) {
    if (existing.settings.externalGraph) s.externalGraph = existing.settings.externalGraph;
    if (existing.settings.publications) s.publications = existing.settings.publications;
    const history = requirementsHistory(existing);
    const latest = history.at(-1);
    const req = s.requirements ?? existing.settings.requirements;
    // Generic settings saves cannot replace requirements history supplied by the server.
    s.requirementsVersions =
      req && (!latest || requirementsIdentity(req) !== requirementsIdentity(latest.requirements))
        ? [...history, { number: (latest?.number ?? 0) + 1, createdAt: iso(ctx.now()), requirements: req }]
        : history;
    if (!s.requirements && existing.settings.requirements) s.requirements = existing.settings.requirements;
  }
  if (patch.settings) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await requireProject(ctx, id);
      try {
        const saved = await ctx.store.projects.compareAndSwapSettings(
          id,
          cur.settings,
          {
            ...patch.settings,
            ...(cur.settings.corpus ? { corpus: { ...cur.settings.corpus, version: cur.settings.corpus.version + 1 } } : {}),
            ...(cur.settings.externalGraph ? { externalGraph: cur.settings.externalGraph } : {}),
            ...(cur.settings.publications ? { publications: cur.settings.publications } : {}),
          },
          iso(ctx.now()),
        );
        const { settings: _settings, ...rest } = patch;
        void _settings;
        return Object.keys(rest).length ? ctx.store.projects.update(id, rest) : saved;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    throw new HttpError(409, "Project settings changed. Refresh before saving.");
  }
  return ctx.store.projects.update(id, { ...patch, updatedAt: iso(ctx.now()) });
}

export async function deleteProject(ctx: ServiceCtx, id: string): Promise<void> {
  await requireProject(ctx, id);
  for (const p of await ctx.store.projects.list())
    if (p.settings.corpus?.parentProjectId === id || p.settings.externalGraph?.parentProjectId === id)
      await ctx.store.projects.delete(p.id);
  await ctx.store.projects.delete(id);
  ctx.log.info("project.deleted", { requestId: ctx.requestId, projectId: id });
}

/** Touch updatedAt so the dashboard orders by recent activity. */
export async function touchProject(ctx: ServiceCtx, id: string): Promise<void> {
  await ctx.store.projects.update(id, { updatedAt: iso(ctx.now()) });
}

/* ───────────────────────── bundled sample ───────────────────────── */

const SAMPLES_DIR = process.env.SAMPLES_DIR || resolve(process.cwd(), "samples");

/**
 * The bundled sample (the technical-manuals template with a synthetic manual): the
 * mechatronic T-Box committed as revision 1 and the
 * distributing-station manual uploaded and parsed, ready for a run.
 */
export async function createSampleProject(ctx: ServiceCtx): Promise<Project> {
  let tbox: string;
  let manual: Buffer;
  try {
    tbox = await readFile(join(SAMPLES_DIR, "mechatronic-tbox.ttl"), "utf8");
    manual = await readFile(join(SAMPLES_DIR, "distributing-manual.txt"));
  } catch {
    throw new HttpError(500, "The sample files are not available on this server.");
  }
  const project = await createProject(ctx, {
    name: "Sample — Technical manual (distributing station)",
    purpose:
      "Describe the components, sensors, actuators and operations of a modular production station so engineers can query its structure.",
    scope:
      "The distributing station of a mechatronic training plant: its stack magazine, swivel module, sensors, actuators and operation sequence.",
    competencyQuestions: [
      "Which sensors does the distributing station have?",
      "Which actuators are part of the stack magazine?",
      "What operations does the station perform?",
    ],
  });
  const draft = await createRevision(ctx, project.id, {
    content: { modules: [{ id: newId("mod"), name: "mechatronic-tbox.ttl", turtle: tbox }], abox: null, baseIri: "" },
    source: "import",
    summary: "Imported the mechatronic T-Box",
  });
  await commitRevision(ctx, project.id, draft.id);
  await uploadDocument(ctx, project.id, "distributing-manual.txt", manual, {
    chunking: { method: "section", maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP },
  });
  return (await ctx.store.projects.get(project.id))!;
}
