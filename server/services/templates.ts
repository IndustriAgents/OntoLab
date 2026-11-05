// Template library (A5): starter T-Box modules with user stories and 5–10
// competency questions each (samples/templates/<id>/). Starting from a template
// creates a project whose requirements are filled in and whose ontology is
// committed as revision 1 — ready for documents. The mechatronic sample is the
// "technical-manuals" template.

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Project, OntologyRevision } from "../../src/types/project.ts";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import { HttpError } from "../http.ts";
import { newId, type ServiceCtx } from "./context.ts";
import { createProject, requireProject, updateProject } from "./projects.ts";
import { commitRevision, createRevision, requireRevision } from "./revisions.ts";
import { saveRequirements } from "./requirements.ts";

const SAMPLES_DIR = process.env.SAMPLES_DIR || resolve(process.cwd(), "samples");
const TEMPLATES_DIR = join(SAMPLES_DIR, "templates");

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  purpose: string;
  scope: string;
  stories: string[];
  cqs: string[];
  classes: number;
  properties: number;
}

interface TemplateFile extends Omit<TemplateInfo, "classes" | "properties"> {
  tboxFile: string;
}

const ID_RE = /^[a-z0-9-]{1,60}$/;

async function readTemplate(id: string): Promise<{ meta: TemplateFile; turtle: string }> {
  if (!ID_RE.test(id)) throw new HttpError(404, "Template not found.");
  const dir = join(TEMPLATES_DIR, id);
  let meta: TemplateFile;
  try {
    meta = JSON.parse(await readFile(join(dir, "template.json"), "utf8")) as TemplateFile;
  } catch {
    throw new HttpError(404, "Template not found.");
  }
  // tboxFile may point at a shared sample ("../../mechatronic-tbox.ttl") but never outside samples/.
  const tboxPath = resolve(dir, meta.tboxFile || "tbox.ttl");
  if (!tboxPath.startsWith(resolve(SAMPLES_DIR))) throw new HttpError(500, "Template points outside the sample library.");
  const turtle = await readFile(tboxPath, "utf8");
  return { meta: { ...meta, id }, turtle };
}

let cache: TemplateInfo[] | null = null;

export async function listTemplates(): Promise<TemplateInfo[]> {
  if (cache) return cache;
  let ids: string[] = [];
  try {
    ids = (await readdir(TEMPLATES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out: TemplateInfo[] = [];
  for (const id of ids.sort()) {
    try {
      const { meta, turtle } = await readTemplate(id);
      const model = parseTBox(turtle);
      out.push({
        id,
        name: meta.name,
        description: meta.description,
        purpose: meta.purpose,
        scope: meta.scope,
        stories: meta.stories ?? [],
        cqs: meta.cqs ?? [],
        classes: model.classes.length,
        properties: model.objectProps.length + model.dataProps.length,
      });
    } catch (e) {
      console.warn(`[templates] skipping ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  cache = out;
  return out;
}

export async function createFromTemplate(ctx: ServiceCtx, templateId: string, name?: string): Promise<Project> {
  const { meta, turtle } = await readTemplate(templateId);
  const project = await createProject(ctx, {
    name: name?.trim() || meta.name,
    purpose: meta.purpose,
    scope: meta.scope,
  });
  await saveRequirements(ctx, project.id, {
    stories: meta.stories ?? [],
    cqs: (meta.cqs ?? []).map((text) => ({ text, status: "approved", source: "template" })),
  });
  const fileName = `${templateId}.ttl`;
  const draft = await createRevision(ctx, project.id, {
    content: { modules: [{ id: newId("mod"), name: fileName, turtle }], abox: null, baseIri: "" },
    source: "template",
    summary: `Started from the ${meta.name} template`,
  });
  await commitRevision(ctx, project.id, draft.id);
  return (await ctx.store.projects.get(project.id))!;
}

/** An existing workspace receives a draft to review; its saved version stays current. */
export async function applyTemplate(ctx: ServiceCtx, projectId: string, templateId: string): Promise<OntologyRevision> {
  const project = await requireProject(ctx, projectId);
  if (project.settings.corpus) throw new HttpError(409, "Choose an ontology starting point in the parent project.");
  const { meta, turtle } = await readTemplate(templateId);
  const current = project.currentRevisionId ? await requireRevision(ctx, projectId, project.currentRevisionId) : null;
  const draft = await createRevision(ctx, projectId, {
    content: { modules: [{ id: newId("mod"), name: `${templateId}.ttl`, turtle }], abox: current?.content.abox ?? null, baseIri: "" },
    source: "template",
    summary: `Started from the ${meta.name} template`,
  });
  if (!project.purpose.trim()) await updateProject(ctx, projectId, { purpose: meta.purpose });
  if (!project.settings.requirements?.stories.length && !project.settings.requirements?.cqs.length && !project.competencyQuestions.length) {
    await saveRequirements(ctx, projectId, {
      stories: meta.stories ?? [],
      cqs: (meta.cqs ?? []).map((text) => ({ text, status: "approved", source: "template" })),
    });
  }
  return draft;
}
