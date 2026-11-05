import { createHash, randomUUID } from "node:crypto";
import type {
  Evaluation,
  EvaluationAttempt,
  EvaluationCapture,
  EvaluationJudgment,
  EvaluationQuestion,
  EvaluationScope,
  EvaluationSetup,
  EvaluationSource,
  AnswerGrade,
} from "../../src/types/evaluation.ts";
import { activeEvaluationStates } from "../../src/types/evaluation.ts";
import type { EvidenceRef, Project, RevisionWithContent } from "../../src/types/project.ts";
import type { ResearchInputs } from "../../src/types/research.ts";
import type { StoredDocumentText } from "../store/types.ts";
import { ConflictError } from "../store/types.ts";
import { HttpError } from "../http.ts";
import { resolveModel } from "../providers.ts";
import { MAX_TOOL_ROUNDS } from "../config.ts";
import { projectBackend, projectGraphImplementation } from "../graphchat/backend.ts";
import { graphLoopImplementation } from "../graphchat/loop.ts";
import { runTurn, systemPrompt } from "../graphchat/turn.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject } from "./projects.ts";
import { requireRevision } from "./revisions.ts";
import { graphAbox, reviewPolicyOf, tboxOf } from "./ontology.ts";
import { executeGraphAnswer, graphAnswerImplementation } from "./graphChat.ts";
import { scoreEvaluation } from "../../src/lib/evaluation.ts";
import { costUsd, priceOf } from "./pricing.ts";
import { projectSpend } from "./runs.ts";

const MAX_QUESTIONS = 20;
const LEASE_MS = 90_000;
const MAX_SOURCES = 30;
const MAX_ATTEMPTS = 20;
const controllers = new Map<string, AbortController>();
interface Inputs {
  project: Project;
  baseline: RevisionWithContent;
  candidate: RevisionWithContent;
  sourcePins: Record<string, string | null>;
}
interface SourceSnapshot extends StoredDocumentText {
  name: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const evaluationHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const engineFingerprint = () =>
  evaluationHash([
    "graph-chat-v1",
    MAX_TOOL_ROUNDS,
    runTurn.toString(),
    systemPrompt.toString(),
    graphAnswerImplementation(),
    graphLoopImplementation(),
    projectGraphImplementation(),
  ]);
const inputPath = (pid: string, id: string, hash?: string) => `${pid}/evaluations/${id}/${hash ?? "inputs"}.json`;
const sourcePath = (pid: string, id: string, hash: string) => `${pid}/evaluations/${id}/sources/${hash}.json`;
const latest = (e: Evaluation) => e.attempts.at(-1);
const key = (ctx: ServiceCtx, pid: string, id: string) => `${ctx.user.id}/${pid}/${id}`;
const now = (ctx: ServiceCtx) => iso(ctx.now());

function text(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max)
    throw new HttpError(400, `${name} must contain ${min}–${max} characters.`);
  return value.trim();
}
function native(project: Project) {
  if (project.settings.externalGraph)
    throw new HttpError(409, "Connected graphs need immutable snapshots before they can be compared. Select a native knowledge graph.");
}
function scope(revision: RevisionWithContent, project: Project): EvaluationScope {
  return {
    revisionId: revision.id,
    number: revision.number!,
    summary: revision.summary,
    contentHash: revision.contentHash,
    snapshotHash: evaluationHash(revision),
    reviewPolicy: revision.content.corpus ? "accepted-only" : reviewPolicyOf(project),
    sources: (revision.content.corpus?.sources ?? []).map((s) => ({ documentId: s.documentId, runId: s.runId, checksum: s.checksum })),
  };
}

export async function evaluationSetup(ctx: ServiceCtx, pid: string): Promise<EvaluationSetup> {
  const project = await requireProject(ctx, pid);
  const revisions = (await ctx.store.revisions.list(pid))
    .filter((r) => r.status === "committed" && r.number != null)
    .sort((a, b) => b.number! - a.number!);
  const parent = project.settings.corpus ? await requireProject(ctx, project.settings.corpus.parentProjectId) : project;
  const questions = (parent.settings.requirements?.cqs ?? [])
    .filter((q) => q.status === "approved")
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({ id: q.id, text: q.text, expectation: "", origin: "competency" as const }));
  return {
    revisions: revisions.map(({ id, number, summary, contentHash }) => ({ id, number: number!, summary, contentHash })),
    questions,
    eligible: !project.settings.externalGraph && revisions.length >= 2,
    reason: project.settings.externalGraph
      ? "Connected graphs need immutable snapshots before comparison."
      : revisions.length < 2
        ? "Save at least two graph versions to compare their answers."
        : undefined,
    maxQuestions: MAX_QUESTIONS,
  };
}

export async function requireEvaluation(ctx: ServiceCtx, pid: string, id: string): Promise<Evaluation> {
  await requireProject(ctx, pid);
  const item = await ctx.store.evaluations.get(pid, id);
  if (!item) throw new HttpError(404, "Evaluation not found.");
  return item;
}

/** Serialize transitions using the adapter's compare-and-swap, including races
 * between HTTP controls, review saves, worker heartbeats and capture completion. */
async function change(ctx: ServiceCtx, pid: string, id: string, apply: (e: Evaluation) => void): Promise<Evaluation> {
  for (let i = 0; i < 12; i++) {
    const item = await requireEvaluation(ctx, pid, id);
    apply(item);
    const version = item.version;
    item.version++;
    item.updatedAt = now(ctx);
    try {
      await ctx.store.evaluations.put(item, version);
      return item;
    } catch (error) {
      if (!(error instanceof ConflictError) || i === 11) throw error;
    }
  }
  throw new ConflictError("Evaluation is busy. Try again.");
}

async function prepareEvaluation(ctx: ServiceCtx, pid: string, body: Record<string, unknown>, id = newId("eval")) {
  const project = await requireProject(ctx, pid);
  native(project);
  const baseline = await requireRevision(ctx, pid, text(body.baselineRevisionId, "Baseline version", 80));
  const candidate = await requireRevision(ctx, pid, text(body.candidateRevisionId, "Candidate version", 80));
  if ([baseline, candidate].some((r) => r.status !== "committed" || r.number == null))
    throw new HttpError(409, "Comparisons require saved graph versions. Save drafts first.");
  if (baseline.id === candidate.id) throw new HttpError(400, "Select two different graph versions.");
  const { provider, model } = resolveModel(text(body.provider, "Provider", 80), text(body.model, "Model", 200), { structured: true });
  if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > MAX_QUESTIONS)
    throw new HttpError(400, `Choose 1–${MAX_QUESTIONS} questions.`);
  const seen = new Set<string>();
  const questions: EvaluationQuestion[] = body.questions.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid question.");
    const q = raw as Record<string, unknown>;
    const question = text(q.text, "Question", 4000);
    if (seen.has(question.toLocaleLowerCase())) throw new HttpError(400, "Each question must be distinct.");
    seen.add(question.toLocaleLowerCase());
    return {
      id: newId("eq"),
      text: question,
      expectation: text(q.expectation, "Expected answer", 6000, 5),
      ...(q.baselineExpectation ? { baselineExpectation: text(q.baselineExpectation, "Baseline expectation", 6000, 5) } : {}),
      origin: q.origin === "competency" || q.origin === "ask" ? q.origin : "manual",
      ...(typeof q.competencyQuestionId === "string"
        ? { competencyQuestionId: text(q.competencyQuestionId, "Competency question", 80) }
        : {}),
    };
  });
  const item: Evaluation = {
    id,
    projectId: pid,
    ownerId: ctx.user.id,
    version: 1,
    title: text(body.title, "Evaluation name", 160),
    createdAt: now(ctx),
    updatedAt: now(ctx),
    state: "draft",
    baseline: scope(baseline, project),
    candidate: scope(candidate, project),
    questions,
    provider,
    model,
    engine: { id: "graph-chat-v1", fingerprint: engineFingerprint(), maxToolRounds: MAX_TOOL_ROUNDS, documentSearch: false },
    inputHash: "",
    recordedCostUsd: 0,
    attempts: [],
    judgments: [],
    reports: [],
  };
  const inputs: Inputs = { project, baseline, candidate, sourcePins: {} };
  const runs = new Map<string, Set<string>>();
  for (const revision of [baseline, candidate])
    for (const ref of references(revision, project, [])) {
      const runId = sourceRun(revision, ref);
      if (!runId || !ref.documentId) continue;
      if (!runs.has(runId)) runs.set(runId, new Set());
      runs.get(runId)!.add(ref.documentId);
    }
  for (const [runId, docs] of runs) {
    const bytes = await ctx.store.blobs.get(`${pid}/research/${runId}/inputs.json`);
    const source = bytes ? (JSON.parse(bytes.toString("utf8")) as ResearchInputs) : null;
    for (const documentId of docs) {
      const snapshot = source?.documentTexts?.[documentId];
      const name = source?.documents.find((d) => d.id === documentId)?.name ?? documentId;
      inputs.sourcePins[`${runId}/${documentId}`] = snapshot ? evaluationHash({ ...snapshot, name }) : null;
    }
  }
  item.inputHash = evaluationHash(inputs);
  const bytes = Buffer.from(JSON.stringify(inputs));
  if (bytes.length > 30 * 1024 * 1024)
    throw new HttpError(413, "This graph comparison exceeds the 30 MB snapshot limit. Use smaller saved graphs.");
  return { item, bytes };
}

export async function createEvaluation(ctx: ServiceCtx, pid: string, body: Record<string, unknown>): Promise<Evaluation> {
  const { item, bytes } = await prepareEvaluation(ctx, pid, body);
  const path = inputPath(pid, item.id, item.inputHash);
  await ctx.store.blobs.put(path, bytes, "application/json");
  try {
    await ctx.store.evaluations.put(item, null);
  } catch (error) {
    await ctx.store.blobs.delete(path);
    throw error;
  }
  return item;
}

/** Edits are allowed only before any execution, with an explicit stale-editor guard.
 * Content-addressed inputs keep a racing start bound to its original snapshots. */
export async function updateEvaluation(ctx: ServiceCtx, pid: string, id: string, body: Record<string, unknown>) {
  const previous = await requireEvaluation(ctx, pid, id);
  if (previous.state !== "draft" || previous.attempts.length)
    throw new HttpError(409, "This comparison has already run. Create an edited copy to change its setup.");
  if (body.version !== previous.version) throw new ConflictError("This setup changed. Reopen it before saving.");
  const { item, bytes } = await prepareEvaluation(ctx, pid, body, id);
  item.createdAt = previous.createdAt;
  item.version = previous.version + 1;
  await ctx.store.blobs.put(inputPath(pid, id, item.inputHash), bytes, "application/json");
  await ctx.store.evaluations.put(item, previous.version);
  return item;
}

async function readInputs(ctx: ServiceCtx, item: Evaluation): Promise<Inputs> {
  const bytes =
    (await ctx.store.blobs.get(inputPath(item.projectId, item.id, item.inputHash))) ??
    (await ctx.store.blobs.get(inputPath(item.projectId, item.id)));
  if (!bytes) throw new HttpError(410, "The comparison's saved graph snapshots are unavailable.");
  const inputs = JSON.parse(bytes.toString("utf8")) as Inputs;
  if (evaluationHash(inputs) !== item.inputHash) throw new HttpError(409, "Comparison input integrity check failed.");
  for (const arm of ["baseline", "candidate"] as const) {
    if (evaluationHash(inputs[arm]) !== item[arm].snapshotHash) throw new HttpError(409, "Saved graph snapshot integrity check failed.");
  }
  return inputs;
}

export async function startEvaluation(ctx: ServiceCtx, pid: string, id: string, body: Record<string, unknown>, retry = false) {
  const item = await requireEvaluation(ctx, pid, id);
  native(await requireProject(ctx, pid));
  if (item.provider !== "mock" && body.acknowledgedCost !== true)
    throw new HttpError(400, "Acknowledge model usage before starting this comparison.");
  if (engineFingerprint() !== item.engine.fingerprint)
    throw new HttpError(409, "The Ask implementation changed. Create a new comparison to capture the current engine.");
  resolveModel(item.provider, item.model, { structured: true });
  await readInputs(ctx, item);
  await enforceBudget(ctx, item, retry ? latest(item) : undefined);
  const attemptId = newId("ea");
  return change(ctx, pid, id, (e) => {
    if (e.version !== item.version) throw new ConflictError("The comparison changed. Refresh before starting it.");
    if (activeEvaluationStates.includes(e.state)) throw new HttpError(409, "This evaluation already has an active attempt.");
    if (e.attempts.length >= MAX_ATTEMPTS) throw new HttpError(409, "This comparison has 20 attempts. Create a new comparison.");
    const previous = latest(e);
    if (
      retry &&
      (!previous || (!["failed", "cancelled", "interrupted"].includes(previous.state) && !previous.captures.some((c) => c.error)))
    )
      throw new HttpError(409, "There are no failed or unfinished answers to retry.");
    const attempt: EvaluationAttempt = {
      id: attemptId,
      ...(retry ? { retryOf: previous!.id } : {}),
      state: "queued",
      createdAt: now(ctx),
      updatedAt: now(ctx),
      captures: retry ? previous!.captures.filter((c) => !c.error) : [],
      priorCostUsd: retry
        ? (previous!.priorCostUsd ?? 0) + previous!.captures.filter((c) => c.error).reduce((sum, c) => sum + (c.costUsd ?? 0), 0)
        : 0,
      lease: null,
      inFlight: null,
      usageUncertain: retry ? previous!.usageUncertain : false,
    };
    e.attempts.push(attempt);
    e.state = "queued";
  });
}

export async function cancelEvaluation(ctx: ServiceCtx, pid: string, id: string) {
  const result = await change(ctx, pid, id, (e) => {
    const a = latest(e);
    if (!a || !activeEvaluationStates.includes(a.state)) throw new HttpError(409, "There is no active attempt to cancel.");
    a.state = a.inFlight ? "cancelling" : "cancelled";
    a.updatedAt = now(ctx);
    if (!a.inFlight) {
      a.finishedAt = now(ctx);
      a.lease = null;
    }
    e.state = a.state;
  });
  controllers.get(key(ctx, pid, id))?.abort();
  return result;
}

function references(revision: RevisionWithContent, project: Project, entities: string[]): EvidenceRef[] {
  const abox = graphAbox(revision.content, reviewPolicyOf(project));
  const selected = entities.length ? abox.individuals.filter((i) => entities.includes(i.id)) : abox.individuals;
  return selected.flatMap((i) => [
    ...(i.evidence ?? []),
    ...(i.dataProperties ?? []).flatMap((p) => p.evidence ?? []),
    ...(i.objectProperties ?? []).flatMap((p) => p.evidence ?? []),
  ]);
}

function sourceRun(revision: RevisionWithContent, evidence: EvidenceRef): string | undefined {
  const pinned = revision.content.corpus?.sources.find((s) => s.documentId === evidence.documentId);
  if (pinned && evidence.runId && pinned.runId !== evidence.runId) return undefined;
  return pinned?.runId ?? evidence.runId ?? revision.runId;
}

/** Match extraction's existing spending semantics: stop between units of work.
 * Prices are estimates; an in-flight provider request can finish over a limit. */
async function enforceBudget(ctx: ServiceCtx, item: Evaluation, attempt?: EvaluationAttempt) {
  const project = await requireProject(ctx, item.projectId);
  const limits = project.settings.budget;
  if (!limits || (limits.maxUsdPerRun == null && limits.maxUsdTotal == null)) return;
  if (!priceOf(item.provider, item.model))
    throw new HttpError(
      409,
      "This model has no configured price, so project spending limits cannot be checked. Choose a priced model or configure its price.",
    );
  const spent = (attempt?.priorCostUsd ?? 0) + (attempt?.captures.reduce((sum, c) => sum + (c.costUsd ?? 0), 0) ?? 0);
  if (limits.maxUsdPerRun != null && spent >= limits.maxUsdPerRun)
    throw new HttpError(
      409,
      "The comparison reached the project's per-run spending limit. Adjust project spending limits before retrying.",
    );
  if (limits.maxUsdTotal != null && (await projectSpend(ctx, item.projectId)) >= limits.maxUsdTotal)
    throw new HttpError(409, "The project reached its total spending limit. Adjust project spending limits before retrying.");
}

async function captureSources(
  ctx: ServiceCtx,
  item: Evaluation,
  revision: RevisionWithContent,
  project: Project,
  entities: string[],
  pins: Inputs["sourcePins"],
) {
  const refs = references(revision, project, entities);
  const unique = [...new Map(refs.map((ref) => [evaluationHash(ref), ref])).values()];
  const sources: EvaluationSource[] = [];
  const inputs = new Map<string, ResearchInputs | null>();
  for (const evidence of unique.slice(0, MAX_SOURCES)) {
    const source: EvaluationSource = {
      id: newId("es"),
      name: evidence.documentId ?? "Source without a document",
      evidence,
      available: false,
    };
    const pinned = revision.content.corpus?.sources.find((s) => s.documentId === evidence.documentId);
    const runId = sourceRun(revision, evidence);
    if (!evidence.documentId || !runId || (pinned && evidence.runId && pinned.runId !== evidence.runId)) {
      source.issue = "No compatible retained extraction source was recorded for this reference.";
    } else {
      if (!inputs.has(runId)) {
        const bytes = await ctx.store.blobs.get(`${item.projectId}/research/${runId}/inputs.json`);
        inputs.set(runId, bytes ? (JSON.parse(bytes.toString("utf8")) as ResearchInputs) : null);
      }
      const input = inputs.get(runId);
      const document = input?.documents.find((d) => d.id === evidence.documentId);
      const snapshot = input?.documentTexts?.[evidence.documentId];
      source.name = document?.name ?? source.name;
      if (!snapshot || (pinned && document?.checksum !== pinned.checksum))
        source.issue = "The original extraction text is unavailable or its source identity changed.";
      else {
        const saved: SourceSnapshot = { ...snapshot, name: source.name };
        source.textHash = evaluationHash(saved);
        if (pins[`${runId}/${evidence.documentId}`] !== source.textHash) {
          source.issue = "Retained source text changed after comparison setup. It cannot be used as this graph version's evidence.";
          sources.push(source);
          continue;
        }
        source.evidence = { ...evidence, runId };
        source.available = true;
        await ctx.store.blobs.put(
          sourcePath(item.projectId, item.id, source.textHash),
          Buffer.from(JSON.stringify(saved)),
          "application/json",
        );
      }
    }
    sources.push(source);
  }
  return { sources, sourcesTruncated: unique.length > MAX_SOURCES };
}

/** One durable answer per advance. Expired in-flight calls are interrupted,
 * never silently replayed: the provider may already have billed the request. */
export async function advanceEvaluation(ctx: ServiceCtx, pid: string, id: string): Promise<Evaluation> {
  let item = await requireEvaluation(ctx, pid, id);
  if (!activeEvaluationStates.includes(item.state)) return item;
  const holder = randomUUID();
  let acquired = false;
  item = await change(ctx, pid, id, (e) => {
    acquired = false;
    const a = latest(e);
    if (!a || !activeEvaluationStates.includes(a.state)) return;
    if (a.lease && new Date(a.lease.expiresAt) > ctx.now()) return;
    if (a.inFlight) {
      a.state = e.state = "interrupted";
      a.error =
        "The previous request ended without a saved answer. Its provider usage is uncertain. Retry explicitly to continue; completed answers are retained.";
      a.usageUncertain = true;
      a.lease = null;
      a.finishedAt = now(ctx);
      return;
    }
    if (a.state === "cancelling") {
      a.state = e.state = "cancelled";
      a.finishedAt = now(ctx);
      return;
    }
    a.lease = { holder, expiresAt: new Date(ctx.now().getTime() + LEASE_MS).toISOString() };
    a.state = e.state = "running";
    a.updatedAt = now(ctx);
    acquired = true;
  });
  if (!acquired) return item;
  const attemptId = latest(item)!.id;
  const controller = new AbortController();
  controllers.set(key(ctx, pid, id), controller);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pulseBusy = false;
  const pulse = async () => {
    if (pulseBusy) return;
    pulseBusy = true;
    try {
      await change(ctx, pid, id, (e) => {
        const a = latest(e);
        if (a?.id !== attemptId || a.lease?.holder !== holder || a.state === "cancelling") {
          controller.abort();
          return;
        }
        a.lease.expiresAt = new Date(ctx.now().getTime() + LEASE_MS).toISOString();
        a.updatedAt = now(ctx);
      });
    } catch {
      controller.abort();
    } finally {
      pulseBusy = false;
    }
  };
  let capture: EvaluationCapture | undefined;
  try {
    if (engineFingerprint() !== item.engine.fingerprint)
      throw new Error("The Ask implementation changed. Create a new comparison with the current engine.");
    const inputs = await readInputs(ctx, item);
    await enforceBudget(ctx, item, latest(item));
    const a = latest(item)!;
    const todo = item.questions
      .flatMap((q) => (["baseline", "candidate"] as const).map((arm) => ({ question: q, arm })))
      .find(({ question, arm }) => !a.captures.some((c) => c.questionId === question.id && c.arm === arm));
    if (!todo) {
      return await change(ctx, pid, id, (e) => {
        const current = latest(e)!;
        current.state = e.state = "awaiting_review";
        current.lease = null;
        current.finishedAt = now(ctx);
      });
    }
    item = await change(ctx, pid, id, (e) => {
      const current = latest(e)!;
      if (current.id !== attemptId || current.lease?.holder !== holder || current.state !== "running")
        throw new Error("This attempt was stopped before the next answer started.");
      current.inFlight = { questionId: todo.question.id, arm: todo.arm, startedAt: now(ctx) };
    });
    heartbeat = setInterval(() => {
      void pulse();
    }, 10_000);
    const revision = inputs[todo.arm];
    capture = {
      id: newId("ec"),
      questionId: todo.question.id,
      arm: todo.arm,
      createdAt: now(ctx),
      answer: "",
      sources: [],
      sourcesTruncated: false,
      costUsd: null,
    };
    try {
      const resolved = resolveModel(item.provider, item.model, { structured: true });
      const message = await executeGraphAnswer(
        ctx,
        {
          project: inputs.project,
          graphRevision: revision,
          backend: projectBackend(revision, tboxOf(revision.content), item[todo.arm].reviewPolicy),
          ...resolved,
          question: todo.question.text,
          graphOnly: true,
        },
        () => {},
        controller.signal,
      );
      capture.answer = message.content;
      capture.agent = message.agent;
      const usage = message.agent?.usage;
      capture.costUsd = usage ? costUsd(item.provider, item.model, { inputTokens: usage.input, outputTokens: usage.output }) : null;
      Object.assign(capture, await captureSources(ctx, item, revision, inputs.project, message.entities ?? [], inputs.sourcePins));
    } catch (error) {
      if (controller.signal.aborted) throw error;
      capture.error = error instanceof Error ? error.message : "The answer could not be captured.";
    }
    return await change(ctx, pid, id, (e) => {
      const current = latest(e)!;
      if (current.id !== attemptId || current.lease?.holder !== holder)
        throw new ConflictError("The capture lease changed. Its answer was not published.");
      current.captures.push(capture!);
      if (capture!.error) current.usageUncertain = true;
      e.recordedCostUsd += capture!.costUsd ?? 0;
      current.inFlight = null;
      current.lease = null;
      current.updatedAt = now(ctx);
      current.state = e.state =
        current.state === "cancelling" ? "cancelled" : current.captures.length === e.questions.length * 2 ? "awaiting_review" : "queued";
      if (!activeEvaluationStates.includes(current.state)) current.finishedAt = now(ctx);
    });
  } catch (error) {
    return await change(ctx, pid, id, (e) => {
      const a = latest(e)!;
      if (a.id !== attemptId || a.lease?.holder !== holder) return;
      a.state = e.state = a.state === "cancelling" ? "cancelled" : "failed";
      a.error = controller.signal.aborted
        ? "The request was interrupted; provider usage for the unfinished answer may still be billed. Retry explicitly to continue."
        : error instanceof Error
          ? error.message
          : "Comparison failed.";
      if (a.inFlight) a.usageUncertain = true;
      a.inFlight = null;
      a.lease = null;
      a.updatedAt = now(ctx);
      a.finishedAt = now(ctx);
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (controllers.get(key(ctx, pid, id)) === controller) controllers.delete(key(ctx, pid, id));
  }
}

export async function evaluationSource(ctx: ServiceCtx, pid: string, id: string, sourceId: string): Promise<SourceSnapshot> {
  const item = await requireEvaluation(ctx, pid, id);
  const source = item.attempts
    .flatMap((a) => a.captures)
    .flatMap((c) => c.sources)
    .find((s) => s.id === sourceId);
  if (!source) throw new HttpError(404, "Evaluation source not found.");
  if (!source.available || !source.textHash) throw new HttpError(410, source.issue ?? "Retained source unavailable.");
  const bytes = await ctx.store.blobs.get(sourcePath(pid, id, source.textHash));
  if (!bytes) throw new HttpError(410, "The retained evaluation source is unavailable.");
  const saved = JSON.parse(bytes.toString("utf8")) as SourceSnapshot;
  if (evaluationHash(saved) !== source.textHash) throw new HttpError(409, "The retained evaluation source failed its integrity check.");
  return saved;
}

export async function reviewEvaluation(ctx: ServiceCtx, pid: string, id: string, body: Record<string, unknown>) {
  const item = await requireEvaluation(ctx, pid, id);
  const captureId = text(body.captureId, "Answer", 80);
  const capture = latest(item)?.captures.find((c) => c.id === captureId);
  if (!capture || capture.error) throw new HttpError(400, "Select a successfully captured answer from the latest attempt.");
  const grades: AnswerGrade[] = ["correct", "partial", "incorrect", "unassessable"];
  if (!grades.includes(body.grade as AnswerGrade) || !["supported", "unsupported", "unavailable"].includes(String(body.support)))
    throw new HttpError(400, "Choose a correctness and source-support judgment.");
  if (body.confirmedSourceReview !== true)
    throw new HttpError(400, "Confirm that you inspected the expected answer, query results and available source evidence.");
  if (body.origin !== undefined && body.origin !== "human") throw new HttpError(400, "Automated drafts cannot be saved as human reviews.");
  const reason = text(body.reason, "Review reason", 5000, 5);
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;
  let quote = "",
    start: number | undefined;
  if (body.support !== "unavailable") {
    if (!sourceId || !capture.sources.some((s) => s.id === sourceId)) throw new HttpError(400, "Choose a saved source for this answer.");
    const source = await evaluationSource(ctx, pid, id, sourceId);
    quote = text(body.quote, "Supporting or contradicting quote", 8000, 5);
    const anchored = Number.isInteger(body.start) && Number.isInteger(body.end);
    if (anchored) quote = body.quote as string; // Preserve the exact selected whitespace and offsets.
    start = anchored ? Number(body.start) : source.text.indexOf(quote);
    if (
      start < 0 ||
      source.text.slice(start, start + quote.length) !== quote ||
      (anchored ? Number(body.end) !== start + quote.length : source.text.lastIndexOf(quote) !== start)
    )
      throw new HttpError(400, "Select the passage in the saved source, or copy a unique exact passage.");
  }
  const judgment: EvaluationJudgment = {
    id: newId("ej"),
    captureId,
    previousId: typeof body.previousId === "string" ? body.previousId : null,
    grade: body.grade as AnswerGrade,
    support: body.support as EvaluationJudgment["support"],
    reason,
    sourceId: body.support === "unavailable" ? null : sourceId,
    quote,
    ...(start != null ? { start, end: start + quote.length } : {}),
    origin: "human",
    reviewerId: ctx.user.id,
    createdAt: now(ctx),
  };
  return change(ctx, pid, id, (e) => {
    const a = latest(e);
    if (!a || !["awaiting_review", "completed"].includes(a.state) || !a.captures.some((c) => c.id === captureId))
      throw new HttpError(409, "Review is available after this attempt finishes capturing answers.");
    const previous = e.judgments.filter((j) => j.captureId === captureId).at(-1);
    if ((previous?.id ?? null) !== judgment.previousId) throw new HttpError(409, "This answer's review changed. Reopen it before saving.");
    e.judgments.push(judgment);
    e.state = a.state = "awaiting_review";
  });
}

export async function saveEvaluationReport(ctx: ServiceCtx, pid: string, id: string) {
  return change(ctx, pid, id, (e) => {
    const a = latest(e);
    if (!a || !["awaiting_review", "completed"].includes(a.state))
      throw new HttpError(409, "Capture the comparison before saving a report.");
    const score = scoreEvaluation(e, a);
    if (score.reviewed + score.errors !== score.total)
      throw new HttpError(
        409,
        "Review each successfully captured answer before saving a report. Unassessable answers may be recorded explicitly.",
      );
    const prior = e.reports.at(-1);
    if (prior?.attemptId === a.id && canonical(prior.judgmentIds) === canonical(score.judgmentIds))
      throw new HttpError(409, "This exact review snapshot already has a saved report.");
    const report = { ...score, id: newId("er"), number: e.reports.length + 1, createdAt: now(ctx), createdBy: ctx.user.id };
    e.reports.push({ ...report, checksum: evaluationHash(report) });
    a.state = e.state = "completed";
  });
}

export async function exportEvaluationReport(ctx: ServiceCtx, pid: string, id: string, reportId: string) {
  const item = await requireEvaluation(ctx, pid, id);
  const report = item.reports.find((r) => r.id === reportId);
  if (!report) throw new HttpError(404, "Saved report not found.");
  const attempt = item.attempts.find((a) => a.id === report.attemptId)!;
  const sources: Record<string, unknown> = {};
  for (const source of attempt.captures.flatMap((c) => c.sources)) {
    try {
      sources[source.id] = await evaluationSource(ctx, pid, id, source.id);
    } catch (error) {
      sources[source.id] = { unavailable: true, reason: error instanceof Error ? error.message : "Unavailable" };
    }
  }
  return {
    format: "ontolab-answer-evaluation-v1",
    evaluation: {
      id: item.id,
      title: item.title,
      questions: item.questions,
      baseline: item.baseline,
      candidate: item.candidate,
      provider: item.provider,
      model: item.model,
      engine: item.engine,
    },
    report,
    captures: attempt.captures,
    judgments: item.judgments.filter((j) => report.judgmentIds.includes(j.id)),
    sources,
    limitations: [
      "Exploratory graph-only comparison; not a fresh held-out benchmark.",
      "Source location and answer support are separate judgments.",
      "Reported model costs are estimates from available usage; missing or interrupted usage is not zero.",
    ],
  };
}
