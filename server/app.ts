import { searchSavedEvidence, savedPassageContext } from "./services/sourceRetrieval.ts";
import { workspaceEvents, readState } from "./actions/state.ts";
import { actionDefinitions, executeAction } from "./actions/index.ts";
import { saveVersion } from "./actions/saveVersion.ts";
import { agentChat } from "./actions/assistant.ts";
import { registerConnectionRoutes } from "./connections/routes.ts";
import { serveDocumentation } from "./documentation.ts";
import { registerCorpusRoutes } from "./corpusRoutes.ts";
import { deleteModelEndpoint, discoverModels, listModelEndpoints, saveModelEndpoint } from "./customProviders.ts";
import {
  inspectEvidence,
  parseEvidenceRequest,
  savedEvidenceText,
  evidenceOriginal,
  evidenceStructure,
} from "./services/evidenceInspector.ts";
import { registerEvaluationRoutes } from "./evaluationRoutes.ts";
// The OntoLab HTTP application: static SPA, the legacy stateless LLM endpoints
// (kept as authenticated compatibility wrappers) and the project API.
//
// createApp() takes its collaborators (store, authenticator, logger, clock) as
// arguments so the whole HTTP surface can be exercised in tests with a temp
// directory store and fake users; server/index.ts wires the real ones.

import type http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import mammoth from "mammoth";
import { listProviders, resolveModel, callProvider, ProviderError, TruncatedOutputError, type ChatMessage } from "./providers.ts";
import { isLocalCliConnection } from "./cli/localAccess.ts";
import { localCliEnabled } from "./cli/catalog.ts";
import { extractABox, refineABox, editABox, generateTBox, suggestTBox, competencyQuestion, type CallContext } from "./extract.ts";
import { HttpError, json, send, readJsonBody, readRawBody, checkAuth, clientKey, rateLimit, withSlot, logCall } from "./http.ts";
import { requireTBox, requireDocs, requireAbox, requireString, optionalString, optionalStringArray } from "./validation.ts";
import {
  BASE_PATH,
  MAX_FILE_BASE64,
  MAX_GRAPH_NODES,
  MAX_UPLOAD_BYTES,
  MAX_ARCHIVE_BYTES,
  MAX_DOCUMENTS_PER_PROJECT,
  MAX_SOURCES_PER_CORPUS,
  STORAGE_QUOTA_BYTES,
  PARSER_URL,
  EMBEDDINGS_BACKEND,
  NLI_BACKEND,
  REUSE_SOURCES,
} from "./config.ts";
import { Router, FileResponse, StatusResponse, StreamResponse, headerString } from "./router.ts";
import { ConflictError, NotFoundError, type Store } from "./store/types.ts";
import type { Authenticator } from "./auth.ts";
import { consoleLogger, type Logger, type ServiceCtx } from "./services/context.ts";
import * as projects from "./services/projects.ts";
import * as documents from "./services/documents.ts";
import * as research from "./services/research.ts";
import * as revisions from "./services/revisions.ts";
import * as alignmentRuns from "./services/alignmentRuns.ts";
import * as runs from "./services/runs.ts";
import * as validation from "./services/validation.ts";
import * as assistant from "./services/assistant.ts";
import * as graphChat from "./services/graphChat.ts";
import { graphdbConfigured, graphdbStatus } from "./graphchat/graphdb.ts";
import * as archive from "./services/archive.ts";
import * as requirements from "./services/requirements.ts";
import * as semantic from "./services/semanticReview.ts";
import { effectiveTier } from "./services/reasoner.ts";
import * as templates from "./services/templates.ts";
import * as review from "./services/review.ts";
import { toTurtle } from "./services/rdfConvert.ts";
import { availableSources } from "./services/grounding.ts";
import type { AnswerRoute, ClientConfig, RunOptions } from "../src/types/project.ts";
import type { AlignmentReviewInput } from "../src/types/alignment.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** dist/ next to the bundled server (Docker: /app/dist) or one level up from server/ (tsx). */
function defaultDist(): string {
  const here = resolve(import.meta.dirname, "dist");
  return existsSync(here) ? here : resolve(import.meta.dirname, "..", "dist");
}

export interface AppDeps {
  store: Store;
  auth: Authenticator;
  log?: Logger;
  now?: () => Date;
  distDir?: string;
  docsDir?: string;
  /** the background worker is running (the browser need not drive runs) */
  workerEnabled?: boolean;
  shutdownSignal?: AbortSignal;
  /** Override the configured mount prefix for a specific app instance. */
  basePath?: string;
}

/* ───────────────────────── legacy stateless endpoints ───────────────────────── */

type LegacyHandler = (body: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>;

function callContext(body: Record<string, unknown>, signal: AbortSignal, structured = true): CallContext {
  const { provider, model } = resolveModel(body.provider as string | undefined, body.model as string | undefined, { structured });
  return { provider, model, signal };
}

const legacyRoutes: Record<string, { handler: LegacyHandler; llm?: boolean }> = {
  "/api/extract": {
    llm: true,
    handler: async (body, { signal }) =>
      extractABox({ tbox: requireTBox(body.tbox), documents: requireDocs(body.documents) }, callContext(body, signal)),
  },
  "/api/refine": {
    llm: true,
    handler: async (body, { signal }) => {
      const clarifications = Array.isArray(body.clarifications)
        ? (body.clarifications as { question?: unknown; answer?: unknown }[])
            .filter((c) => typeof c?.question === "string" && typeof c?.answer === "string")
            .map((c) => ({ question: c.question as string, answer: c.answer as string }))
        : [];
      const previousAbox = body.previousAbox ? requireAbox(body.previousAbox, "previousAbox") : undefined;
      return refineABox(
        { tbox: requireTBox(body.tbox), documents: requireDocs(body.documents), clarifications, previousAbox },
        callContext(body, signal),
      );
    },
  },
  "/api/edit": {
    llm: true,
    handler: async (body, { signal }) => {
      const history = Array.isArray(body.history)
        ? (body.history as { role?: unknown; content?: unknown }[])
            .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
        : [];
      return editABox(
        {
          tbox: requireTBox(body.tbox),
          currentAbox: requireAbox(body.currentAbox, "currentAbox"),
          instruction: requireString(body.instruction, "instruction", { max: 10_000 }),
          history,
        },
        callContext(body, signal),
      );
    },
  },
  "/api/generate-tbox": {
    llm: true,
    handler: async (body, { signal }) => {
      const standardsOntologies = Array.isArray(body.standardsOntologies)
        ? (body.standardsOntologies as { name?: unknown; turtle?: unknown }[])
            .filter((o) => typeof o?.turtle === "string")
            .map((o) => ({ name: typeof o.name === "string" ? o.name : "ontology", turtle: o.turtle as string }))
        : [];
      return generateTBox(
        {
          documents: requireDocs(body.documents, "documents", { allowEmpty: true }),
          standardsDocuments: requireDocs(body.standardsDocuments, "standardsDocuments", { allowEmpty: true }),
          standardsOntologies,
          baseIri: optionalString(body.baseIri, "baseIri", { max: 500 }),
          guidance: optionalString(body.guidance, "guidance"),
          currentTurtle: optionalString(body.currentTurtle, "currentTurtle", { max: 2_000_000 }),
          instruction: optionalString(body.instruction, "instruction"),
          baseTurtle: optionalString(body.baseTurtle, "baseTurtle", { max: 2_000_000 }),
          purpose: optionalString(body.purpose, "purpose"),
          scope: optionalString(body.scope, "scope"),
          competencyQuestions: optionalStringArray(body.competencyQuestions, "competencyQuestions"),
        },
        callContext(body, signal),
      );
    },
  },
  "/api/suggest-tbox": {
    llm: true,
    handler: async (body, { signal }) => {
      const modules = Array.isArray(body.modules)
        ? (body.modules as { name?: unknown; turtle?: unknown }[])
            .filter((m) => typeof m?.turtle === "string")
            .map((m) => ({ name: typeof m.name === "string" ? m.name : "module.ttl", turtle: m.turtle as string }))
        : [];
      return suggestTBox({ tbox: requireTBox(body.tbox), documents: requireDocs(body.documents), modules }, callContext(body, signal));
    },
  },
  "/api/cq": {
    llm: true,
    handler: async (body, { signal }) =>
      competencyQuestion(
        {
          tbox: requireTBox(body.tbox),
          abox: requireAbox(body.abox),
          question: requireString(body.question, "question", { max: 2000 }),
          baseIri: optionalString(body.baseIri, "baseIri", { max: 500 }),
        },
        callContext(body, signal),
      ),
  },
  "/api/chat": {
    llm: true,
    handler: async (body, { signal }) => {
      const messages = Array.isArray(body.messages)
        ? (body.messages as { role?: unknown; content?: unknown }[])
            .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
        : [];
      if (!messages.length) throw new HttpError(400, "messages is required");
      if (messages[0].role !== "user") throw new HttpError(400, "The conversation must start with a user message.");
      const { provider, model } = resolveModel(body.provider as string | undefined, body.model as string | undefined, {
        structured: false,
      });
      const content = await callProvider(provider, {
        model,
        messages: messages as ChatMessage[],
        graphContext: optionalString(body.graphContext, "graphContext", { max: 2_000_000 }) ?? "",
        signal,
      });
      return { content };
    },
  },
  "/api/convert-rdf": {
    handler: async (body) => {
      const name = optionalString(body.name, "name", { max: 300 }) ?? "ontology";
      const text = requireString(body.text, "text", { max: MAX_FILE_BASE64 });
      return toTurtle(name, text);
    },
  },
  "/api/parse-doc": {
    handler: async (body) => {
      const base64 = requireString(body.base64, "base64", { max: MAX_FILE_BASE64 });
      const name = optionalString(body.name, "name", { max: 300 }) ?? "document";
      try {
        const result = await mammoth.extractRawText({ buffer: Buffer.from(base64, "base64") });
        return { text: result.value };
      } catch {
        throw new HttpError(422, `Could not read ${name}. Is it a valid .docx file?`);
      }
    },
  },
};

/* ───────────────────────── project API ───────────────────────── */

export interface RouteCtx {
  req: http.IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  svc: ServiceCtx;
  signal: AbortSignal;
  json<T = Record<string, unknown>>(): Promise<T>;
  raw(max: number): Promise<Buffer>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function buildRouter(): Router<RouteCtx> {
  const r = new Router<RouteCtx>();
  r.get("/api/projects/:pid/agent/conversations/:thread", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    const saved = await readState(svc, `${params.pid}/agent/${params.thread}.json`);
    if (!saved) throw new HttpError(404, "Conversation not found.");
    return saved;
  });
  r.get("/api/projects/:pid/agent/events", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    return new StreamResponse(async (emit, signal) => {
      emit({ type: "refresh" });
      await new Promise<void>((resolve) => {
        const changed = (owner: string, pid: string) => {
          if (owner === svc.user.id && pid === params.pid) emit({ type: "refresh" });
        };
        const timer = setInterval(() => emit({ type: "refresh" }), 15000);
        const close = () => {
          clearInterval(timer);
          workspaceEvents.off("changed", changed);
          resolve();
        };
        workspaceEvents.on("changed", changed);
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      });
    });
  });
  r.get("/api/actions", async () => ({ actions: actionDefinitions() }));
  r.post("/api/actions/:action", async ({ svc, params, json: body }) => executeAction(svc, params.action, await body()), {
    abortOnClose: false,
  });
  r.post("/api/projects/:pid/agent/chat", async ({ svc, params, json: body, signal }) => agentChat(svc, params.pid, await body(), signal), {
    llm: true,
  });
  registerCorpusRoutes(r);
  registerEvaluationRoutes(r);
  registerConnectionRoutes(r);
  // Saved OpenAI-compatible endpoints. Responses never include the stored key.
  r.get("/api/model-endpoints", async () => listModelEndpoints());
  r.post("/api/model-endpoints", async ({ svc, json: body }) => ({
    endpoint: await saveModelEndpoint(await body(), undefined, svc.now()),
  }));
  r.put("/api/model-endpoints/:eid", async ({ svc, params, json: body }) => ({
    endpoint: await saveModelEndpoint(await body(), params.eid, svc.now()),
  }));
  r.delete("/api/model-endpoints/:eid", async ({ params }) => deleteModelEndpoint(params.eid));
  r.post("/api/model-endpoints/discover", async ({ json: body, signal }) => discoverModels(await body(), signal));
  r.post("/api/projects/:pid/evidence/inspect", async ({ svc, params, json: body }) =>
    inspectEvidence(svc, params.pid, parseEvidenceRequest(await body())),
  );
  r.post("/api/projects/:pid/evidence/original", async ({ svc, params, json: body }) => {
    const { bytes, doc } = await evidenceOriginal(svc, params.pid, parseEvidenceRequest(await body()));
    return new FileResponse(bytes, doc.mediaType, doc.name);
  });
  r.post("/api/projects/:pid/evidence/structure", async ({ svc, params, json: body }) => {
    const b = await body();
    if (b.elementIndex !== undefined && typeof b.elementIndex !== "number") throw new HttpError(400, "Invalid structural location.");
    return evidenceStructure(svc, params.pid, parseEvidenceRequest(b), b.elementIndex ?? 0);
  });
  r.get("/api/projects/:pid/runs/:runId/documents/:did/evidence", async ({ svc, params }) =>
    savedEvidenceText(svc, params.pid, params.runId, params.did),
  );

  r.get("/api/me", async ({ svc }) => ({ user: svc.user }));
  // The desktop server intercepts this route with its local MCP capability.
  // Web clients get an explicit unavailable state, not a generic HTTP error.
  r.get("/api/local-mcp", async () => ({ available: false, connections: [], projects: [] }));
  r.get("/api/usage", async ({ svc }) => ({ ...(await svc.store.usage()), quotaBytes: STORAGE_QUOTA_BYTES }));

  // projects
  r.get("/api/projects", async ({ svc }) => ({ projects: await projects.listProjects(svc) }));
  r.post(
    "/api/projects",
    async ({ svc, json: body }) => new StatusResponse(201, { project: await projects.createProject(svc, await body()) }),
  );
  r.post("/api/projects/sample", async ({ svc }) => new StatusResponse(201, { project: await projects.createSampleProject(svc) }));
  r.get("/api/templates", async () => ({ templates: await templates.listTemplates() }));
  r.post("/api/projects/template", async ({ svc, json: body }) => {
    const b = await body();
    return new StatusResponse(201, {
      project: await templates.createFromTemplate(svc, requireString(b.templateId, "templateId", { max: 60 }), str(b.name)),
    });
  });
  r.post(
    "/api/projects/import",
    async ({ svc, raw }) => new StatusResponse(201, { project: await archive.importArchive(svc, await raw(MAX_ARCHIVE_BYTES)) }),
  );
  r.get("/api/projects/:pid", async ({ svc, params }) => ({ project: await projects.requireProject(svc, params.pid) }));
  r.patch("/api/projects/:pid", async ({ svc, params, json: body }) => ({
    project: await projects.updateProject(svc, params.pid, await body()),
  }));
  r.delete("/api/projects/:pid", async ({ svc, params }) => {
    await projects.deleteProject(svc, params.pid);
    return { ok: true };
  });
  // requirements: user stories -> competency questions (A1)
  r.put("/api/projects/:pid/requirements", async ({ svc, params, json: body }) => ({
    project: await requirements.saveRequirements(svc, params.pid, await body()),
  }));
  r.post("/api/projects/:pid/requirements/versions/:version/restore", async ({ svc, params }) => ({
    project: await requirements.restoreRequirements(svc, params.pid, Number(params.version)),
  }));
  r.post(
    "/api/projects/:pid/requirements/suggest-story",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return requirements.suggestStory(
        svc,
        params.pid,
        {
          story: optionalString(b.story, "story", { max: 1000 }),
          otherStories: optionalStringArray(b.otherStories, "otherStories"),
          provider: str(b.provider),
          model: str(b.model),
        },
        signal,
      );
    },
    { llm: true },
  );
  r.post(
    "/api/projects/:pid/requirements/generate",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return {
        project: await requirements.generateCqs(
          svc,
          params.pid,
          { stories: optionalStringArray(b.stories, "stories"), provider: str(b.provider), model: str(b.model) },
          signal,
        ),
      };
    },
    { llm: true },
  );
  // answerability: schema-level (terms + links) and data-level (stored query returns rows)
  r.post(
    "/api/projects/:pid/requirements/answerability",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return {
        project: await requirements.checkAnswerability(
          svc,
          params.pid,
          { provider: str(b.provider), model: str(b.model), refresh: b.refresh === true },
          signal,
        ),
      };
    },
    { llm: true },
  );
  r.post(
    "/api/projects/:pid/requirements/generate-from-tbox",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return {
        project: await requirements.generateCqsFromTBox(
          svc,
          params.pid,
          { provider: str(b.provider), model: str(b.model), max: typeof b.max === "number" ? b.max : undefined },
          signal,
        ),
      };
    },
    { llm: true },
  );
  r.post(
    "/api/projects/:pid/requirements/retranslate-stale",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return requirements.retranslateStale(svc, params.pid, { provider: str(b.provider), model: str(b.model) }, signal);
    },
    { llm: true },
  );
  r.post(
    "/api/projects/:pid/requirements/:cqId/translate",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return requirements.translateCq(svc, params.pid, params.cqId, { provider: str(b.provider), model: str(b.model) }, signal);
    },
    { llm: true },
  );
  r.get("/api/projects/:pid/archive", async ({ svc, params }) => {
    const { bytes, filename } = await archive.exportArchive(svc, params.pid);
    return new FileResponse(bytes, "application/gzip", filename);
  });

  // documents
  r.post(
    "/api/projects/:pid/templates/:tid",
    async ({ svc, params }) => new StatusResponse(201, { revision: await templates.applyTemplate(svc, params.pid, params.tid) }),
  );
  r.get("/api/projects/:pid/documents", async ({ svc, params }) => ({ documents: await documents.listDocuments(svc, params.pid) }));
  r.post("/api/projects/:pid/documents", async ({ svc, params, req, raw }) => {
    if ((await projects.requireProject(svc, params.pid)).settings.corpus)
      throw new HttpError(409, "Upload sources through the corpus document list to preserve source membership and versions.");
    let name = headerString(req, "x-file-name") ?? "document";
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep the raw header */
    }
    const bytes = await raw(MAX_UPLOAD_BYTES);
    return new StatusResponse(201, { document: await documents.uploadDocument(svc, params.pid, name, bytes, { deferParsing: true }) });
  });
  r.get("/api/projects/:pid/documents/:did/text", async ({ svc, params }) => documents.documentText(svc, params.pid, params.did));
  r.get("/api/projects/:pid/research/chunk-models", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    return research.chunkModels();
  });
  r.get("/api/projects/:pid/research/chunking", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    return research.chunkDefaults();
  });
  r.post("/api/projects/:pid/documents/:did/chunk-preview", async ({ svc, params, json: body }) =>
    research.previewChunks(svc, params.pid, params.did, await body()),
  );
  r.post("/api/projects/:pid/documents/:did/chunk-variant", async ({ svc, params, json: body }) => {
    const b = await body();
    return { document: await research.saveChunkVariant(svc, params.pid, params.did, b.settings, b.textHash) };
  });
  r.get("/api/projects/:pid/documents/:did/file", async ({ svc, params }) => {
    const { bytes, doc } = await documents.documentFile(svc, params.pid, params.did);
    return new FileResponse(bytes, doc.mediaType, doc.name);
  });
  r.post("/api/projects/:pid/documents/:did/retry", async ({ svc, params }) => ({
    document: await documents.retryParse(svc, params.pid, params.did, true),
  }));
  r.post(
    "/api/projects/:pid/documents/:did/reprocess",
    async ({ svc, params }) => new StatusResponse(201, { document: await documents.reprocessDocument(svc, params.pid, params.did) }),
  );
  r.delete("/api/projects/:pid/documents/:did", async ({ svc, params }) => {
    await documents.removeDocument(svc, params.pid, params.did);
    return { ok: true };
  });

  // revisions
  r.get("/api/projects/:pid/revisions", async ({ svc, params }) => ({ revisions: await revisions.listRevisions(svc, params.pid) }));
  r.post("/api/projects/:pid/revisions", async ({ svc, params, json: body }) => {
    const b = await body();
    const source = (["manual", "import", "ontology"] as const).find((s) => s === b.source) ?? "manual";
    const rev = await revisions.createRevision(svc, params.pid, {
      content: revisions.parseContent(b.content),
      source,
      summary: str(b.summary) ?? "",
    });
    return new StatusResponse(201, { revision: rev });
  });
  r.get("/api/projects/:pid/revisions/:rid", async ({ svc, params }) => ({
    revision: await revisions.requireRevision(svc, params.pid, params.rid),
  }));
  r.put("/api/projects/:pid/revisions/:rid", async ({ svc, params, json: body }) => {
    const b = await body();
    return {
      revision: await revisions.updateDraft(
        svc,
        params.pid,
        params.rid,
        revisions.parseContent(b.content),
        str(b.summary),
        false,
        str(b.expectedHash),
      ),
    };
  });
  r.delete("/api/projects/:pid/revisions/:rid", async ({ svc, params }) => {
    await revisions.discardDraft(svc, params.pid, params.rid);
    return { ok: true };
  });
  r.post("/api/projects/:pid/revisions/:rid/commit", async ({ svc, params, json: body }) => {
    const b = await body().catch(() => ({}) as Record<string, unknown>);
    return saveVersion(svc, params.pid, params.rid, {
      expectedHash: str(b.expectedHash),
      acknowledged: b.acknowledged === true,
      acknowledgedWarnings: b.acknowledgedWarnings === true,
    });
  });
  r.post("/api/projects/:pid/revisions/:rid/rebase", async ({ svc, params }) => ({
    revision: await revisions.rebaseDraft(svc, params.pid, params.rid),
  }));
  r.post("/api/projects/:pid/revisions/:rid/restore", async ({ svc, params }) => ({
    revision: await revisions.restoreRevision(svc, params.pid, params.rid),
  }));
  r.get("/api/projects/:pid/revisions/:rid/diff", async ({ svc, params, query }) => ({
    diff: await revisions.compareRevisions(svc, params.pid, query.get("from") || null, params.rid),
  }));
  r.post("/api/projects/:pid/revisions/:rid/validate", async ({ svc, params, json: body }) => {
    const b = await body();
    const queries = Array.isArray(b.queries)
      ? (b.queries as { question?: unknown; sparql?: unknown }[])
          .filter((q) => typeof q?.question === "string")
          .map((q) => ({ question: q.question as string, sparql: str(q.sparql) }))
      : [];
    return { report: await validation.validateRevision(svc, params.pid, params.rid, queries) };
  });
  r.post("/api/projects/:pid/revisions/:rid/check", async ({ svc, params }) => ({
    check: await validation.checkDraft(svc, params.pid, params.rid),
  }));
  r.get("/api/projects/:pid/revisions/:rid/report", async ({ svc, params }) => ({
    report: await validation.latestReport(svc, params.pid, params.rid),
  }));
  r.get("/api/projects/:pid/revisions/:rid/report/download", async ({ svc, params, query }) => {
    const out = await validation
      .latestReport(svc, params.pid, params.rid)
      .then(() => archive.exportReport(svc, params.pid, params.rid, query.get("format") === "md" ? "md" : "json"));
    return new FileResponse(out.body, out.contentType, out.filename);
  });
  r.post(
    "/api/projects/:pid/revisions/:rid/cq",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return validation.askCompetencyQuestion(
        svc,
        params.pid,
        params.rid,
        requireString(b.question, "question", { max: 2000 }),
        str(b.provider),
        str(b.model),
        signal,
      );
    },
    { llm: true },
  );
  r.post("/api/projects/:pid/revisions/:rid/sparql", async ({ svc, params, json: body }) => {
    const b = await body();
    try {
      return await validation.runQuery(svc, params.pid, params.rid, requireString(b.sparql, "sparql", { max: 20_000 }));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e instanceof Error ? e.message : "Query failed");
    }
  });
  r.post("/api/projects/:pid/revisions/:rid/graphdb", async ({ svc, params, json: body }) => {
    const b = await body();
    return {
      graphdb: await graphChat.publishToGraphDb(svc, params.pid, params.rid, {
        repository: str(b.repository),
        graph: typeof b.graph === "string" ? b.graph : undefined,
        acknowledged: b.acknowledged === true,
      }),
    };
  });
  r.get("/api/projects/:pid/revisions/:rid/export", async ({ svc, params, query }) => {
    const scope = (["abox", "tbox", "combined"] as const).find((s) => s === query.get("scope")) ?? "combined";
    const provenance = (["none", "source", "reified"] as const).find((p) => p === query.get("provenance")) ?? "source";
    const out = await archive.exportTurtle(svc, params.pid, params.rid, scope, query.get("ack") === "1", { provenance });
    return new FileResponse(out.turtle, "text/turtle; charset=utf-8", out.filename);
  });

  // ontology review (A3, A4, A6) and entity-resolution decisions (B3)
  r.get("/api/projects/:pid/revisions/:rid/pitfalls", async ({ svc, params }) => ({
    pitfalls: await review.revisionPitfalls(svc, params.pid, params.rid),
  }));
  r.get("/api/projects/:pid/revisions/:rid/semantic-review", async ({ svc, params }) => ({
    findings: await semantic.latestSemanticReview(svc, params.pid, params.rid),
  }));
  r.post(
    "/api/projects/:pid/revisions/:rid/semantic-review",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return {
        findings: await semantic.semanticReview(svc, params.pid, params.rid, { provider: str(b.provider), model: str(b.model) }, signal),
      };
    },
    { llm: true },
  );
  r.get(
    "/api/projects/:pid/revisions/:rid/reuse",
    async ({ svc, params }) => ({ suggestions: await review.reuseSuggestions(svc, params.pid, params.rid) }),
    { llm: true },
  );
  r.post("/api/projects/:pid/revisions/:rid/reuse", async ({ svc, params, json: body }) => {
    const b = await body();
    return {
      revision: await review.acceptReuse(svc, params.pid, params.rid, {
        term: requireString(b.term, "term", { max: 2000 }),
        iri: requireString(b.iri, "iri", { max: 2000 }),
        kind: b.kind === "property" ? "property" : "class",
      }),
    };
  });
  r.post(
    "/api/projects/:pid/revisions/:rid/align",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      const input = {
        sourceModules: optionalStringArray(b.sourceModules, "sourceModules") ?? [],
        targetModules: optionalStringArray(b.targetModules, "targetModules") ?? [],
        matchers:
          b.matchers && typeof b.matchers === "object"
            ? Object.fromEntries(
                ["lexical", "semantic", "structural"].map((key) => [key, (b.matchers as Record<string, unknown>)[key] !== false]),
              )
            : undefined,
        provider: str(b.provider),
        model: str(b.model),
        maxSource: b.maxSource as number | null | undefined,
        expectedHash: str(b.expectedHash),
      };
      return { revision: await review.alignModules(svc, params.pid, params.rid, input, signal) };
    },
    { llm: true },
  );
  r.post("/api/projects/:pid/revisions/:rid/align/estimate", async ({ svc, params, json: body }) => {
    const b = await body();
    return { estimate: await alignmentRuns.estimateAlignment(svc, params.pid, params.rid, b.setup, str(b.expectedHash)) };
  });
  r.post("/api/projects/:pid/revisions/:rid/align/runs", async ({ svc, params, json: body }) => {
    const b = await body();
    const run = await alignmentRuns.createAlignmentRun(svc, params.pid, params.rid, b.setup, str(b.expectedHash));
    return new StatusResponse(201, { run: runs.toView(run, [], svc.now()) });
  });
  r.post("/api/projects/:pid/revisions/:rid/align/setup", async ({ svc, params, json: body }) => {
    const b = await body();
    return { revision: await review.saveAlignmentSetup(svc, params.pid, params.rid, b.setup, str(b.expectedHash)) };
  });
  r.post("/api/projects/:pid/revisions/:rid/align/review", async ({ svc, params, json: body }) => {
    const b = await body();
    return {
      revision: await review.reviewAlignment(svc, params.pid, params.rid, {
        action: requireString(b.action, "action") as AlignmentReviewInput["action"],
        ids: optionalStringArray(b.ids, "ids"),
        source: str(b.source),
        target: str(b.target),
        relation: str(b.relation) as AlignmentReviewInput["relation"],
        note: str(b.note),
        expectedHash: str(b.expectedHash),
      }),
    };
  });
  r.post("/api/projects/:pid/revisions/:rid/align/accept", async ({ svc, params, json: body }) => {
    const b = await body();
    return {
      revision: await review.acceptAlignment(svc, params.pid, params.rid, optionalStringArray(b.ids, "ids") ?? [], {
        force: b.force === true,
      }),
    };
  });
  // per-fact review: a queue of facts (least certain first) and accept/reject decisions
  r.get("/api/projects/:pid/revisions/:rid/facts", async ({ svc, params, query }) => {
    const status = query.get("status");
    const pick = status === "accepted" || status === "rejected" || status === "all" ? status : "candidate";
    return review.factQueue(svc, params.pid, params.rid, pick, Number(query.get("limit")) || 500);
  });
  r.post("/api/projects/:pid/revisions/:rid/facts/review", async ({ svc, params, json: body }) => {
    const b = await body();
    const decisions = Array.isArray(b.decisions)
      ? (b.decisions as { key?: unknown; status?: unknown; reason?: unknown }[])
          .filter((d) => typeof d?.key === "string" && (d.status === "accepted" || d.status === "rejected" || d.status === "candidate"))
          .slice(0, 2000)
          .map((d) => ({
            key: d.key as string,
            status: d.status as "accepted" | "rejected" | "candidate",
            ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
          }))
      : [];
    return review.reviewFacts(svc, params.pid, params.rid, decisions);
  });
  r.post("/api/projects/:pid/revisions/:rid/merges", async ({ svc, params, json: body }) => {
    const b = await body();
    const decisions = Array.isArray(b.decisions)
      ? (b.decisions as { id?: unknown; decision?: unknown; keep?: unknown }[])
          .filter((d) => typeof d?.id === "string" && (d.decision === "merge" || d.decision === "distinct"))
          .map((d) => ({
            id: d.id as string,
            decision: d.decision as "merge" | "distinct",
            ...(typeof d.keep === "string" ? { keep: d.keep } : {}),
          }))
      : [];
    return {
      revision: await review.decideMerges(svc, params.pid, params.rid, { decisions, applyRecommended: b.applyRecommended === true }),
    };
  });

  // runs
  const runInput = (b: Record<string, unknown>): runs.CreateRunInput => {
    if (b.baseRevisionId !== undefined && b.baseRevisionId !== null && typeof b.baseRevisionId !== "string")
      throw new HttpError(400, "Starting version must be a revision ID or null.");
    const o = (b.options && typeof b.options === "object" ? b.options : {}) as Record<string, unknown>;
    const options: Partial<RunOptions> = {};
    options.reasoningEffort = optionalString(o.reasoningEffort, "reasoningEffort", { max: 20 });
    for (const k of [
      "reuseCache",
      "incremental",
      "relevanceScreen",
      "resolveEntities",
      "verifyEvidence",
      "cqGuided",
      "inductionAxioms",
      "repair",
      "strictGrounding",
    ] as const)
      if (typeof o[k] === "boolean") options[k] = o[k] as boolean;
    if (Array.isArray(o.grounding)) options.grounding = (o.grounding as unknown[]).filter((x): x is string => typeof x === "string");
    // ablation switches: the service keeps only values it knows
    if (typeof o.promptStyle === "string") options.promptStyle = o.promptStyle as RunOptions["promptStyle"];
    if (typeof o.schemaRetrieval === "string") options.schemaRetrieval = o.schemaRetrieval as RunOptions["schemaRetrieval"];
    if (typeof o.schemaTopK === "number") options.schemaTopK = o.schemaTopK;
    if (typeof o.evidenceGate === "string") options.evidenceGate = o.evidenceGate as RunOptions["evidenceGate"];
    if (Array.isArray(o.onlyChunks)) options.onlyChunks = (o.onlyChunks as unknown[]).filter((x): x is string => typeof x === "string");
    const ids = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : []);
    return {
      kind: b.kind === "induction" ? "induction" : "extraction",
      ...(b.baseRevisionId !== undefined
        ? { baseRevisionId: b.baseRevisionId === null ? null : requireString(b.baseRevisionId, "baseRevisionId", { max: 80 }) }
        : {}),
      sourceRunId: optionalString(b.sourceRunId, "sourceRunId", { max: 80 }),
      documentIds: ids(b.documentIds),
      mode: b.mode === "interactive" ? "interactive" : "automatic",
      provider: str(b.provider) ?? "",
      model: str(b.model) ?? "",
      vision: ids(b.vision),
      options,
    };
  };
  r.get("/api/projects/:pid/runs", async ({ svc, params }) => ({ runs: await runs.listRuns(svc, params.pid) }));
  r.post(
    "/api/projects/:pid/runs",
    async ({ svc, params, json: body }) => new StatusResponse(201, { run: await runs.createRun(svc, params.pid, runInput(await body())) }),
  );
  r.post("/api/projects/:pid/runs/estimate", async ({ svc, params, json: body }) => ({
    estimate: await runs.estimateRun(svc, params.pid, runInput(await body())),
  }));
  r.post("/api/projects/:pid/runs/:runId/proposals", async ({ svc, params, json: body }) => {
    const b = await body();
    return review.acceptProposals(
      svc,
      params.pid,
      params.runId,
      optionalStringArray(b.accept, "accept") ?? [],
      optionalStringArray(b.dismiss, "dismiss") ?? [],
    );
  });
  // the feedback loop: facts that waited for accepted terms become candidates on a new draft
  r.post("/api/projects/:pid/runs/:runId/replay", async ({ svc, params }) => review.replayRun(svc, params.pid, params.runId));
  r.get("/api/projects/:pid/runs/:runId", async ({ svc, params }) => ({ run: await runs.getRunView(svc, params.pid, params.runId) }));
  r.get("/api/projects/:pid/runs/:runId/research", async ({ svc, params }) => research.runResearch(svc, params.pid, params.runId));
  // One bounded step per request. Not tied to the client connection: a step
  // that has started is allowed to finish and checkpoint even if the tab closes.
  r.post("/api/projects/:pid/runs/:runId/advance", async ({ svc, params }) => runs.advanceRun(svc, params.pid, params.runId), {
    llm: true,
    unlimited: true,
    abortOnClose: false,
  });
  r.post("/api/projects/:pid/runs/:runId/pause", async ({ svc, params }) => ({ run: await runs.pauseRun(svc, params.pid, params.runId) }));
  r.post("/api/projects/:pid/runs/:runId/cancel", async ({ svc, params }) => ({
    run: await runs.cancelRun(svc, params.pid, params.runId),
  }));
  r.post("/api/projects/:pid/runs/:runId/retry", async ({ svc, params }) => ({ run: await runs.retryRun(svc, params.pid, params.runId) }));
  r.post("/api/projects/:pid/runs/:runId/answers", async ({ svc, params, json: body }) => {
    const b = await body();
    const answers = b.answers && typeof b.answers === "object" ? (b.answers as Record<string, string>) : {};
    return { run: await runs.answerQuestions(svc, params.pid, params.runId, answers, b.finish === true) };
  });

  // assistant
  // GraphDB connection (server-configured; users only pick a repository)
  r.get("/api/graphdb", async () => ({ graphdb: await graphdbStatus() }));

  r.get("/api/projects/:pid/conversations", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    return { conversations: await svc.store.conversations.list(params.pid) };
  });
  r.get("/api/projects/:pid/conversations/:cid", async ({ svc, params }) => {
    const c = await svc.store.conversations.get(params.pid, params.cid).catch(() => null);
    if (!c) throw new HttpError(404, "Conversation not found.");
    return { conversation: c };
  });
  r.delete("/api/projects/:pid/conversations/:cid", async ({ svc, params }) => {
    await projects.requireProject(svc, params.pid);
    await svc.store.conversations.delete(params.pid, params.cid);
    return { ok: true };
  });
  r.post(
    "/api/projects/:pid/assistant/ask",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return assistant.ask(
        svc,
        params.pid,
        {
          question: requireString(b.question, "question", { max: 4000 }),
          conversationId: str(b.conversationId),
          revisionId: str(b.revisionId),
          provider: str(b.provider),
          model: str(b.model),
          route: (["single", "multi", "aggregate"] as const).find((x) => x === b.route) as AnswerRoute | undefined,
        },
        signal,
      );
    },
    { llm: true },
  );
  r.get("/api/projects/:pid/assistant/suggestions", async ({ svc, params, query }) => ({
    suggestions: await graphChat.suggestions(
      svc,
      params.pid,
      query.get("source") === "external" ? "external" : query.get("source") === "graphdb" ? "graphdb" : "project",
      query.get("rev") || undefined,
    ),
  }));
  r.post("/api/projects/:pid/revisions/:rid/evidence/search", async ({ svc, params, json: body }) => {
    const b = await body();
    return searchSavedEvidence(svc, params.pid, params.rid, requireString(b.query, "query", { max: 2000 }));
  });
  r.get("/api/projects/:pid/revisions/:rid/evidence/passages/:key", async ({ svc, params }) =>
    savedPassageContext(svc, params.pid, params.rid, params.key),
  );
  r.post("/api/projects/:pid/conversations/:cid/messages/:mid/citation-issues", async ({ svc, params, json: body }) => {
    const b = await body();
    return graphChat.reportCitationIssue(
      svc,
      params.pid,
      params.cid,
      params.mid,
      requireString(b.key, "key", { max: 100 }),
      requireString(b.reason, "reason", { max: 40 }),
    );
  });
  // Ask as graph chat: server-sent events, one per agent step, then "saved".
  r.post(
    "/api/projects/:pid/assistant/chat",
    async ({ svc, params, json: body }) => {
      const b = await body();
      const input: graphChat.ChatInput = {
        passageKey: optionalString(b.passageKey, "passageKey", { max: 80 }),
        question: requireString(b.question, "question", { max: 4000 }),
        conversationId: str(b.conversationId),
        revisionId: str(b.revisionId),
        provider: str(b.provider),
        model: str(b.model),
        source: b.source === "external" ? "external" : b.source === "graphdb" ? "graphdb" : "project",
      };
      return new StreamResponse(await graphChat.prepareChat(svc, params.pid, input));
    },
    { llm: true },
  );
  r.post(
    "/api/projects/:pid/assistant/propose",
    async ({ svc, params, json: body, signal }) => {
      const b = await body();
      return assistant.propose(
        svc,
        params.pid,
        {
          instruction: requireString(b.instruction, "instruction", { max: 10_000 }),
          conversationId: str(b.conversationId),
          revisionId: str(b.revisionId),
          provider: str(b.provider),
          model: str(b.model),
        },
        signal,
      );
    },
    { llm: true },
  );

  return r;
}

/* ───────────────────────── app ───────────────────────── */

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function clientConfig(workerEnabled: boolean): ClientConfig {
  return {
    auth: { mode: "local" },
    limits: {
      maxFileBytes: MAX_UPLOAD_BYTES,
      maxDocumentsPerProject: MAX_DOCUMENTS_PER_PROJECT,
      maxSourcesPerCorpus: MAX_SOURCES_PER_CORPUS,
      storageQuotaBytes: STORAGE_QUOTA_BYTES,
      maxGraphNodes: MAX_GRAPH_NODES,
    },
    features: {
      worker: workerEnabled,
      docling: !!PARSER_URL,
      embeddings: EMBEDDINGS_BACKEND,
      nli: NLI_BACKEND,
      grounding: availableSources(["wikidata", "geonames", "umls"]),
      reuse: REUSE_SOURCES,
      graphdb: graphdbConfigured(),
      reasoner: effectiveTier(),
    },
  };
}

function errorStatus(e: unknown, aborted: boolean): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof NotFoundError) return { status: 404, message: e.message };
  if (e instanceof ConflictError) return { status: 409, message: e.message };
  if (aborted) return { status: 499, message: "cancelled" };
  if (e instanceof TruncatedOutputError) return { status: 502, message: e.message };
  if (e instanceof ProviderError)
    return { status: e.status === 499 ? 499 : e.status >= 400 && e.status < 600 ? e.status : 502, message: e.message };
  return { status: 500, message: "Something went wrong on the server." };
}

export function createApp(deps: AppDeps): http.RequestListener {
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? (() => new Date());
  const dist = deps.distDir ?? defaultDist();
  const docs = deps.docsDir ?? join(dist, "docs");
  const basePath = deps.basePath ?? BASE_PATH;
  const router = buildRouter();

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      send(res, 400, "Invalid request path", "text/plain");
      return;
    }
    const target = relative || "index.html";
    const filePath = resolve(dist, target);
    if (filePath !== dist && !filePath.startsWith(dist + sep)) {
      send(res, 403, "Forbidden", "text/plain");
      return;
    }
    try {
      const info = await stat(filePath);
      if (info.isFile()) {
        const data = await readFile(filePath);
        const cache = /\/assets\//.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache";
        send(res, 200, data, MIME[extname(filePath)] || "application/octet-stream", { "cache-control": cache });
        return;
      }
    } catch {
      // fall through
    }
    // A missing file with an extension is a genuine 404; extension-less paths
    // are client routes (/p/<id>/documents …) and get the SPA shell.
    if (extname(filePath)) {
      send(res, 404, "Not found", "text/plain");
      return;
    }
    try {
      const data = await readFile(join(dist, "index.html"));
      send(res, 200, data, MIME[".html"], { "cache-control": "no-cache" });
    } catch {
      send(res, 404, "Build not found. Run `npm run build` first (dev uses Vite on :5173).", "text/plain");
    }
  }

  async function handleLegacy(
    pathname: string,
    route: (typeof legacyRoutes)[string],
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    let status = 200;
    let provider: string | undefined;
    let model: string | undefined;
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
    let errorMessage: string | undefined;
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on("aborted", onClose);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const authed = await deps.auth.authenticate(req);
      if (!authed) throw new HttpError(401, "Sign in to use OntoLab.");
      const body = await readJsonBody<Record<string, unknown>>(req);
      provider = typeof body.provider === "string" ? body.provider : undefined;
      model = typeof body.model === "string" ? body.model : undefined;
      const result = route.llm
        ? await withSlot(() => route.handler(body, { signal: controller.signal }))
        : await route.handler(body, { signal: controller.signal });
      usage = (result as { usage?: typeof usage }).usage;
      if (!res.writableEnded) json(res, result);
    } catch (e) {
      const mapped = errorStatus(e, controller.signal.aborted);
      status = mapped.status;
      errorMessage = mapped.message;
      if (status === 500) console.error(`[${pathname}]`, e);
      if (!res.writableEnded && status !== 499) json(res, { error: errorMessage }, status);
      else if (!res.writableEnded) res.destroy();
    } finally {
      req.off("aborted", onClose);
      logCall({
        endpoint: pathname,
        provider,
        model,
        status,
        ms: Date.now() - started,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheReadTokens: usage?.cache_read_input_tokens,
        error: errorMessage,
      });
    }
  }

  async function handleProjectApi(
    method: string,
    pathname: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    const supplied = headerString(req, "x-request-id");
    const requestId = supplied && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID().replace(/-/g, "").slice(0, 16);
    res.setHeader("x-request-id", requestId);
    const match = router.match(method, pathname);
    if (match === null) return json(res, { error: "Not found" }, 404);
    if (match === "method") return json(res, { error: "Method not allowed" }, 405);

    const controller = new AbortController();
    if (match.opts.abortOnClose !== false) {
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
    }
    let status = 200;
    let userId: string | undefined;
    try {
      const authed = await deps.auth.authenticate(req);
      if (!authed) throw new HttpError(401, "Your session has expired — sign in again.");
      userId = authed.user.id;
      if (match.opts.llm && !match.opts.unlimited) {
        const retryAfter = rateLimit(clientKey(req));
        if (retryAfter != null) {
          res.setHeader("retry-after", String(retryAfter));
          throw new HttpError(429, `Too many requests — wait ${retryAfter}s and try again.`);
        }
      }
      const svc: ServiceCtx = { store: deps.store.forUser(authed.user, authed.accessToken), user: authed.user, now, log, requestId };
      const ctx: RouteCtx = {
        req,
        params: match.params,
        query: url.searchParams,
        svc,
        signal: deps.shutdownSignal ? AbortSignal.any([controller.signal, deps.shutdownSignal]) : controller.signal,
        json: <T>() => readJsonBody<T>(req),
        raw: (max: number) => readRawBody(req, max),
      };
      const run = () => match.handler(ctx);
      const result = match.opts.llm ? await withSlot(run) : await run();
      if (res.writableEnded) return;
      if (result instanceof StreamResponse) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const emit = (event: unknown) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
          const stream = () => result.run(emit, ctx.signal);
          await (match.opts.llm ? withSlot(stream) : stream());
        } catch (e) {
          const mapped = errorStatus(e, controller.signal.aborted);
          status = mapped.status;
          if (status === 500) console.error(`[${requestId}] ${method} ${match.pattern}`, e);
          if (status !== 499) emit({ type: "error", message: mapped.message });
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }
      if (result instanceof FileResponse) {
        const disposition = result.filename ? `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}` : "attachment";
        send(res, 200, result.body, result.contentType, {
          "cache-control": "private, no-store",
          "content-disposition": disposition,
          // Original uploads and imported metadata are untrusted, including HTML/XML/SVG.
          "content-security-policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        });
      } else if (result instanceof StatusResponse) {
        status = result.status;
        json(res, result.body, result.status, { "cache-control": "no-store" });
      } else {
        json(res, result, 200, { "cache-control": "no-store" });
      }
    } catch (e) {
      const mapped = errorStatus(e, controller.signal.aborted);
      status = mapped.status;
      if (status === 500) console.error(`[${requestId}] ${method} ${match.pattern}`, e);
      if (!res.writableEnded && status !== 499) json(res, { error: mapped.message, requestId }, status);
      else if (!res.writableEnded) res.destroy();
    } finally {
      log.info("http", {
        requestId,
        method,
        route: match.pattern,
        status,
        ms: Date.now() - started,
        user: userId ? userId.slice(0, 8) : undefined,
        projectId: match.params.pid,
        runId: match.params.runId,
      });
    }
  }

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      send(res, 400, "Bad request", "text/plain");
      return;
    }
    let pathname = url.pathname;
    if (basePath && (pathname === basePath || pathname.startsWith(basePath + "/"))) {
      pathname = pathname.slice(basePath.length) || "/";
    }
    const method = req.method ?? "GET";

    if (pathname === "/api/health") return json(res, { ok: true });

    if (pathname.startsWith("/api/")) {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      if (pathname === "/api/config") return json(res, clientConfig(!!deps.workerEnabled));
      if (pathname === "/api/providers") {
        if (method !== "GET") return json(res, { error: "Method not allowed" }, 405);
        return json(res, {
          providers: listProviders({
            includeLocalCli: localCliEnabled() && isLocalCliConnection(req.headers.host, req.socket.remoteAddress),
          }),
        });
      }
      const legacy = legacyRoutes[pathname];
      if (legacy) {
        if (method !== "POST") return json(res, { error: "Method not allowed" }, 405);
        if (legacy.llm) {
          const retryAfter = rateLimit(clientKey(req));
          if (retryAfter != null)
            return json(res, { error: `Too many requests — wait ${retryAfter}s and try again.` }, 429, {
              "retry-after": String(retryAfter),
            });
        }
        void handleLegacy(pathname, legacy, req, res);
        return;
      }
      void handleProjectApi(method, pathname, url, req, res);
      return;
    }

    if (method !== "GET" && method !== "HEAD") return json(res, { error: "Method not allowed" }, 405);
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      void serveDocumentation(req, res, docs, pathname, basePath, url.search);
      return;
    }
    void serveStatic(pathname, res);
  };
}
