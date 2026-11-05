import { exportTurtle } from "../services/archive.ts";
import * as alignment from "../services/alignmentRuns.ts";
import { externalQuery } from "../connections/service.ts";
import type { Capability } from "../../src/types/actions.ts";
import type { ABoxResult } from "../../src/types/abox.ts";
import type { RevisionContent } from "../../src/types/project.ts";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import type { ServiceCtx } from "../services/context.ts";
import * as projects from "../services/projects.ts";
import * as documents from "../services/documents.ts";
import * as revisions from "../services/revisions.ts";
import * as runs from "../services/runs.ts";
import * as research from "../services/research.ts";
import * as corpora from "../services/corpora.ts";
import * as validation from "../services/validation.ts";
import * as requirements from "../services/requirements.ts";
import * as review from "../services/review.ts";
import * as submissions from "./submissions.ts";
import { saveVersion } from "./saveVersion.ts";
import { contentHash } from "../services/ontology.ts";
import { listProviders } from "../providers.ts";
import { MAX_UPLOAD_BYTES } from "../config.ts";
import { HttpError } from "../http.ts";
import { digest, readState, writeState, stale } from "./state.ts";

import { define, result, destination, identity, editable, actionDefinitions } from "./engine.ts";
const id = { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" };
const text = { type: "string", minLength: 1, maxLength: 10000 };
const ids = { type: "array", items: id, minItems: 1, maxItems: 2000, uniqueItems: true };
const hash = { type: "string", minLength: 1, maxLength: 128 };
const boolean = { type: "boolean" };
const limit = { type: "integer", minimum: 1, maximum: 100 };
const offset = { type: "integer", minimum: 0, maximum: 1000000 };
const nullableId = { anyOf: [id, { type: "null" }] };
define("workspace_status", "Inspect this workspace and discover available actions. Does not call a model.", "read", {}, [], async (ctx) =>
  result("OntoLab is available", {
    protocolVersion: 1,
    actions: actionDefinitions(ctx.access),
    providers: listProviders().filter((p) => p.enabled),
    localIntegration: true,
  }),
);
define("list_projects", "List accessible ontology projects and knowledge graphs.", "read", {}, [], async (ctx) =>
  result("Projects", {
    projects: (await ctx.store.projects.list())
      .filter((p) => !p.archived)
      .filter(
        (p) =>
          !ctx.access.allowedProjects ||
          ctx.access.allowedProjects.includes(p.id) ||
          ctx.access.allowedProjects.includes(p.settings.corpus?.parentProjectId ?? p.settings.externalGraph?.parentProjectId ?? ""),
      ),
  }),
);
define(
  "create_project",
  "Create an ontology project. Use a stable requestId when retrying.",
  "draft",
  { name: { ...text, maxLength: 200 }, purpose: text, scope: text },
  ["name"],
  async (ctx, input: projects.ProjectInput) => {
    const pid = identity(ctx, "prj");
    const project = (await ctx.store.projects.get(pid)) ?? (await projects.createProject(ctx, input, pid));
    return result("Project created", { project }, pid, `/p/${pid}`, ["set_requirements", "import_document", "submit_ontology_draft"]);
  },
  true,
);
define(
  "get_project_context",
  "Read the selected version, capabilities, prerequisites, documents, graphs and activities. Explicitly pin revisionId when reviewing a draft.",
  "read",
  { projectId: id, revisionId: id },
  ["projectId"],
  async (ctx, input: { projectId: string; revisionId?: string }) => {
    const p = await projects.requireProject(ctx, input.projectId);
    const revs = await revisions.listRevisions(ctx, p.id);
    const selected = input.revisionId
      ? await revisions.requireRevision(ctx, p.id, input.revisionId)
      : await revisions.currentRevision(ctx, p.id);
    const docs = await documents.listDocuments(ctx, p.id);
    const readOnly = !!p.settings.externalGraph;
    const capabilities: Capability[] = [
      {
        action: "submit_ontology_draft",
        available: !readOnly && !p.settings.corpus,
        ...(readOnly || p.settings.corpus
          ? { reason: readOnly ? "Connected graphs are read-only." : "This graph pins an ontology from its parent project." }
          : {}),
      },
      {
        action: "create_knowledge_graph",
        available: !readOnly && !p.settings.corpus && !!p.currentRevisionId,
        ...(!p.currentRevisionId ? { reason: "Save an ontology version first.", nextAction: "save_version" } : {}),
      },
      {
        action: "prepare_fact_submission",
        available: !!p.settings.corpus && docs.some((d) => d.chunkCount),
        ...(!docs.some((d) => d.chunkCount)
          ? { reason: "Import and prepare source documents first.", nextAction: "prepare_documents" }
          : {}),
      },
      { action: "query_graph", available: !!selected || readOnly },
      {
        action: "start_ontology_build",
        available: !readOnly && !p.settings.corpus && docs.some((d) => d.chunkCount) && listProviders().some((v) => v.enabled),
      },
    ];
    return result(
      "Project context",
      {
        project: p,
        selected: selected
          ? {
              id: selected.id,
              contentHash: selected.contentHash,
              status: selected.status,
              stats: selected.stats,
              ontologyPin: selected.content.corpus?.ontology,
            }
          : null,
        revisions: revs,
        documents: docs,
        graphs: !p.settings.corpus && !readOnly ? await corpora.listCorpora(ctx, p.id) : [],
        runs: await runs.listRuns(ctx, p.id),
        activities: (await readState(ctx, `${p.id}/agent/activity.json`)) ?? [],
        capabilities,
        workPackages: p.settings.corpus ? await submissions.listSubmissions(ctx, p.id) : [],
      },
      undefined,
      `/p/${p.id}`,
    );
  },
);
define(
  "set_requirements",
  "Save user stories and competency questions, creating a requirements version. Preserve approved decisions when updating.",
  "draft",
  {
    projectId: id,
    requirements: {
      type: "object",
      properties: {
        stories: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1000 } },
        cqs: {
          type: "array",
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
              text: { type: "string", minLength: 1, maxLength: 1000 },
              status: { enum: ["proposed", "approved", "rejected"] },
              source: { enum: ["user", "generated", "template", "tbox"] },
              story: { type: "integer", minimum: 0, maximum: 11 },
              sparql: { type: "string", maxLength: 20000 },
              sparqlTboxHash: hash,
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["stories", "cqs"],
      additionalProperties: false,
    },
    expectedVersion: { type: "integer", minimum: 0 },
  },
  ["projectId", "requirements", "expectedVersion"],
  async (ctx, input: { projectId: string; requirements: unknown; expectedVersion: number }) => {
    const p = await editable(ctx, input.projectId);
    if ((p.settings.requirementsVersions?.at(-1)?.number ?? 0) !== input.expectedVersion)
      stale("Requirements changed. Read project context before editing them.");
    return result(
      "Requirements saved",
      { project: await requirements.saveRequirements(ctx, p.id, input.requirements, undefined, input.expectedVersion) },
      p.id,
    );
  },
);
define(
  "import_document",
  "Import text or base64 file bytes into a project or knowledge graph. Parsing runs in the background. Local paths are never accepted by this action.",
  "draft",
  {
    projectId: id,
    name: { ...text, maxLength: 200 },
    text: { type: "string", maxLength: MAX_UPLOAD_BYTES },
    base64: { type: "string", maxLength: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) },
  },
  ["projectId", "name"],
  async (ctx, input: { projectId: string; name: string; text?: string; base64?: string }) => {
    const p = await editable(ctx, input.projectId);
    if ((input.text === undefined) === (input.base64 === undefined)) throw new HttpError(400, "Supply either text or base64, exactly one.");
    const bytes = input.text !== undefined ? Buffer.from(input.text) : Buffer.from(input.base64!, "base64");
    const checksum = digestBytes(bytes);
    const existing = (await documents.listDocuments(ctx, p.id)).find((d) => d.checksum === checksum);
    const doc =
      existing ??
      (p.settings.corpus
        ? (await corpora.addCorpusDocument(ctx, p.id, input.name, bytes)).document
        : await documents.uploadDocument(ctx, p.id, input.name, bytes, { deferParsing: true }));
    return result(
      existing ? "Document already imported" : "Document imported; parsing queued",
      { document: doc },
      p.id,
      `/p/${p.id}/${p.settings.corpus ? "graph?tab=documents" : "workflows/tbox?step=documents"}`,
      ["prepare_documents"],
    );
  },
  true,
);
import { createHash } from "node:crypto";
const digestBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
define(
  "prepare_documents",
  "Prepare parsed documents using existing chunk defaults. Returns pending documents without waiting for parsing; retry with a new request after parsing finishes.",
  "draft",
  { projectId: id, documentIds: ids },
  ["projectId", "documentIds"],
  async (ctx, input: { projectId: string; documentIds: string[] }) => {
    const p = await editable(ctx, input.projectId);
    const ready = [],
      pending = [];
    for (const did of input.documentIds) {
      const doc = await documents.requireDocument(ctx, p.id, did);
      if (doc.parseState === "failed") throw new HttpError(422, `${doc.name}: ${doc.parseError}`);
      if (doc.parseState !== "parsed") {
        pending.push(doc);
        continue;
      }
      if (doc.chunkCount) {
        ready.push(doc);
        continue;
      }
      const settings = p.settings.corpus?.chunking ?? { method: "section", maxChars: 12000, overlap: 0.12 };
      const preview = await research.previewChunks(ctx, p.id, did, settings);
      const saved = await research.saveChunkVariant(ctx, p.id, did, settings, preview.textHash);
      if (p.settings.corpus) {
        const member = p.settings.corpus.members.find((m) => m.headDocumentId === did);
        if (member && saved.id !== did) await corpora.setPreparation(ctx, p.id, member.id, saved.id);
      }
      ready.push(saved);
    }
    return result(pending.length ? "Some documents are still parsing" : "Documents prepared", { ready, pending }, p.id);
  },
  true,
);
define(
  "read_document",
  "Read a bounded page of prepared source chunks with immutable document and chunk identifiers.",
  "read",
  { projectId: id, documentId: id, offset, limit },
  ["projectId", "documentId"],
  async (ctx, input: { projectId: string; documentId: string; offset?: number; limit?: number }) => {
    const doc = await documents.requireDocument(ctx, input.projectId, input.documentId);
    const chunks = await ctx.store.documents.chunks(input.projectId, [doc.id]);
    const start = input.offset ?? 0,
      count = input.limit ?? 10;
    return result("Document passages", {
      document: doc,
      chunks: chunks.slice(start, start + count),
      total: chunks.length,
      nextOffset: start + count < chunks.length ? start + count : null,
    });
  },
);
define(
  "search_documents",
  "Search source chunks in this project. Returns bounded passages and source references.",
  "read",
  { projectId: id, query: text, limit },
  ["projectId", "query"],
  async (ctx, input: { projectId: string; query: string; limit?: number }) =>
    result("Source passages", { passages: await ctx.store.documents.search(input.projectId, input.query, input.limit ?? 8) }),
);
define(
  "get_revision",
  "Read ontology modules and a bounded page of individuals. Includes contentHash for concurrency checks.",
  "read",
  { projectId: id, revisionId: id, offset, limit },
  ["projectId", "revisionId"],
  async (ctx, input: { projectId: string; revisionId: string; offset?: number; limit?: number }) => {
    const rev = await revisions.requireRevision(ctx, input.projectId, input.revisionId);
    const start = input.offset ?? 0,
      count = input.limit ?? 50;
    return result("Revision content", {
      ...rev,
      content: {
        ...rev.content,
        abox: rev.content.abox ? { individuals: rev.content.abox.individuals.slice(start, start + count) } : null,
      },
      totalIndividuals: rev.content.abox?.individuals.length ?? 0,
    });
  },
);
define(
  "submit_ontology_draft",
  "Propose ontology modules as a separate draft, preserving graph content and unaffected modules. A base revision and hash are required when editing existing content. Never changes an editor's current draft.",
  "draft",
  {
    projectId: id,
    baseRevisionId: nullableId,
    expectedHash: hash,
    summary: text,
    modules: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        properties: { id, name: { ...text, maxLength: 200 }, turtle: { type: "string", minLength: 1, maxLength: 2000000 } },
        required: ["name", "turtle"],
        additionalProperties: false,
      },
    },
    baseIri: { type: "string", maxLength: 500 },
  },
  ["projectId", "baseRevisionId", "modules", "summary"],
  async (
    ctx,
    input: {
      projectId: string;
      baseRevisionId: string | null;
      expectedHash?: string;
      summary: string;
      modules: { id?: string; name: string; turtle: string }[];
      baseIri?: string;
    },
  ) => {
    const p = await editable(ctx, input.projectId);
    if (p.settings.corpus) throw new HttpError(409, "Edit the ontology in its parent project, then plan a graph ontology upgrade.");
    const rid = identity(ctx, "rev");
    const existing = await ctx.store.revisions.get(p.id, rid);
    if (existing) return result("Ontology draft ready", { revision: existing }, p.id, destination(p.id, rid), ["validate_revision"]);
    const base = input.baseRevisionId ? await revisions.requireRevision(ctx, p.id, input.baseRevisionId) : null;
    if (base && input.expectedHash !== base.contentHash)
      stale("The base draft changed. Read its latest contentHash and review your proposal again.");
    if (!base && p.currentRevisionId)
      stale("Choose the ontology version to improve rather than replacing the current ontology from an empty base.");
    const modules = [...(base?.content.modules ?? [])];
    for (const [index, m] of input.modules.entries()) {
      try {
        parseTBox(m.turtle);
      } catch (error) {
        throw new HttpError(422, `${m.name} cannot be parsed: ${error instanceof Error ? error.message : "Invalid Turtle"}`);
      }
      const at = modules.findIndex((old) => (m.id ? old.id === m.id : old.name === m.name));
      if (m.id && at < 0) throw new HttpError(400, "A supplied module ID does not exist in the base revision.");
      const next = { ...m, id: at >= 0 ? modules[at].id : `mod_${digest([rid, index]).slice(0, 20)}` };
      if (at >= 0) modules[at] = next;
      else modules.push(next);
    }
    const content: RevisionContent = {
      ...(base?.content ?? { abox: null, baseIri: "" }),
      modules,
      baseIri: input.baseIri ?? base?.content.baseIri ?? parseTBox(modules[0].turtle).baseIri,
    };
    const revision = await revisions.createRevision(ctx, p.id, {
      id: rid,
      parentId: base?.status === "draft" ? base.parentId : (base?.id ?? null),
      content,
      source: "ontology",
      summary: input.summary,
    });
    return result("Ontology draft ready to review", { revision }, p.id, destination(p.id, revision.id), [
      "validate_revision",
      "compare_revisions",
    ]);
  },
  true,
);
define(
  "compare_revisions",
  "Compare a proposed draft or saved version against its parent or another revision.",
  "read",
  { projectId: id, revisionId: id, fromId: nullableId },
  ["projectId", "revisionId"],
  async (ctx, input: { projectId: string; revisionId: string; fromId?: string | null }) => {
    const rev = await revisions.requireRevision(ctx, input.projectId, input.revisionId);
    return result("Proposed changes", {
      diff: await revisions.compareRevisions(ctx, input.projectId, input.fromId === undefined ? rev.parentId : input.fromId, rev.id),
    });
  },
);
define(
  "validate_revision",
  "Validate schema, SHACL and saved competency questions using existing project rules.",
  "read",
  { projectId: id, revisionId: id },
  ["projectId", "revisionId"],
  async (ctx, input: { projectId: string; revisionId: string }) => {
    const p = await projects.requireProject(ctx, input.projectId);
    return result(
      "Validation complete",
      { report: await validation.validateRevision(ctx, p.id, input.revisionId, p.settings.savedQueries ?? []) },
      undefined,
      `/p/${p.id}/validate?rev=${input.revisionId}`,
    );
  },
);
define(
  "save_version",
  "Save a reviewed draft as an immutable version using the same commit gate as the UI. Only use when the user has authorized saving. Errors block saving; warnings and omitted candidates need explicit acknowledgement.",
  "save",
  { projectId: id, revisionId: id, expectedHash: hash, acknowledged: boolean, acknowledgedWarnings: boolean },
  ["projectId", "revisionId", "expectedHash"],
  async (
    ctx,
    input: { projectId: string; revisionId: string; expectedHash: string; acknowledged?: boolean; acknowledgedWarnings?: boolean },
  ) => {
    await editable(ctx, input.projectId);
    const rev = await revisions.requireRevision(ctx, input.projectId, input.revisionId);
    if (rev.status === "committed" && rev.contentHash === input.expectedHash)
      return result(
        "Version already saved",
        { revision: rev },
        input.projectId,
        destination(input.projectId, rev.id, !!rev.content.corpus),
      );
    const saved = await saveVersion(ctx, input.projectId, input.revisionId, input);
    return result("Version saved", saved, input.projectId, destination(input.projectId, saved.revision.id, !!rev.content.corpus));
  },
  true,
);
define(
  "create_knowledge_graph",
  "Create a knowledge graph pinned to a saved ontology version. External authoring requires no OntoLab generation provider.",
  "draft",
  { projectId: id, name: { ...text, maxLength: 200 }, ontologyRevisionId: id },
  ["projectId", "name", "ontologyRevisionId"],
  async (ctx, input: { projectId: string; name: string; ontologyRevisionId: string }) => {
    await editable(ctx, input.projectId);
    const pid = identity(ctx, "cor");
    const existing = await ctx.store.projects.get(pid);
    const p = existing?.currentRevisionId ? existing : await corpora.createCorpus(ctx, input.projectId, input, pid);
    return result("Knowledge graph created", { project: p }, input.projectId, `/p/${p.id}/graph?tab=documents`, ["import_document"]);
  },
  true,
);
const runInput = {
  projectId: id,
  documentIds: ids,
  baseRevisionId: nullableId,
  provider: { ...text, maxLength: 80 },
  model: { ...text, maxLength: 120 },
};
interface BuildInput {
  projectId: string;
  documentIds: string[];
  baseRevisionId?: string | null;
  provider: string;
  model: string;
}
interface BuildPlan {
  id: string;
  fingerprint: string;
  input: BuildInput;
  estimate: runs.RunEstimate;
}
async function buildFingerprint(ctx: ServiceCtx, input: BuildInput) {
  const p = await editable(ctx, input.projectId);
  const rev = input.baseRevisionId ? await revisions.requireRevision(ctx, p.id, input.baseRevisionId) : null;
  const docs = await Promise.all(input.documentIds.map((id) => documents.requireDocument(ctx, p.id, id)));
  return digest({
    current: p.currentRevisionId,
    base: rev?.contentHash,
    settings: p.settings,
    purpose: p.purpose,
    scope: p.scope,
    requirements: p.competencyQuestions,
    docs,
  });
}
define(
  "plan_ontology_build",
  "Estimate an OntoLab ontology build and pin its inputs. This does not start generation.",
  "draft",
  runInput,
  ["projectId", "documentIds", "provider", "model"],
  async (ctx, input: BuildInput) => {
    const p = await editable(ctx, input.projectId);
    if (p.settings.corpus) throw new HttpError(409, "Build ontologies in the parent project.");
    const pinned = { ...input, baseRevisionId: input.baseRevisionId === undefined ? p.currentRevisionId : input.baseRevisionId };
    const plan: BuildPlan = {
      id: identity(ctx, "plan"),
      fingerprint: await buildFingerprint(ctx, pinned),
      input: pinned,
      estimate: await runs.estimateRun(ctx, input.projectId, { ...pinned, kind: "induction", mode: "automatic" }),
    };
    await writeState(ctx, `${p.id}/agent/${plan.id}.json`, plan);
    return result("Ontology build plan ready", { plan }, p.id, undefined, ["start_ontology_build"]);
  },
  true,
);
define(
  "start_ontology_build",
  "Start a previously inspected plan and return immediately with its durable run ID.",
  "run",
  { projectId: id, planId: id },
  ["projectId", "planId"],
  async (ctx, input: { projectId: string; planId: string }) => {
    const runId = identity(ctx, "run");
    const old = await ctx.store.runs.get(input.projectId, runId);
    if (old) return result("Ontology build already started", { run: old }, input.projectId, `/p/${input.projectId}/runs/${runId}`);
    const plan = await readState<BuildPlan>(ctx, `${input.projectId}/agent/${input.planId}.json`);
    if (!plan) throw new HttpError(404, "Build plan not found.");
    if (plan.fingerprint !== (await buildFingerprint(ctx, plan.input))) stale();
    const run = await runs.createRun(ctx, input.projectId, { ...plan.input, id: runId, kind: "induction", mode: "automatic" });
    return result("Ontology build started", { run }, input.projectId, `/p/${input.projectId}/runs/${run.id}`, ["get_run"]);
  },
  true,
);
define(
  "plan_graph_update",
  "Plan incremental graph extraction using the graph's configured provider. Does not start generation.",
  "read",
  { projectId: id },
  ["projectId"],
  async (ctx, input: { projectId: string }) => result("Graph update plan", { plan: await corpora.planUpdate(ctx, input.projectId) }),
);
define(
  "start_graph_update",
  "Start a graph update using the inspected plan hash and existing checkpointed worker.",
  "run",
  { projectId: id, planHash: hash, interactive: boolean },
  ["projectId", "planHash"],
  async (ctx, input: { projectId: string; planHash: string; interactive?: boolean }) =>
    result(
      "Graph update started",
      await corpora.startUpdate(ctx, input.projectId, { hash: input.planHash, interactive: input.interactive }),
      input.projectId,
      destination(input.projectId, undefined, true),
      ["get_project_context"],
    ),
  true,
);
define(
  "get_run",
  "Inspect progress, saved checkpoints, required answers and resulting draft. Poll this while a background activity is running.",
  "read",
  { projectId: id, runId: id },
  ["projectId", "runId"],
  async (ctx, input: { projectId: string; runId: string }) =>
    result(
      "Activity progress",
      { run: await runs.getRunView(ctx, input.projectId, input.runId) },
      undefined,
      `/p/${input.projectId}/runs/${input.runId}`,
    ),
);
define(
  "control_run",
  "Pause, resume, retry or cancel an activity. Resume preserves completed checkpoints.",
  "run",
  { projectId: id, runId: id, control: { enum: ["pause", "resume", "retry", "cancel"] } },
  ["projectId", "runId", "control"],
  async (ctx, input: { projectId: string; runId: string; control: string }) => {
    const run = await (input.control === "pause" ? runs.pauseRun : input.control === "cancel" ? runs.cancelRun : runs.retryRun)(
      ctx,
      input.projectId,
      input.runId,
    );
    return result(`Activity ${run.status.replaceAll("_", " ")}`, { run }, input.projectId);
  },
);
define(
  "answer_run_questions",
  "Answer persisted clarification questions, or finish the interactive round. Read get_run first; preserve question IDs.",
  "run",
  {
    projectId: id,
    runId: id,
    answers: { type: "object", maxProperties: 100, additionalProperties: { type: "string", maxLength: 4000 } },
    finish: boolean,
  },
  ["projectId", "runId", "answers", "finish"],
  async (ctx, input: { projectId: string; runId: string; answers: Record<string, string>; finish: boolean }) => {
    const run = await runs.requireRun(ctx, input.projectId, input.runId);
    if (Object.keys(input.answers).some((key) => !run.questions.some((q) => q.id === key)))
      stale("Questions changed. Read the current activity before answering.");
    return result(
      "Answers saved",
      { run: await runs.answerQuestions(ctx, input.projectId, input.runId, input.answers, input.finish) },
      input.projectId,
    );
  },
);
define(
  "prepare_fact_submission",
  "Prepare a durable external-authoring work package. No OntoLab inference provider is required. Read its chunks, submit batches, then finalize.",
  "draft",
  { projectId: id },
  ["projectId"],
  async (ctx, input: { projectId: string }) => {
    const s = await submissions.prepareSubmission(ctx, input.projectId, identity(ctx, "work"));
    return result(
      "Fact work package ready",
      {
        workPackageId: s.id,
        chunks: s.chunks.length,
        plan: s.plan,
        schema: (await revisions.requireRevision(ctx, s.plan.ontology.projectId, s.plan.ontology.revisionId)).content.modules,
      },
      input.projectId,
      undefined,
      ["read_work_package"],
    );
  },
  true,
);
define(
  "read_work_package",
  "Read a bounded page of source chunks and batch coverage from a durable work package.",
  "read",
  { projectId: id, workPackageId: id, offset, limit },
  ["projectId", "workPackageId"],
  async (ctx, input: { projectId: string; workPackageId: string; offset?: number; limit?: number }) => {
    const s = await submissions.getSubmission(ctx, input.projectId, input.workPackageId);
    const start = input.offset ?? 0,
      count = input.limit ?? 5;
    return result("External authoring inputs", {
      id: s.id,
      chunks: s.chunks.slice(start, start + count),
      total: s.chunks.length,
      batches: Object.entries(s.batches).map(([id, b]) => ({ id, hash: b.hash, chunkIds: b.chunkIds })),
      resultRevisionId: s.resultRevisionId,
      nextOffset: start + count < s.chunks.length ? start + count : null,
    });
  },
);
const evidenceSchema = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    properties: { chunkId: id, quote: { type: "string", minLength: 1, maxLength: 10000 } },
    required: ["chunkId", "quote"],
    additionalProperties: false,
  },
};
const factSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { ...properties, evidence: evidenceSchema },
  required,
  additionalProperties: false,
});
const individualsSchema = {
  type: "array",
  maxItems: 200,
  items: factSchema(
    {
      id,
      classUri: { ...text, maxLength: 1000 },
      label: { type: "string", maxLength: 500 },
      dataProperties: {
        type: "array",
        maxItems: 100,
        items: factSchema({ propUri: text, value: text, datatype: text, lang: { type: "string", maxLength: 30 } }, ["propUri", "value"]),
      },
      objectProperties: { type: "array", maxItems: 100, items: factSchema({ propUri: text, targetId: id }, ["propUri", "targetId"]) },
    },
    ["id", "classUri"],
  ),
};
define(
  "submit_fact_batch",
  "Submit proposed facts for specific source chunks. Evidence accepts only chunkId and quote: the server assigns verification, provenance and candidate review state. Submit empty individuals for chunks without facts. To correct a saved batch, read its hash and supply replaceHash.",
  "draft",
  { projectId: id, workPackageId: id, batchId: id, replaceHash: hash, chunkIds: ids, individuals: individualsSchema },
  ["projectId", "workPackageId", "batchId", "chunkIds", "individuals"],
  async (
    ctx,
    input: {
      projectId: string;
      workPackageId: string;
      batchId: string;
      replaceHash?: string;
      chunkIds: string[];
      individuals: ABoxResult["individuals"];
    },
  ) =>
    result(
      "Fact batch saved",
      await submissions.submitBatch(
        ctx,
        input.projectId,
        input.workPackageId,
        input.batchId,
        input.chunkIds,
        {
          individuals: input.individuals,
        },
        input.replaceHash,
      ),
      input.projectId,
    ),
  true,
);
define(
  "finalize_fact_submission",
  "Assemble all submitted source chunks into a separate graph draft. Missing coverage or schema errors are reported. Existing decisions and source-loss review are preserved.",
  "draft",
  { projectId: id, workPackageId: id },
  ["projectId", "workPackageId"],
  async (ctx, input: { projectId: string; workPackageId: string }) => {
    const revision = await submissions.finalizeSubmission(ctx, input.projectId, input.workPackageId);
    return result("Graph draft ready to review", { revision }, input.projectId, destination(input.projectId, revision.id, true), [
      "review_facts",
      "validate_revision",
    ]);
  },
  true,
);
define(
  "list_facts",
  "List fact review candidates and their located evidence.",
  "read",
  { projectId: id, revisionId: id, status: { enum: ["candidate", "accepted", "rejected", "all"] }, limit },
  ["projectId", "revisionId"],
  async (ctx, input: { projectId: string; revisionId: string; status?: "candidate" | "accepted" | "rejected" | "all"; limit?: number }) =>
    result(
      "Fact review queue",
      await review.factQueue(ctx, input.projectId, input.revisionId, input.status ?? "candidate", input.limit ?? 100),
    ),
);
define(
  "review_facts",
  "Record explicitly authorized fact-review decisions against the expected draft hash.",
  "save",
  {
    projectId: id,
    revisionId: id,
    expectedHash: hash,
    decisions: {
      type: "array",
      minItems: 1,
      maxItems: 2000,
      items: {
        type: "object",
        properties: { key: text, status: { enum: ["accepted", "rejected", "candidate"] }, reason: text },
        required: ["key", "status"],
        additionalProperties: false,
      },
    },
  },
  ["projectId", "revisionId", "expectedHash", "decisions"],
  async (
    ctx,
    input: { projectId: string; revisionId: string; expectedHash: string; decisions: Parameters<typeof review.reviewFacts>[3] },
  ) => {
    const rev = await revisions.requireRevision(ctx, input.projectId, input.revisionId);
    if (rev.contentHash !== input.expectedHash) stale("The fact draft changed. Refresh its review queue.");
    return result(
      "Fact decisions saved",
      await review.reviewFacts(ctx, input.projectId, rev.id, input.decisions),
      input.projectId,
      destination(input.projectId, rev.id, !!rev.content.corpus),
    );
  },
);
define(
  "query_graph",
  "Run a bounded read-only query. Local revisions and connected RDF graphs use SPARQL SELECT/ASK; connected Neo4j uses Cypher. Local results follow the UI review policy.",
  "read",
  { projectId: id, revisionId: id, query: { ...text, maxLength: 20000 } },
  ["projectId", "query"],
  async (ctx, input: { projectId: string; revisionId?: string; query: string }) => {
    const p = await projects.requireProject(ctx, input.projectId);
    if (p.settings.externalGraph) return result("Read-only connected graph result", await externalQuery(ctx, p.id, input.query));
    if (!input.revisionId) throw new HttpError(400, "Choose a revisionId for a local graph query.");
    return result("Query result", await validation.runQuery(ctx, input.projectId, input.revisionId, input.query));
  },
);
define(
  "create_export",
  "Export reviewed RDF Turtle for a saved local version. Returns content without writing arbitrary filesystem paths.",
  "read",
  { projectId: id, revisionId: id },
  ["projectId", "revisionId"],
  async (ctx, input: { projectId: string; revisionId: string }) => {
    const p = await projects.requireProject(ctx, input.projectId),
      rev = await revisions.requireRevision(ctx, p.id, input.revisionId);
    if (rev.status !== "committed") throw new HttpError(409, "Save a reviewed version before exporting.");
    const exported = await exportTurtle(ctx, p.id, rev.id, "combined", false);
    return result("Turtle export ready", {
      name: exported.filename,
      mediaType: "text/turtle",
      contentHash: contentHash(rev.content),
      turtle: exported.turtle,
    });
  },
);

interface AlignmentPlan {
  id: string;
  revisionId: string;
  expectedHash: string;
  setup: unknown;
  estimate: unknown;
}
define(
  "plan_alignment",
  "Plan ontology alignment using existing matchers and optional model verification. Returns a pinned plan without starting work.",
  "draft",
  { projectId: id, revisionId: id, expectedHash: hash, setup: { type: "object" } },
  ["projectId", "revisionId", "expectedHash", "setup"],
  async (ctx, input: { projectId: string; revisionId: string; expectedHash: string; setup: unknown }) => {
    await editable(ctx, input.projectId);
    const plan: AlignmentPlan = {
      id: identity(ctx, "alignment"),
      revisionId: input.revisionId,
      expectedHash: input.expectedHash,
      setup: input.setup,
      estimate: await alignment.estimateAlignment(ctx, input.projectId, input.revisionId, input.setup, input.expectedHash),
    };
    await writeState(ctx, `${input.projectId}/agent/${plan.id}.json`, plan);
    return result("Alignment plan ready", { plan }, input.projectId, undefined, ["start_alignment"]);
  },
  true,
);
define(
  "start_alignment",
  "Start a pinned alignment plan. Produces a separate review draft and returns its background activity.",
  "run",
  { projectId: id, planId: id },
  ["projectId", "planId"],
  async (ctx, input: { projectId: string; planId: string }) => {
    const rid = identity(ctx, "run");
    const existing = await ctx.store.runs.get(input.projectId, rid);
    if (existing) return result("Alignment already started", { run: existing }, input.projectId);
    const plan = await readState<AlignmentPlan>(ctx, `${input.projectId}/agent/${input.planId}.json`);
    if (!plan) throw new HttpError(404, "Alignment plan not found.");
    const run = await alignment.createAlignmentRun(ctx, input.projectId, plan.revisionId, plan.setup, plan.expectedHash, rid);
    return result(
      "Alignment started",
      { run },
      input.projectId,
      `/p/${input.projectId}/workflows/alignment?step=match&run=${run.id}&rev=${plan.revisionId}`,
    );
  },
  true,
);
