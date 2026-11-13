// Revision validation: schema checks, SHACL, reasoning and competency questions,
// stored as a report tied to the revision AND its content hash — so a report
// produced before a draft was edited is recognisably stale.

import type { CqResult, ReasonerSummary, RevisionContent, StoredValidationReport } from "../../src/types/project.ts";
import type { ReasonerReport } from "../../src/lib/ontology/reasoner/index.ts";
import type { ABoxResult, ValidationIssue } from "../../src/types/abox.ts";
import { validateABox } from "../../src/lib/ontology/aboxValidator.ts";
import { diffIssues, touchedIds, type ChangeCheck, type DraftCheck } from "../../src/lib/ontology/changeCheck.ts";
import { validateShaclDetailed } from "../../src/lib/ontology/shaclValidator.ts";
import { validateOntology } from "../../src/lib/ontology/validate.ts";
import type { ShaclExecution } from "../../src/types/transparency.ts";
import { HttpError } from "../http.ts";
import { competencyQuestion, mergedGraphTurtle, type CallContext } from "../extract.ts";
import { querySparql } from "./sparqlPool.ts";
import { resolveModel } from "../providers.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireRevision } from "./revisions.ts";
import { graphAbox, graphKey, reviewPolicyOf, tboxOf } from "./ontology.ts";
import { requireProject } from "./projects.ts";
import { explanationLines, reasonContent, type ReasonerTier } from "./reasoner.ts";

export const VALIDATOR_VERSION = 2;

export interface SavedQuery {
  question: string;
  sparql?: string;
}

export interface ReportView extends StoredValidationReport {
  stale: boolean;
}

/** Reasoner clashes and unsatisfiable classes as report findings, with their explanations. */
export function reasonerFindings(r: ReasonerReport): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const c of r.clashes) {
    out.push({ severity: "error", code: "inconsistent", message: c.message, where: c.subjects[0] ?? "ontology", ...(c.subjects[0] ? { id: c.subjects[0] } : {}), explanation: explanationLines(c.explanation) });
  }
  for (const u of r.unsatisfiable) {
    out.push({ severity: "error", code: "unsat-class", message: `${u.reason} — no individual can ever be a member.`, where: u.cls, explanation: explanationLines(u.explanation) });
  }
  return out;
}

export function reasonerSummary(r: ReasonerReport): ReasonerSummary {
  return {
    tier: r.tier,
    reasoner: r.reasoner,
    consistent: r.consistent,
    unsatisfiable: r.unsatisfiable.length,
    clashes: r.clashes.length,
    inferredTypes: Object.keys(r.inferredTypes).length,
    inferredLinks: r.inferredLinks.length,
    incomplete: r.incomplete,
    ms: r.stats.ms,
  };
}

/**
 * The reasoner restates some hand-validator findings with an explanation (a
 * disjointness clash, two values of a functional property). Keep one finding
 * per root cause: the explained one.
 */
function withoutRestated(schema: ValidationIssue[], reasoned: ValidationIssue[]): ValidationIssue[] {
  const explained = new Set(reasoned.filter((i) => i.id).map((i) => i.id!));
  return schema.filter((i) => !(i.id && explained.has(i.id) && (i.code === "disjoint" || i.code === "functional")));
}

const count = (issues: ValidationIssue[]) => ({
  errors: issues.filter((i) => i.severity === "error").length,
  warnings: issues.filter((i) => i.severity !== "error").length,
});

/** Schema (structural) issues only — fast enough to run inline before an export. */
export async function schemaIssues(ctx: ServiceCtx, projectId: string, revisionId: string): Promise<ValidationIssue[]> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (!rev.content.abox) return [];
  const tbox = tboxOf(rev.content);
  const policy = reviewPolicyOf(await requireProject(ctx, projectId));
  return validateABox(graphAbox(rev.content, policy), tbox, rev.content.baseIri || tbox.baseIri);
}

export async function validateRevision(ctx: ServiceCtx, projectId: string, revisionId: string, queries: SavedQuery[] = [], opts: { reasoner?: ReasonerTier } = {}): Promise<ReportView> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  const tbox = tboxOf(rev.content);
  const baseIri = rev.content.baseIri || tbox.baseIri;
  // the graph is what the review policy lets in: rejected facts are never validated, queried or reasoned over
  const policy = reviewPolicyOf(await requireProject(ctx, projectId));
  const abox = graphAbox(rev.content, policy);
  const started = Date.now();
  const ontologyIssues = rev.content.modules.length ? validateOntology(rev.content.modules, rev.content.modules[0], { reason: false }).issues : [];
  const ontologyMs = Date.now() - started;
  const reasoningStarted = Date.now();

  let reasoned: ValidationIssue[] = [];
  let reasoner: ReasonerSummary | undefined;
  try {
    const r = await reasonContent(ctx, projectId, { ...rev.content, abox }, { tier: opts.reasoner });
    if (r) {
      reasoned = reasonerFindings(r);
      reasoner = reasonerSummary(r);
    }
  } catch (e) {
    reasoned = [{ severity: "warn", message: `Reasoning could not run: ${e instanceof Error ? e.message : "error"}`, where: "reasoner" }];
  }
  const reasoningMs = Date.now() - reasoningStarted;
  const schemaStarted = Date.now();
  const schema = withoutRestated(validateABox(abox, tbox, baseIri), reasoned);
  const schemaMs = Date.now() - schemaStarted;
  let shacl: ValidationIssue[] = [];
  let shaclExecution: ShaclExecution | undefined;
  try {
    const result = await validateShaclDetailed(abox, tbox, baseIri);
    shacl = result.issues;
    shaclExecution = result.execution;
  } catch (e) {
    shacl = [{ severity: "warn", message: `SHACL validation could not run: ${e instanceof Error ? e.message : "error"}`, where: "SHACL", code: "shacl" }];
  }

  // Saved competency questions with a SPARQL query re-run without a model call.
  const cqResults: CqResult[] = [];
  const cqStarted = Date.now();
  const turtle = () => mergedGraphTurtle({ tbox, abox, question: "", baseIri });
  for (const q of queries.slice(0, 50)) {
    if (!q.sparql?.trim()) continue;
    try {
      const r = await querySparql(graphKey(rev.contentHash, policy), turtle, q.sparql);
      cqResults.push({ question: q.question, sparql: q.sparql, ...r });
    } catch (e) {
      cqResults.push({ question: q.question, sparql: q.sparql, columns: [], rows: [], error: e instanceof Error ? e.message : "Query failed" });
    }
  }

  const all = [...schema, ...shacl, ...reasoned];
  // The headline quality number: the share of competency questions that return an answer.
  const ran = cqResults.length;
  const cqPassRate = ran ? cqResults.filter((r) => !r.error && r.rows.length > 0 && !(r.columns.length === 1 && r.columns[0] === "result" && r.rows[0]?.result === "false")).length / ran : null;
  const report: StoredValidationReport = {
    id: newId("rpt"),
    validatorVersion: VALIDATOR_VERSION,
    projectId,
    revisionId,
    contentHash: rev.contentHash,
    schemaIssues: schema,
    shaclIssues: shacl,
    shaclExecution,
    ontologyIssues,
    execution: { durationMs: Date.now() - started, reviewPolicy: policy, individuals: abox.individuals.length, modules: rev.content.modules.length, ontologyMs, schemaMs, reasoningMs, cqMs: Date.now() - cqStarted },
    cqResults,
    cqPassRate,
    reasonerIssues: reasoned,
    ...(reasoner ? { reasoner } : {}),
    counts: { errors: count(all).errors + ontologyIssues.filter((i) => i.severity === "error").length, warnings: count(all).warnings + ontologyIssues.filter((i) => i.severity === "warning").length },
    createdAt: iso(ctx.now()),
  };
  await ctx.store.reports.put(report);
  ctx.log.info("validation.done", { requestId: ctx.requestId, projectId, revisionId, errors: report.counts.errors, ms: Date.now() - started });
  return { ...report, stale: false };
}

export async function latestReport(ctx: ServiceCtx, projectId: string, revisionId: string): Promise<ReportView | null> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  const report = await ctx.store.reports.latest(projectId, revisionId);
  return report ? { ...report, stale: report.contentHash !== rev.contentHash || report.validatorVersion !== VALIDATOR_VERSION } : null;
}

async function reasonerIssuesOf(ctx: ServiceCtx, projectId: string, content: RevisionContent, abox: ABoxResult) {
  const r = await reasonContent(ctx, projectId, { ...content, abox });
  return r ? { tier: r.tier, consistent: r.consistent, issues: reasonerFindings(r) } : null;
}

/**
 * Validate a draft as a change to its parent: which findings the edits
 * introduced and resolved (schema checks, and the reasoner's inconsistencies
 * and unsatisfiable classes). Findings the parent already had were accepted
 * when it was committed, so only new ones count against the change. Cheap
 * enough to run after each autosave: reasoner results are cached by content.
 */
export async function checkDraft(ctx: ServiceCtx, projectId: string, revisionId: string): Promise<DraftCheck> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  const parent = rev.parentId ? await requireRevision(ctx, projectId, rev.parentId).catch(() => null) : null;
  const policy = reviewPolicyOf(await requireProject(ctx, projectId));
  const tbox = tboxOf(rev.content);
  const abox = graphAbox(rev.content, policy);
  // the parent is judged against its own T-Box, so a schema change that breaks individuals shows as introduced
  let parentTbox = tbox;
  try {
    if (parent) parentTbox = tboxOf(parent.content);
  } catch {
    /* parent had no T-Box: compare against the draft's */
  }
  const parentAbox = parent ? graphAbox(parent.content, policy) : null;
  const baseIri = rev.content.baseIri || tbox.baseIri;
  const before = parentAbox ? validateABox(parentAbox, parentTbox, parent!.content.baseIri || parentTbox.baseIri) : [];
  const { introduced, resolved } = diffIssues(before, validateABox(abox, tbox, baseIri));
  const change: ChangeCheck = { introduced, resolved, blocking: introduced.filter((i) => i.severity === "error"), touched: touchedIds(parentAbox, abox) };

  let reasoner: DraftCheck["reasoner"] = null;
  try {
    const now = await reasonerIssuesOf(ctx, projectId, rev.content, abox);
    if (now) {
      const was = parent ? await reasonerIssuesOf(ctx, projectId, parent.content, parentAbox!).catch(() => null) : null;
      reasoner = { ...now, introduced: diffIssues(was?.issues ?? [], now.issues).introduced };
    }
  } catch (e) {
    ctx.log.info("check.reasoner_failed", { requestId: ctx.requestId, projectId, error: e instanceof Error ? e.message : String(e) });
  }
  const blocked = change.blocking.length > 0 || (reasoner?.introduced.some((i) => i.severity === "error") ?? false);
  return { ...change, contentHash: rev.contentHash, reasoner, blocked };
}

/**
 * The commit gate for user commits: a change that introduces an error is
 * refused outright; one that introduces warnings needs `acknowledgedWarnings`.
 */
export async function assertCommittable(ctx: ServiceCtx, projectId: string, revisionId: string, opts: { acknowledgedWarnings?: boolean } = {}): Promise<void> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (rev.status !== "draft") return; // commitRevision reports this
  let check: DraftCheck;
  try {
    check = await checkDraft(ctx, projectId, revisionId);
  } catch (e) {
    // no parseable T-Box: nothing to validate against, which only matters when there are individuals
    if (e instanceof HttpError && e.status === 422 && !rev.content.abox?.individuals.length) return;
    throw e;
  }
  if (check.blocked) {
    const errors = [...check.blocking, ...(check.reasoner?.introduced ?? []).filter((i) => i.severity === "error")];
    const n = errors.length;
    const head = errors.slice(0, 3).map((i) => i.message).join("; ");
    throw new HttpError(422, `This change introduces ${n} validation error${n === 1 ? "" : "s"}; fix ${n === 1 ? "it" : "them"} before committing. ${head}${n > 3 ? "; …" : ""}`);
  }
  const warnings = check.introduced.length + (check.reasoner?.introduced.length ?? 0);
  if (warnings > 0 && !opts.acknowledgedWarnings) {
    throw new HttpError(428, `This change introduces ${warnings} validation warning${warnings === 1 ? "" : "s"}. Review them, or confirm the commit.`);
  }
}

/** Translate a question to SPARQL with the selected model and run it on the revision. */
export async function askCompetencyQuestion(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  question: string,
  provider: string | undefined,
  model: string | undefined,
  signal?: AbortSignal,
) {
  const q = question.trim();
  if (!q) throw new HttpError(400, "question is required");
  const rev = await requireRevision(ctx, projectId, revisionId);
  const tbox = tboxOf(rev.content);
  const resolved = resolveModel(provider, model, { structured: true });
  const call: CallContext = { provider: resolved.provider, model: resolved.model, signal };
  const policy = reviewPolicyOf(await requireProject(ctx, projectId));
  return competencyQuestion({ tbox, abox: graphAbox(rev.content, policy), question: q, baseIri: rev.content.baseIri || tbox.baseIri }, call);
}

/** Run an explicit SPARQL query (read-only, parsed) against a revision. */
export async function runQuery(ctx: ServiceCtx, projectId: string, revisionId: string, sparql: string) {
  const rev = await requireRevision(ctx, projectId, revisionId);
  const tbox = tboxOf(rev.content);
  const policy = reviewPolicyOf(await requireProject(ctx, projectId));
  return querySparql(graphKey(rev.contentHash, policy), () => mergedGraphTurtle({ tbox, abox: graphAbox(rev.content, policy), question: "", baseIri: rev.content.baseIri || tbox.baseIri }), sparql);
}
