import type { AlignmentEstimate, AlignmentRunContext } from "../../src/types/alignment.ts";
import type { ExtractionRun, JobCheckpoint, RunStep } from "../../src/types/project.ts";
import { mergeTBox, parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import { HttpError } from "../http.ts";
import { getEmbedder } from "../ml/embeddings.ts";
import { resolveModel } from "../providers.ts";
import type { CallContext } from "../extract.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject, touchProject } from "./projects.ts";
import { createRevision, requireRevision } from "./revisions.ts";
import { alignedContent, parseAlignmentSetup } from "./alignmentState.ts";
import { alignmentWorkEstimate, alignOntologies, summarizeAlignment, verifyAlignmentBatch, type AlignmentResult } from "./alignment.ts";
import { costUsd, round4 } from "./pricing.ts";
import { snapshotRunInputs } from "./research.ts";

function models(context: Pick<AlignmentRunContext, "content" | "setup">) {
  const pick = (ids: string[]) => mergeTBox(context.content.modules.filter((m) => ids.includes(m.id)).map((m) => parseTBox(m.turtle)));
  return { source: pick(context.setup.sourceModules), target: pick(context.setup.targetModules) };
}

async function prepare(ctx: ServiceCtx, pid: string, rid: string, value: unknown, expectedHash?: string) {
  const project = await requireProject(ctx, pid);
  if (project.settings.corpus) throw new HttpError(409, "Align ontologies in an ontology project, not a pinned corpus.");
  const revision = await requireRevision(ctx, pid, rid);
  if (expectedHash && expectedHash !== revision.contentHash)
    throw new HttpError(409, "The alignment inputs changed. Refresh the comparison plan.");
  const setup = parseAlignmentSetup(value, revision.content, true);
  if (setup.verify) {
    const resolved = resolveModel(setup.provider!, setup.model, { structured: true });
    setup.provider = resolved.provider;
    setup.model = resolved.model;
  }
  const { source, target } = models({ content: revision.content, setup });
  const work = alignmentWorkEstimate(source, target, setup.maxSource, setup.verify);
  if (!work.processedSourceTerms || !work.targetTerms)
    throw new HttpError(400, "Choose source and target ontologies containing named terms.");
  const embeddings = project.settings.models?.embeddings;
  const embedder = setup.matchers.semantic ? getEmbedder({ backend: embeddings }) : null;
  const usd = setup.verify ? costUsd(setup.provider!, setup.model!, work) : 0;
  const estimate: AlignmentEstimate = {
    ...work,
    usd: usd === null ? null : round4(usd),
    priced: usd !== null,
    embeddingCostExcluded: embedder?.backend === "provider",
  };
  const context: AlignmentRunContext = {
    setup,
    content: revision.content,
    inputHash: revision.contentHash,
    parentRevisionId: revision.status === "committed" ? revision.id : revision.parentId,
    embeddings: embedder?.backend ?? "off",
    estimate,
  };
  return { project, revision, context, estimate };
}

export async function estimateAlignment(ctx: ServiceCtx, pid: string, rid: string, setup: unknown, expectedHash?: string) {
  return (await prepare(ctx, pid, rid, setup, expectedHash)).estimate;
}

function stepsFor(batches: number): RunStep[] {
  return [
    { key: "alignment:retrieve", kind: "alignment_retrieve", label: "Find candidate correspondences" },
    ...Array.from({ length: batches }, (_, i): RunStep => ({
      key: `alignment:verify:${i}`,
      kind: "alignment_verify",
      label: `Classify relations · batch ${i + 1} of ${batches}`,
    })),
    { key: "finalize", kind: "finalize", label: "Prepare the mapping review draft" },
  ];
}

export async function createAlignmentRun(
  ctx: ServiceCtx,
  pid: string,
  rid: string,
  setup: unknown,
  expectedHash?: string,
  identity?: string,
) {
  const { project, context, estimate } = await prepare(ctx, pid, rid, setup, expectedHash);
  const previous = await ctx.store.runs.list(pid);
  if (previous.some((r) => ["queued", "running", "awaiting_answers"].includes(r.status)))
    throw new HttpError(409, "This project already has an active run. Finish, pause or cancel it first.");
  const budget = project.settings.budget;
  if (budget?.maxUsdPerRun != null && estimate.usd != null && estimate.usd > budget.maxUsdPerRun)
    throw new HttpError(
      409,
      `Estimated generation cost $${estimate.usd.toFixed(4)} exceeds the per-run budget. Reduce source coverage or adjust spending limits in the recovery panel.`,
    );
  if (budget?.maxUsdTotal != null && previous.reduce((sum, r) => sum + (r.cost?.actualUsd ?? 0), 0) >= budget.maxUsdTotal)
    throw new HttpError(
      409,
      "The project has reached its total budget. Adjust spending limits in the recovery panel before starting another activity.",
    );
  const now = iso(ctx.now());
  const run: ExtractionRun = {
    id: identity ?? newId("run"),
    projectId: pid,
    ownerId: ctx.user.id,
    kind: "alignment",
    status: "queued",
    mode: "automatic",
    alignment: context,
    baseRevisionId: rid,
    documentIds: [],
    documentChecksums: {},
    provider: context.setup.verify ? context.setup.provider! : "none",
    model: context.setup.verify ? context.setup.model! : "none",
    settings: { vision: [] },
    steps: stepsFor(estimate.modelCalls),
    completedSteps: 0,
    attempts: 0,
    lease: null,
    cost: { estimatedUsd: estimate.usd, actualUsd: estimate.priced ? 0 : null, priced: estimate.priced },
    usage: { inputTokens: 0, outputTokens: 0 },
    questions: [],
    clarifications: [],
    qaRound: 1,
    qaDone: true,
    notes: [
      "Inputs are frozen for this run. Results are saved in a separate draft; review decisions made after starting are not included.",
    ],
    createdAt: now,
    updatedAt: now,
  };
  await snapshotRunInputs(ctx, run, [], [], { alignmentSetup: context.setup });
  await ctx.store.runs.create(run);
  await touchProject(ctx, pid);
  return run;
}

function retrieval(cps: JobCheckpoint[]): AlignmentResult | undefined {
  return cps.find((c) => c.key === "alignment:retrieve")?.payload as AlignmentResult | undefined;
}

/** Once retrieval finishes, replace the upper-bound plan with the actual number of batches. */
export function refinedAlignmentSteps(run: ExtractionRun, cps: JobCheckpoint[]) {
  const found = retrieval(cps);
  return found ? stepsFor(run.alignment!.setup.verify ? Math.ceil(found.candidates.length / 20) : 0) : run.steps;
}

/** Checkpoints remain authoritative if the process stopped before updating progress. */
export function alignmentUsage(cps: JobCheckpoint[], failed = { inputTokens: 0, outputTokens: 0 }) {
  return cps.reduce(
    (total, cp) => ({ inputTokens: total.inputTokens + cp.usage.inputTokens, outputTokens: total.outputTokens + cp.usage.outputTokens }),
    { ...failed },
  );
}

export async function runAlignmentStep(run: ExtractionRun, step: RunStep, cps: JobCheckpoint[], call: CallContext) {
  const context = run.alignment!;
  const { source, target } = models(context);
  const out =
    step.kind === "alignment_retrieve"
      ? await alignOntologies(source, target, {
          embedder: getEmbedder({ backend: context.embeddings }),
          matchers: context.setup.matchers,
          maxSource: context.setup.maxSource,
        })
      : await verifyAlignmentBatch(
          source,
          target,
          retrieval(cps)!.candidates.slice(Number(step.key.split(":").at(-1)) * 20, (Number(step.key.split(":").at(-1)) + 1) * 20),
          call,
        );
  return {
    abox: { individuals: [] },
    notes: [],
    payload: out,
    usage: out.usage,
    trace: {
      durationMs: 0,
      diagnostics: { configurationAtExecution: { setup: context.setup, embeddingBackend: context.embeddings } },
      input: { inputHash: context.inputHash, sourceModules: context.setup.sourceModules, targetModules: context.setup.targetModules },
    },
  };
}

export async function finalizeAlignment(ctx: ServiceCtx, run: ExtractionRun, cps: JobCheckpoint[]) {
  // A crash after saving the draft must not create another result on retry.
  const existing = (await ctx.store.revisions.list(run.projectId)).find((r) => r.runId === run.id);
  if (existing) return { revisionId: existing.id, notes: [] };
  const found = retrieval(cps);
  if (!found) throw new HttpError(500, "Candidate retrieval is missing. Retry the alignment run.");
  const context = run.alignment!;
  const candidates = context.setup.verify
    ? run.steps
        .filter((step) => step.kind === "alignment_verify")
        .flatMap((step) => {
          const saved = cps.find((cp) => cp.key === step.key)?.payload as Awaited<ReturnType<typeof verifyAlignmentBatch>> | undefined;
          if (!saved) throw new HttpError(500, "A classification checkpoint is missing. Retry the alignment run.");
          return saved.candidates;
        })
    : found.candidates;
  const result = summarizeAlignment(candidates, found.diagnostics, run.usage);
  const content = alignedContent(context.content, context.setup, result, {
    at: iso(ctx.now()),
    durationMs: cps.reduce((ms, cp) => ms + (cp.trace?.durationMs ?? 0), 0),
    inputHash: context.inputHash,
  });
  const revision = await createRevision(ctx, run.projectId, {
    content,
    parentId: context.parentRevisionId,
    source: "ontology",
    runId: run.id,
    summary: `Alignment: ${result.mappings.length} mappings from ${result.diagnostics.processedSourceTerms} source terms`,
  });
  return { revisionId: revision.id, notes: [] };
}
