import { hasCitation } from "../../src/lib/answerCitations.ts";
import type { AnswerPassage } from "../../src/types/sourceEvidence.ts";
import { savedSources, rankSaved, passageCitation } from "./sourceRetrieval.ts";
import { GRAPHDB_AUTH, GRAPHDB_URL } from "../config.ts";
import { externalBackend } from "../connections/backend.ts";
import { requireConnection } from "../connections/service.ts";
// Ask mode as graph chat: an agent that answers from the project graph (or a
// GraphDB repository the project publishes to) by running SPARQL and searching
// the documents, streaming each step, and storing the queries, trace and
// evidence graph with the answer. Also publishing a revision to GraphDB.

import { Parser } from "n3";
import type { ChatEvent, GraphSource, SparqlRun } from "../../src/types/graphChat.ts";
import type {
  Citation,
  Conversation,
  ConversationMessage,
  GraphDbSettings,
  Project,
  RevisionWithContent,
} from "../../src/types/project.ts";
import { HttpError } from "../http.ts";
import { resolveModel, type ChatMessage, type ProviderId } from "../providers.ts";
import { projectBackend, type GraphBackend } from "../graphchat/backend.ts";
import { checkRepository, graphdbConfigured, publishTurtle } from "../graphchat/graphdb.ts";
import { runTurn, type Passage } from "../graphchat/turn.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject } from "./projects.ts";
import { currentRevision, requireRevision } from "./revisions.ts";
import { reviewPolicyOf, tboxOf } from "./ontology.ts";
import { chunkHeader, hybridPassages, loadConversation } from "./assistant.ts";
import { embedderFor } from "./runs.ts";
import { exportTurtle } from "./archive.ts";

/** Rows of each query kept with a stored answer (the full count is kept too). */
const STORED_ROWS = 50;

/** Uses the module's implementation rather than a mutable imported test spy. */
export const graphAnswerImplementation = () => executeGraphAnswer.toString();

export interface ChatInput {
  passageKey?: string;
  question: string;
  conversationId?: string;
  revisionId?: string;
  provider?: string;
  model?: string;
  source?: GraphSource;
}

async function backendFor(
  ctx: ServiceCtx,
  projectId: string,
  project: Project,
  source: GraphSource | undefined,
  revisionId: string | undefined,
): Promise<{ backend: GraphBackend; revisionId: string | null }> {
  if (project.settings.externalGraph) {
    const binding = project.settings.externalGraph;
    return { backend: externalBackend(ctx, await requireConnection(ctx, binding.connectionId), binding), revisionId: null };
  }
  if (source === "external") throw new HttpError(400, "Connect an external graph to use this source.");
  if (source === "graphdb") {
    if (!graphdbConfigured())
      throw new HttpError(400, "A local legacy GraphDB connection is not configured. Add a graph connection in Account & workspace.");
    const repo = checkRepository(project.settings.graphdb?.repository);
    const scope = project.settings.graphdb?.published?.graph || project.settings.graphdb?.graph || defaultGraphName(projectId);
    const colon = GRAPHDB_AUTH.indexOf(":");
    const backend = externalBackend(
      ctx,
      {
        id: "legacy-graphdb",
        name: `GraphDB · ${repo}`,
        provider: "graphdb",
        queryEndpoint: `${GRAPHDB_URL}/repositories/${encodeURIComponent(repo)}`,
        authType: GRAPHDB_AUTH ? "basic" : "none",
        hasCredentials: !!GRAPHDB_AUTH,
        version: 0,
        createdAt: "",
        updatedAt: "",
      },
      { connectionId: "legacy-graphdb", graph: scope },
      GRAPHDB_AUTH ? { type: "basic", username: GRAPHDB_AUTH.slice(0, colon), password: GRAPHDB_AUTH.slice(colon + 1) } : { type: "none" },
    );
    backend.source = "graphdb";
    return { backend, revisionId: null };
  }
  const rev = revisionId ? await requireRevision(ctx, projectId, revisionId) : await currentRevision(ctx, projectId);
  if (!rev) throw new HttpError(409, "Commit an ontology revision before asking about it.");
  if (rev.content.corpus && rev.status !== "committed")
    throw new HttpError(409, "Save this graph version before asking about its sources.");
  return { backend: projectBackend(rev, tboxOf(rev.content), reviewPolicyOf(project)), revisionId: rev.id };
}

/** Starter questions for an empty conversation, from the graph's schema. */
export async function suggestions(
  ctx: ServiceCtx,
  projectId: string,
  source: GraphSource | undefined,
  revisionId: string | undefined,
): Promise<string[]> {
  const project = await requireProject(ctx, projectId);
  const { backend } = await backendFor(ctx, projectId, project, source, revisionId);
  return (await backend.digest()).suggestions;
}

export const defaultGraphName = (projectId: string) => `urn:ontolab:project:${projectId}`;

/**
 * Checks everything that can be refused (access, model, source, revision)
 * before the event stream opens, so those fail with a proper HTTP status; the
 * returned function runs the turn.
 */
export async function prepareChat(
  ctx: ServiceCtx,
  projectId: string,
  input: ChatInput,
): Promise<(emit: (e: ChatEvent) => void, signal: AbortSignal) => Promise<void>> {
  const question = input.question?.trim();
  if (!question) throw new HttpError(400, "question is required");
  const project = await requireProject(ctx, projectId);
  // Tool calling is required, so chat-only models are refused here.
  const { provider, model } = resolveModel(input.provider, input.model, { structured: true });

  const existing = input.conversationId ? await loadConversation(ctx, projectId, input.conversationId, question, null) : null;
  const requested = input.revisionId ?? existing?.revisionId ?? undefined;
  const { backend, revisionId } = await backendFor(ctx, projectId, project, input.source, requested);
  if (existing && (existing.revisionId !== revisionId || existing.messages.some((m) => m.agent && m.agent.source !== backend.source)))
    throw new HttpError(409, "This conversation belongs to a different graph version. Start a new conversation to ask in this version.");

  const conversation: Conversation = await loadConversation(ctx, projectId, input.conversationId, question, revisionId);
  const prior = [...conversation.messages].reverse().find((m) => m.agent)?.agent?.context;
  if (
    backend.sourceContext &&
    prior &&
    (prior.connectionId !== backend.sourceContext.connectionId ||
      prior.connectionVersion !== backend.sourceContext.connectionVersion ||
      prior.graph !== backend.sourceContext.graph)
  )
    throw new HttpError(
      409,
      "This conversation used a different connection or graph scope. Start a new conversation to query the current source.",
    );
  const revision = revisionId ? await requireRevision(ctx, projectId, revisionId) : null;
  const savedScope = backend.source === "project" && revision?.content.corpus ? await savedSources(ctx, projectId, revision.id) : null;
  if (input.passageKey && !savedScope?.passages.some((p) => p.key === input.passageKey))
    throw new HttpError(404, "The selected passage is not available in this graph version.");
  return (emit, signal) => {
    backend.signal = signal;
    return answer(
      ctx,
      projectId,
      project,
      conversation,
      backend,
      savedScope,
      { provider, model, question, passageKey: input.passageKey },
      emit,
      signal,
    );
  };
}

/** Shared current Ask engine. Conversation persistence belongs to the HTTP
 * adapter; evaluations pass their immutable graph and settings snapshots. */
export async function executeGraphAnswer(
  ctx: ServiceCtx,
  input: {
    project: Project;
    graphRevision: RevisionWithContent | null;
    backend: GraphBackend;
    provider: ProviderId;
    model: string;
    question: string;
    history?: ChatMessage[];
    graphOnly?: boolean;
    passageKey?: string;
    savedScope?: Awaited<ReturnType<typeof savedSources>> | null;
    /** HTTP Ask saves partial turns; evaluation failures must still reject for retry. */
    retainPartial?: boolean;
  },
  emit: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<ConversationMessage> {
  const { project, graphRevision, backend, provider, model, question, graphOnly, passageKey } = input;
  const projectId = project.id;
  const history = input.history ?? [];
  backend.signal = signal;
  const saved =
    !graphOnly && backend.source === "project" && graphRevision?.content.corpus
      ? (input.savedScope ?? (await savedSources(ctx, projectId, graphRevision.id)))
      : null;
  if (saved) emit({ type: "source_context", coverage: saved.coverage });
  const docs = !graphOnly && backend.source === "project" && !saved ? await ctx.store.documents.list(projectId) : [];
  const names = new Map(docs.map((d) => [d.id, d.name]));
  const embedder = embedderFor(project);
  const searchDocuments = saved
    ? saved.coverage.available > 0
      ? async (query: string, limit: number): Promise<Passage[]> => rankSaved(saved.passages, query, limit)
      : undefined
    : docs.length
      ? async (query: string, limit: number): Promise<Passage[]> =>
          (await hybridPassages(ctx, projectId, query, embedder, limit)).map((chunk) => ({
            chunk,
            title: names.get(chunk.documentId),
            where: chunkHeader(chunk, names),
          }))
      : undefined;
  if (saved && saved.coverage.available < saved.coverage.total)
    emit({
      type: "status",
      text: `Source coverage incomplete: ${saved.coverage.available} of ${saved.coverage.total} saved documents available`,
    });

  const selected = passageKey ? saved?.passages.find((p) => p.key === passageKey) : undefined;
  if (passageKey && !selected) throw new HttpError(404, "The selected passage is not available in this graph version.");
  const started = Date.now();
  let completion: "complete" | "interrupted" | "failed" = "complete";
  let failure: string | undefined;
  const partial: Awaited<ReturnType<typeof runTurn>> = {
    text: "",
    runs: [],
    tools: [],
    trace: [],
    passages: new Map(),
    model,
    usage: { input: 0, output: 0 },
    durationMs: 0,
  };
  const capturedPassages = new Map<string, AnswerPassage>();
  const capture = (event: ChatEvent) => {
    if (event.type === "passage") capturedPassages.set(event.passage.ref, event.passage);
    if (event.type === "text") partial.text += event.text;
    if (event.type === "round_end" && event.hadTools) partial.text = "";
    if (event.type === "sparql") partial.runs.push(event.run);
    if (event.type === "tool_call") partial.tools.push(event.call);
    if (event.type === "evidence") partial.evidence = event.graph;
    emit(event);
  };
  let result: Awaited<ReturnType<typeof runTurn>>;
  try {
    result = await runTurn({
      reviewSourceSemantics: true,
      backend,
      provider,
      model,
      history,
      message: question,
      emit: capture,
      signal,
      searchDocuments,
      sourceNotice: saved
        ? `${saved.coverage.available} of ${saved.coverage.total} saved documents available. Keyword retrieval over retained snapshots, not a persistent search index. ${saved.coverage.available === 0 ? "Source search is unavailable. If asked to verify source information, begin by saying you cannot verify it because the saved documents are unavailable. Do not query the graph just to restate this limitation; query it only if the user also needs graph facts." : ""} ${saved.coverage.unavailable.length ? "Coverage is incomplete: explicitly disclose this limitation; no hits do not establish absence from the missing documents." : "Ranked search does not establish completeness or absence."}`
        : undefined,
      initialPassages: selected ? [selected] : undefined,
    });
    if (signal.aborted) completion = "interrupted";
  } catch (error) {
    if (!input.retainPartial) throw error;
    completion = signal.aborted ? "interrupted" : "failed";
    failure = completion === "failed" ? (error instanceof Error ? error.message : "The answer could not finish.") : undefined;
    result = { ...partial, durationMs: Date.now() - started };
    if (failure) emit({ type: "error", message: failure });
  }

  // [C2] in the answer links to the passage the model was shown.
  const allPassages =
    completion === "complete" ? [...result.passages].map(([ref, p]) => passageCitation(p, ref)) : [...capturedPassages.values()];
  const citations: Citation[] = allPassages
    .filter((p) => hasCitation(result.text, p.ref))
    .map((p) => ({ ref: p.ref, evidence: p.evidence }));
  const entities = [...new Set((result.evidence?.nodes ?? []).flatMap((n) => (n.individualId ? [n.individualId] : [])))];
  const store = (r: SparqlRun): SparqlRun => ({ ...r, rows: r.rows.slice(0, STORED_ROWS) });

  const now = iso(ctx.now());
  const message: ConversationMessage = {
    id: newId("msg"),
    role: "assistant",
    mode: "ask",
    content: result.text || (completion === "interrupted" ? "Stopped before an answer was produced." : "I could not produce an answer."),
    ...(citations.length ? { citations } : {}),
    ...(entities.length ? { entities } : {}),
    agent: {
      completion,
      sourceCheck: result.sourceCheck,
      semanticCheck: result.semanticCheck,
      error: failure,
      passages: allPassages,
      sourceCoverage: saved?.coverage,
      revisionId: graphRevision?.id,
      source: backend.source,
      sourceLabel: backend.label,
      context: backend.sourceContext,
      ...(backend.workbenchUrl ? { workbenchUrl: backend.workbenchUrl } : {}),
      runs: result.runs.map(store),
      tools: result.tools.map((t) => ({ ...t, preview: t.preview?.slice(0, 600) })),
      trace: result.trace,
      ...(result.evidence ? { evidence: result.evidence } : {}),
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    },
    createdAt: now,
  };
  return message;
}

async function answer(
  ctx: ServiceCtx,
  projectId: string,
  project: Project,
  conversation: Conversation,
  backend: GraphBackend,
  savedScope: Awaited<ReturnType<typeof savedSources>> | null,
  config: { provider: ProviderId; model: string; question: string; passageKey?: string },
  emit: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const graphRevision = conversation.revisionId
    ? await ctx.store.revisions.get(projectId, conversation.revisionId)
    : project.currentRevisionId
      ? await ctx.store.revisions.get(projectId, project.currentRevisionId)
      : null;
  const message = await executeGraphAnswer(
    ctx,
    {
      project,
      graphRevision,
      backend,
      ...config,
      savedScope,
      retainPartial: true,
      history: conversation.messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    },
    emit,
    signal,
  );
  const now = message.createdAt;
  const userMsg: ConversationMessage = { id: newId("msg"), role: "user", mode: "ask", content: config.question, createdAt: now };
  conversation.messages.push(userMsg, message);
  conversation.updatedAt = now;
  await ctx.store.conversations.put(conversation);
  emit({ type: "saved", conversationId: conversation.id, messageId: message.id });
  ctx.log.info("assistant.chat", {
    requestId: ctx.requestId,
    projectId,
    source: backend.source,
    queries: message.agent?.runs.filter((r) => r.purpose === "agent").length,
    ms: message.agent?.durationMs,
    inputTokens: message.agent?.usage?.input,
    outputTokens: message.agent?.usage?.output,
  });
}

/** Write a revision (T-Box and A-Box) into the project's GraphDB repository, creating an immutable publication graph. */
export async function publishToGraphDb(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  input: { repository?: string; graph?: string; acknowledged?: boolean },
): Promise<GraphDbSettings> {
  if (!graphdbConfigured())
    throw new HttpError(400, "A local legacy GraphDB connection is not configured. Add a graph connection in Account & workspace.");
  const project = await requireProject(ctx, projectId);
  const rev = await requireRevision(ctx, projectId, revisionId);
  const repository = checkRepository(input.repository || project.settings.graphdb?.repository);
  if (rev.status !== "committed") throw new HttpError(409, "Save this version before publishing.");
  const baseGraph = (input.graph ?? project.settings.graphdb?.graph ?? "").trim() || defaultGraphName(projectId);
  const graph = `${baseGraph}:publication:${newId("pub")}`;
  if (!/^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(graph)) throw new HttpError(400, "The named graph must be an absolute IRI.");
  const { turtle } = await exportTurtle(ctx, projectId, revisionId, "combined", !!input.acknowledged);
  await publishTurtle(repository, graph, turtle);
  let triples = 0;
  try {
    triples = new Parser().parse(turtle).length;
  } catch {
    /* GraphDB accepted it; the count is informational */
  }
  const settings: GraphDbSettings = {
    ...project.settings.graphdb,
    repository,
    ...(input.graph !== undefined ? { graph: input.graph.trim() } : {}),
    published: { revisionId: rev.id, revisionNumber: rev.number ?? 0, at: iso(ctx.now()), triples, graph },
  };
  await ctx.store.projects.update(projectId, { settings: { ...project.settings, graphdb: settings }, updatedAt: iso(ctx.now()) });
  ctx.log.info("graphdb.published", { requestId: ctx.requestId, projectId, revisionId, repository });
  return settings;
}

/** User feedback is stored independently from the immutable answer and its evidence. */
export async function reportCitationIssue(ctx: ServiceCtx, pid: string, cid: string, mid: string, key: string, reason: string) {
  await requireProject(ctx, pid);
  const conversation = await ctx.store.conversations.get(pid, cid);
  const message = conversation?.messages.find((m) => m.id === mid && m.role === "assistant");
  const passage = message?.agent?.passages?.find((p) => p.key === key && hasCitation(message.content, p.ref));
  if (!passage) throw new HttpError(404, "Cited passage not found in this answer.");
  if (!["unsupported", "location", "context"].includes(reason)) throw new HttpError(400, "Choose a citation issue.");
  const path = `${pid}/citation-feedback/${mid}/${passage.key}-${reason}.json`;
  if (!(await ctx.store.blobs.get(path)))
    await ctx.store.blobs.put(
      path,
      Buffer.from(
        JSON.stringify({
          conversationId: cid,
          messageId: mid,
          passageKey: passage.key,
          reason,
          at: iso(ctx.now()),
        }),
      ),
      "application/json",
    );
  return { recorded: true };
}
