// Review actions on drafts: the human half of every automated step.
//
//   ontology  — pitfall scan, reuse suggestions (A3/A4), alignment with an
//               imported standard (A6), accepting improvement-loop proposals (A7)
//   graph     — entity-resolution decisions: merge or keep separate (B3)
//
// Every change lands in a DRAFT revision (created from the current one when
// needed); committing stays a separate, explicit step — except accepting
// proposals, which commits when the ontology change validates cleanly.

import { createHash } from "node:crypto";
import type {
  ImpactReport,
  MergeCandidate,
  OntologyRevision,
  OntologyReview,
  RevisionContent,
  RevisionSource,
  RevisionWithContent,
  AlignmentMapping,
} from "../../src/types/project.ts";
import type { AlignmentReviewInput, AlignmentDecision } from "../../src/types/alignment.ts";
import { alignmentKey, mappingIsCurrent, comparisonIsCurrent } from "../../src/lib/alignment.ts";
import { alignedContent, alignmentBridge, parseAlignmentSetup } from "./alignmentState.ts";
import type { OntoModule } from "../../src/types/validation.ts";
import { parseTBox, mergeTBox } from "../../src/lib/ontology/tboxParser.ts";
import { scanPitfalls, type Pitfall } from "../../src/lib/ontology/pitfalls.ts";
import { validateOntology } from "../../src/lib/ontology/validate.ts";
import { applyMerge } from "../../src/lib/ontology/resolution.ts";
import { applyDecisions, listFacts, type FactDecision, type FactRow } from "../../src/lib/ontology/factReview.ts";
import type { EvidenceRef, FactStatus, PendingFact } from "../../src/types/abox.ts";
import type { TermProposal } from "../../src/types/project.ts";
import { locateQuote } from "./evidence.ts";
import { localName } from "../../src/lib/ontology/iri.ts";
import { mergedGraphTurtle } from "../extract.ts";
import { querySparql } from "./sparqlPool.ts";
import { HttpError } from "../http.ts";
import { resolveModel } from "../providers.ts";
import { iso, newId, type ServiceCtx } from "./context.ts";
import { requireProject, touchProject } from "./projects.ts";
import { commitRevision, createRevision, requireRevision, updateDraft } from "./revisions.ts";
import { tboxOf } from "./ontology.ts";
import { suggestReuse, reuseTriples } from "./reuse.ts";
import { alignOntologies, coherentSubset, mappingTurtle } from "./alignment.ts";
import { proposalsToContent, replayPendingFacts } from "./proposals.ts";
import { embedderFor, requireRun } from "./runs.ts";

/* ───────────────────────── drafts ───────────────────────── */

/** The draft to change: the revision itself when it is a draft, else a new draft copied from it (it must be current). */
async function draftFor(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  source: RevisionSource,
  summary: string,
): Promise<RevisionWithContent> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (rev.status === "draft") return rev;
  const project = await requireProject(ctx, projectId);
  if (project.currentRevisionId !== rev.id) throw new HttpError(409, "Only the current revision can be changed. Restore it first.");
  const draft = await createRevision(ctx, projectId, { content: rev.content, source, summary });
  return requireRevision(ctx, projectId, draft.id);
}

async function saveContent(
  ctx: ServiceCtx,
  projectId: string,
  rev: RevisionWithContent,
  content: RevisionContent,
  summary?: string,
): Promise<OntologyRevision> {
  return updateDraft(ctx, projectId, rev.id, content, summary, false, ctx.store.revisionPreconditions ? rev.contentHash : undefined);
}

function withReview(content: RevisionContent, patch: Partial<OntologyReview>): RevisionContent {
  return { ...content, review: { ...(content.review ?? {}), ...patch } };
}

/* ───────────────────────── pitfalls (A4) ───────────────────────── */

export async function revisionPitfalls(ctx: ServiceCtx, projectId: string, revisionId: string): Promise<Pitfall[]> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (!rev.content.modules.length) return [];
  return scanPitfalls(tboxOf(rev.content), { modules: rev.content.modules });
}

/* ───────────────────────── reuse (A3) ───────────────────────── */

export async function reuseSuggestions(ctx: ServiceCtx, projectId: string, revisionId: string) {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (!rev.content.modules.length) return [];
  return suggestReuse(tboxOf(rev.content));
}

/** Add `term owl:equivalentClass/Property iri` to the module that declares the term. */
export async function acceptReuse(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  input: { term: string; iri: string; kind: "class" | "property" },
): Promise<OntologyRevision> {
  if (!/^https?:\/\/\S+$/.test(input.iri) || !/^https?:\/\/\S+$/.test(input.term))
    throw new HttpError(400, "term and iri must be absolute http(s) IRIs.");
  const draft = await draftFor(ctx, projectId, revisionId, "ontology", "Reuse an existing vocabulary term");
  const at = draft.content.modules.findIndex((m) => {
    try {
      const t = parseTBox(m.turtle);
      return [...t.classes, ...t.objectProps, ...t.dataProps].some((x) => x.uri === input.term);
    } catch {
      return false;
    }
  });
  if (at < 0) throw new HttpError(404, "That term is not declared in this revision.");
  const modules = draft.content.modules.map((m, i) =>
    i === at ? { ...m, turtle: `${m.turtle.trimEnd()}\n\n${reuseTriples(input.term, input.kind, input.iri)}` } : m,
  );
  const reuse = (draft.content.review?.reuse ?? []).map((r) => (r.term === input.term ? { ...r, status: "accepted" as const } : r));
  return saveContent(ctx, projectId, draft, withReview({ ...draft.content, modules }, { reuse }));
}

/* ───────────────────────── alignment (A6) ───────────────────────── */

function checkAlignmentHash(rev: RevisionWithContent, expectedHash?: string) {
  if (expectedHash && expectedHash !== rev.contentHash)
    throw new HttpError(409, "This comparison changed. Refresh it before saving your decision.");
}

export async function saveAlignmentSetup(ctx: ServiceCtx, projectId: string, revisionId: string, value: unknown, expectedHash?: string) {
  const rev = await requireRevision(ctx, projectId, revisionId);
  checkAlignmentHash(rev, expectedHash);
  const setup = parseAlignmentSetup(value, rev.content);
  const draft = await draftFor(ctx, projectId, revisionId, "ontology", "Prepare ontology alignment");
  checkAlignmentHash(draft, rev.contentHash);
  return saveContent(ctx, projectId, draft, withReview(draft.content, { alignmentSetup: setup }));
}

export async function alignModules(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  input: {
    sourceModules: string[];
    targetModules: string[];
    provider?: string;
    model?: string;
    matchers?: { lexical?: boolean; semantic?: boolean; structural?: boolean };
    maxSource?: number | null;
    expectedHash?: string;
  },
  signal?: AbortSignal,
): Promise<OntologyRevision> {
  const project = await requireProject(ctx, projectId);
  const rev = await requireRevision(ctx, projectId, revisionId);
  checkAlignmentHash(rev, input.expectedHash);
  const setup = parseAlignmentSetup({ ...input, verify: !!input.provider }, rev.content, true);
  const pick = (ids: string[]) => rev.content.modules.filter((m) => ids.includes(m.id));
  const src = pick(setup.sourceModules);
  const tgt = pick(setup.targetModules);
  if (!src.length || !tgt.length) throw new HttpError(400, "Pick at least one source module and one target module.");
  if (src.some((s) => tgt.some((t) => s.id === t.id))) throw new HttpError(400, "Source and target module groups must be disjoint.");
  const started = Date.now();
  const model = (mods: OntoModule[]) => mergeTBox(mods.map((m) => parseTBox(m.turtle)));
  const call = input.provider
    ? (() => {
        const r = resolveModel(input.provider, input.model, { structured: true });
        return { provider: r.provider, model: r.model, signal };
      })()
    : undefined;
  const { mappings, candidates, diagnostics, usage } = await alignOntologies(model(src), model(tgt), {
    embedder: embedderFor(project),
    call,
    matchers: input.matchers,
    maxSource: setup.maxSource,
  });
  const draft = await draftFor(ctx, projectId, revisionId, "ontology", "Align modules");
  // Refuse to attach results to inputs changed while the matching/model calls ran.
  if (draft.contentHash !== rev.contentHash) throw new HttpError(409, "The revision changed during alignment. Run the comparison again.");
  return saveContent(
    ctx,
    projectId,
    draft,
    alignedContent(
      draft.content,
      { ...setup, ...(call ? { provider: call.provider, model: call.model } : {}) },
      { mappings, candidates, diagnostics, usage },
      { at: iso(ctx.now()), durationMs: Date.now() - started, inputHash: rev.contentHash },
    ),
  );
}

export { ALIGNMENT_MODULE } from "../../src/lib/alignment.ts";

/**
 * Accept mappings. Unless forced, a coherence check holds back any mapping
 * that would make a class unsatisfiable; held-back mappings stay open with the
 * explanation attached, the rest are written to the alignment module.
 */
export async function acceptAlignment(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  ids: string[],
  opts: { force?: boolean } = {},
): Promise<OntologyRevision> {
  return reviewAlignment(ctx, projectId, revisionId, { action: "accept", ids }, opts);
}

/** Human decisions and their inverse update the bridge and audit trail together. */
export async function reviewAlignment(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  input: AlignmentReviewInput,
  opts: { force?: boolean } = {},
): Promise<OntologyRevision> {
  if (!["accept", "reject", "defer", "reopen", "edit", "add", "undo"].includes(input.action))
    throw new HttpError(400, "Unknown alignment action.");
  const rev = await requireRevision(ctx, projectId, revisionId);
  checkAlignmentHash(rev, input.expectedHash);
  const history = rev.content.review?.alignmentRuns ?? [];
  const decisions = rev.content.review?.alignmentDecisions ?? [];
  const latest = history.at(-1);
  // Anchor legacy mappings before recording undo snapshots; later comparisons must not change their provenance.
  const all: AlignmentMapping[] = (rev.content.review?.alignment ?? []).map((mapping) => ({
    ...mapping,
    runId: mapping.runId ?? latest?.id,
  }));
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : undefined;
  const relation = input.relation;
  if (
    (input.action === "edit" || input.action === "add") &&
    !["equivalent", "broader", "narrower", "related", "candidate"].includes(relation ?? "")
  )
    throw new HttpError(400, "Choose a supported mapping relation.");
  const ids = [...new Set(input.ids ?? [])];
  let chosen = all.filter((m) => ids.includes(m.id));
  if (input.action !== "add" && (!chosen.length || chosen.length !== ids.length)) throw new HttpError(400, "Select existing mappings.");
  if (input.action === "accept") {
    chosen = chosen.filter((m) => m.status !== "accepted");
    if (!chosen.length) throw new HttpError(400, "Select at least one mapping awaiting review.");
  }
  if (input.action === "add") {
    if (!latest || !comparisonIsCurrent(latest, rev.content))
      throw new HttpError(409, "Run a comparison of the current modules before adding mappings.");
    const model = (moduleIds: string[]) =>
      mergeTBox(latest.modules.filter((m) => moduleIds.includes(m.id)).map((m) => parseTBox(m.turtle)));
    const kind = (tbox: ReturnType<typeof model>, uri?: string) =>
      tbox.classes.some((c) => c.uri === uri)
        ? "class"
        : tbox.objectProps.some((p) => p.uri === uri)
          ? "object"
          : tbox.dataProps.some((p) => p.uri === uri)
            ? "data"
            : null;
    const sourceKind = kind(model(latest.sourceModules), input.source),
      targetKind = kind(model(latest.targetModules), input.target);
    if (!sourceKind || sourceKind !== targetKind || input.source === input.target)
      throw new HttpError(400, "Choose distinct terms of the same kind from the compared source and target.");
    const candidate = latest.candidates.find((m) => m.source === input.source && m.target === input.target);
    const mapping: AlignmentMapping = {
      id: newId("am"),
      source: input.source!,
      target: input.target!,
      kind: sourceKind === "class" ? "class" : "property",
      score: candidate?.score ?? 0,
      scores: candidate?.scores,
      cosine: candidate?.cosine,
      relation: relation!,
      rationale: candidate?.rationale ?? "Manually added correspondence; no retrieval score is available.",
      verified: candidate?.relation === relation && candidate?.verified === true,
      status: "open",
      humanReviewed: true,
      reviewNote: note,
      runId: latest.id,
    };
    if (all.some((m) => alignmentKey(m) === alignmentKey(mapping)))
      throw new HttpError(409, "This pair is already in the review workspace. Edit its existing mapping.");
    chosen = [mapping];
  }
  const replacements = new Map<string, AlignmentMapping | null>();
  for (const mapping of chosen) {
    const current = mappingIsCurrent(mapping, rev.content);
    if (["accept", "edit"].includes(input.action) && !current)
      throw new HttpError(409, "Compared ontology modules changed after matching. Run alignment again before reviewing this mapping.");
    const next = { ...mapping, reviewNote: note ?? mapping.reviewNote };
    if (input.action === "undo") {
      const last = decisions.filter((event) => event.mappingId === mapping.id).at(-1);
      if (!last || last.action === "undo" || last.action === "inputs_changed")
        throw new HttpError(400, "There is no recent human decision to undo for this mapping.");
      if (last.before?.status === "accepted" && !mappingIsCurrent(last.before, rev.content))
        throw new HttpError(409, "The original inputs changed. Run alignment again before restoring an accepted mapping.");
      replacements.set(mapping.id, last.before);
      continue;
    }
    if (input.action === "accept") {
      if (next.relation === "unrelated") throw new HttpError(400, "Unrelated terms cannot be accepted as a mapping.");
      next.status = "accepted";
    }
    if (input.action === "reject") next.status = "dismissed";
    if (input.action === "defer") next.status = "deferred";
    if (input.action === "reopen") next.status = "open";
    if (input.action === "edit") {
      next.relation = relation!;
      next.status = "open";
      next.verified = false;
      next.humanReviewed = true;
    }
    delete next.conflict;
    replacements.set(mapping.id, next);
  }
  const proposed = () => [
    ...all.filter((m) => !replacements.has(m.id)),
    ...[...replacements.values()].filter((m): m is AlignmentMapping => !!m),
  ];
  const toAccept = [...replacements.values()].filter((m): m is AlignmentMapping => m?.status === "accepted");
  let conflicts: AlignmentMapping[] = [];
  let accepted: AlignmentMapping[] = [];
  if (toAccept.length) {
    // Remove the selected mappings' old statements before checking replacements or undo.
    const withoutChosen = all.filter((m) => !replacements.has(m.id));
    const baseline = alignmentBridge(rev.content, all, withoutChosen);
    ({ accepted, conflicts } = opts.force ? { accepted: toAccept, conflicts: [] } : coherentSubset(baseline, toAccept));
    for (const conflict of conflicts) {
      const original = all.find((m) => m.id === conflict.id)!;
      replacements.set(conflict.id, {
        ...original,
        status: original.status === "accepted" ? "open" : original.status,
        conflict: conflict.conflict,
      });
    }
  }
  const alignment = proposed();
  const events: AlignmentDecision[] = chosen.map((mapping) => ({
    id: newId("ad"),
    at: iso(ctx.now()),
    action: input.action,
    mappingId: mapping.id,
    before: all.find((m) => m.id === mapping.id) ?? null,
    after: replacements.get(mapping.id) ?? null,
    note,
  }));
  const alignmentRuns = history.map((record, i) =>
    i !== history.length - 1 || input.action !== "accept"
      ? record
      : {
          ...record,
          decisions: [
            ...record.decisions,
            {
              at: iso(ctx.now()),
              requested: ids,
              accepted: accepted.map((m) => m.id),
              conflicts,
              forced: opts.force ?? false,
              turtle: mappingTurtle(accepted),
            },
          ],
        },
  );
  const draft = await draftFor(ctx, projectId, revisionId, "ontology", "Review alignment mappings");
  checkAlignmentHash(draft, rev.contentHash);
  return saveContent(
    ctx,
    projectId,
    draft,
    withReview(
      { ...draft.content, modules: alignmentBridge(draft.content, all, alignment) },
      {
        alignment,
        alignmentRuns,
        alignmentDecisions: [...decisions, ...events],
      },
    ),
  );
}

/* ───────────────────────── improvement loop (A7) ───────────────────────── */

/**
 * Accept proposals from a run: the additions go into extensions.ttl of a new
 * revision based on the current one. It is committed straight away when the
 * change validates without errors (otherwise left as a draft to fix).
 */
/** Does a query result count as an answer (rows, and not an ASK that said false)? */
const answered = (r: { columns: string[]; rows: Record<string, string>[] }) =>
  r.rows.length > 0 && !(r.columns.length === 1 && r.columns[0] === "result" && r.rows[0]?.result === "false");

/**
 * What an ontology change does before it is committed (minimal-change
 * evolution): structural and reasoner validation of the changed module
 * (unsatisfiable classes, entailments that change between existing terms), and
 * the saved competency queries re-run on the graph before and after — a query
 * that answered before and does not after is a regression.
 */
export async function impactAnalysis(
  ctx: ServiceCtx,
  projectId: string,
  current: RevisionWithContent,
  content: RevisionContent,
): Promise<ImpactReport> {
  const changed = content.modules.find((m) => !current.content.modules.some((c) => c.id === m.id && c.turtle === m.turtle));
  if (!changed) return { ok: true, errors: [], unintended: [], newlyUnsat: [], cq: { checked: 0, regressions: [] }, changes: [] };
  const report = validateOntology(current.content.modules, { id: changed.id, name: changed.name, turtle: changed.turtle });
  const project = await requireProject(ctx, projectId);
  const queries = (project.settings.savedQueries ?? []).filter((q) => q.sparql?.trim()).slice(0, 50);
  const graph = (c: RevisionContent) => () => {
    const tbox = tboxOf(c);
    return mergedGraphTurtle({ tbox, abox: c.abox ?? { individuals: [] }, question: "", baseIri: c.baseIri || tbox.baseIri });
  };
  const afterKey = `impact:${createHash("sha256")
    .update(JSON.stringify([content.modules.map((m) => m.turtle), content.abox, content.baseIri]))
    .digest("hex")
    .slice(0, 32)}`;
  const regressions: string[] = [];
  for (const q of queries) {
    const run = (key: string, c: RevisionContent) =>
      querySparql(key, graph(c), q.sparql).catch(() => ({ columns: [], rows: [] as Record<string, string>[] }));
    const before = await run(`rev:${current.contentHash}`, current.content);
    if (!answered(before)) continue;
    const after = await run(afterKey, content);
    if (!answered(after)) regressions.push(q.question);
  }
  const { added, removed } = report.diff;
  const changes = [
    ...[...added.classes, ...added.objectProps, ...added.dataProps].map((u) => `+ ${localName(u)}`),
    ...report.diff.modified.map((u) => `~ ${localName(u)}`),
    ...[...removed.classes, ...removed.objectProps, ...removed.dataProps].map((u) => `− ${localName(u)}`),
  ].slice(0, 200);
  const errors = report.issues.filter((i) => i.severity === "error").map((i) => i.message);
  return {
    ok: report.ok && regressions.length === 0,
    errors,
    unintended: report.issues.filter((i) => i.code === "entailment-changed" && i.severity === "warning").map((i) => i.message),
    newlyUnsat: report.reasoning?.newlyUnsat ?? [],
    cq: { checked: queries.length, regressions },
    changes,
  };
}

export async function acceptProposals(ctx: ServiceCtx, projectId: string, runId: string, ids: string[], dismiss: string[] = []) {
  const run = await requireRun(ctx, projectId, runId);
  const proposals = run.proposals ?? [];
  const accepted = proposals.filter((p) => ids.includes(p.id) && p.status === "open");
  const project = await requireProject(ctx, projectId);
  let revision: OntologyRevision | null = null;
  let committed = false;
  let issues: string[] = [];
  let impact: ImpactReport | null = null;
  if (accepted.length) {
    if (!project.currentRevisionId) throw new HttpError(409, "Commit an ontology first.");
    const current = await requireRevision(ctx, projectId, project.currentRevisionId);
    const { content } = proposalsToContent(current.content, tboxOf(current.content), accepted);
    impact = await impactAnalysis(ctx, projectId, current, content);
    revision = await createRevision(ctx, projectId, {
      content: { ...content, impact },
      source: "ontology",
      summary:
        `Added ${accepted.length} term${accepted.length === 1 ? "" : "s"} found during extraction: ${accepted.map((p) => p.name).join(", ")}`.slice(
          0,
          300,
        ),
    });
    issues = [...impact.errors, ...impact.cq.regressions.map((q) => `“${q}” is no longer answered`)];
    // committed straight away only when nothing breaks; otherwise it waits as a draft for a person
    if (impact.ok) {
      revision = await commitRevision(ctx, projectId, revision.id);
      committed = true;
    }
  }
  const next = proposals.map((p) =>
    accepted.some((a) => a.id === p.id)
      ? { ...p, status: "accepted" as const }
      : dismiss.includes(p.id) && p.status === "open"
        ? { ...p, status: "dismissed" as const }
        : p,
  );
  await ctx.store.runs.update(projectId, runId, { proposals: next });
  await touchProject(ctx, projectId);
  // what closing the loop would take: replaying waiting facts, or re-extracting the chunks the ideas came from
  const reextract = committed
    ? reextractScope(
        run,
        accepted.map((p) => p.id),
      )
    : null;
  return { revision, committed, issues, impact, reextract, proposals: next };
}

/* ───────────────────────── closing the loop ───────────────────────── */

/**
 * After the ontology gained terms a run asked for: turn the facts that waited
 * for them into candidate facts on a new draft (no model call; their quotes are
 * located again in the stored chunks). What cannot be replayed — a fact whose
 * subject was never extracted, say — needs a re-extraction of its chunks.
 */
export async function replayRun(ctx: ServiceCtx, projectId: string, runId: string) {
  const run = await requireRun(ctx, projectId, runId);
  const project = await requireProject(ctx, projectId);
  if (!project.currentRevisionId) throw new HttpError(409, "Commit an ontology first.");
  const accepted = (run.proposals ?? []).filter((p) => p.status === "accepted");
  const wanted = new Set(accepted.flatMap((p) => p.pendingFactIds ?? []));
  const pending = (run.pendingFacts ?? []).filter((f) => !wanted.size || wanted.has(f.id));
  if (!pending.length) throw new HttpError(409, "This run has no facts waiting for new ontology terms.");
  const current = await requireRevision(ctx, projectId, project.currentRevisionId);
  const docIds = [...new Set(pending.map((f) => f.documentId).filter((d): d is string => !!d))];
  const chunks = new Map((docIds.length ? await ctx.store.documents.chunks(projectId, docIds) : []).map((c) => [c.id, c]));
  const evidence = (f: PendingFact): EvidenceRef | null => {
    if (!f.quote) return null;
    const chunk = f.chunkId ? chunks.get(f.chunkId) : undefined;
    const at = chunk ? locateQuote(f.quote, chunk.text) : null;
    return {
      quote: f.quote,
      status: at ? "verified" : "unverified",
      ...(f.documentId ? { documentId: f.documentId } : {}),
      ...(f.chunkId ? { chunkId: f.chunkId } : {}),
      ...(chunk?.page ? { page: chunk.page } : {}),
      ...(at && chunk ? { start: chunk.start + at.start, end: chunk.start + at.end } : {}),
    };
  };
  const res = replayPendingFacts(current.content.abox ?? { individuals: [] }, pending, tboxOf(current.content), {
    evidence,
    runId,
    at: iso(ctx.now()),
  });
  if (!res.replayed)
    throw new HttpError(
      409,
      `None of the ${pending.length} waiting facts could be replayed (their terms are still missing, or their subject was never extracted). Re-extract their chunks instead.`,
    );
  const revision = await createRevision(ctx, projectId, {
    content: { ...current.content, abox: res.abox },
    source: "extraction",
    summary: `Replayed ${res.replayed} fact${res.replayed === 1 ? "" : "s"} that waited for new ontology terms (candidates to review)`,
    runId,
  });
  return { revision, replayed: res.replayed, skipped: res.skipped };
}

/** The chunks and documents a re-extraction of accepted proposals should cover. */
export function reextractScope(
  run: { proposals?: TermProposal[]; pendingFacts?: PendingFact[] },
  ids: string[],
): { chunkIds: string[]; documentIds: string[]; pendingFacts: number } {
  const chosen = (run.proposals ?? []).filter((p) => ids.includes(p.id));
  const chunkIds = [...new Set(chosen.flatMap((p) => p.chunkIds ?? []))];
  const factIds = new Set(chosen.flatMap((p) => p.pendingFactIds ?? []));
  const pending = (run.pendingFacts ?? []).filter((f) => factIds.has(f.id));
  const documentIds = [
    ...new Set(
      [...pending.map((f) => f.documentId), ...chosen.flatMap((p) => p.examples.map((e) => e.documentId))].filter((d): d is string => !!d),
    ),
  ];
  return { chunkIds, documentIds, pendingFacts: pending.length };
}

/* ───────────────────────── per-fact review ───────────────────────── */

/** Facts of a revision for the review queue: the least certain first. */
export async function factQueue(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  status: FactStatus | "all" = "candidate",
  limit = 500,
): Promise<{ facts: FactRow[]; counts: Record<FactStatus, number> }> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  const all = rev.content.abox ? listFacts(rev.content.abox) : [];
  const counts: Record<FactStatus, number> = { candidate: 0, accepted: 0, rejected: 0 };
  for (const f of all) counts[f.status]++;
  const facts = all
    .filter((f) => status === "all" || f.status === status)
    .sort((a, b) => (a.confidence ?? -1) - (b.confidence ?? -1))
    .slice(0, Math.max(1, Math.min(2000, limit)));
  return { facts, counts };
}

/** A person's accept / reject decisions on facts, applied to a draft (a committed revision gets a new draft). */
export async function reviewFacts(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  decisions: FactDecision[],
): Promise<{ revision: OntologyRevision; applied: number }> {
  if (!decisions.length) throw new HttpError(400, "No decisions given.");
  const draft = await draftFor(ctx, projectId, revisionId, "manual", "Review facts");
  if (!draft.content.abox) throw new HttpError(409, "This revision has no facts to review.");
  const { abox, applied } = applyDecisions(draft.content.abox, decisions, iso(ctx.now()));
  if (!applied) throw new HttpError(404, "None of those facts exist in this revision.");
  const accepted = decisions.filter((d) => d.status === "accepted").length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const revision = await saveContent(
    ctx,
    projectId,
    draft,
    { ...draft.content, abox },
    `Reviewed facts: ${accepted} accepted, ${rejected} rejected`,
  );
  return { revision, applied };
}

/* ───────────────────────── entity resolution (B3) ───────────────────────── */

/**
 * Decide merge candidates on a draft: "merge" applies the merge to the draft's
 * A-Box (claims, evidence and incoming links move to the kept individual);
 * "distinct" records that they are different. `all` applies every recommended merge.
 */
export async function decideMerges(
  ctx: ServiceCtx,
  projectId: string,
  revisionId: string,
  input: { decisions?: { id: string; decision: "merge" | "distinct"; keep?: string }[]; applyRecommended?: boolean },
): Promise<OntologyRevision> {
  const rev = await requireRevision(ctx, projectId, revisionId);
  if (rev.status !== "draft") throw new HttpError(409, "Merges are decided on a draft. Start a new draft to change a committed revision.");
  const candidates: MergeCandidate[] = rev.content.resolution?.candidates ?? [];
  let abox = rev.content.abox ?? { individuals: [] };
  const live = new Set(abox.individuals.map((i) => i.id));
  const decisions = new Map((input.decisions ?? []).map((d) => [d.id, d]));
  const out: MergeCandidate[] = [];
  let merged = 0;
  for (const c of candidates) {
    const d = decisions.get(c.id);
    const wantMerge = d ? d.decision === "merge" : input.applyRecommended && c.decision === "merge";
    if (d?.decision === "distinct") {
      out.push({ ...c, decision: "distinct", explanation: `${c.explanation}; kept separate by a reviewer` });
      // record it as owl:differentFrom, so a later owl:sameAs between them is a contradiction the reasoner reports
      const ids = c.ids.filter((id) => live.has(id));
      abox = {
        ...abox,
        individuals: abox.individuals.map((i) =>
          ids.includes(i.id) ? { ...i, differentFrom: [...new Set([...(i.differentFrom ?? []), ...ids.filter((x) => x !== i.id)])] } : i,
        ),
      };
      continue;
    }
    if (!wantMerge) {
      out.push(c);
      continue;
    }
    const ids = c.ids.filter((id) => live.has(id));
    const keep = d?.keep && ids.includes(d.keep) ? d.keep : ids[0];
    const order = [keep, ...ids.filter((id) => id !== keep)];
    if (order.length >= 2) {
      abox = applyMerge(abox, order).abox;
      for (const id of order.slice(1)) live.delete(id);
      merged++;
    }
    // A decided merge leaves the review list.
  }
  if (!merged && !input.decisions?.length) return rev;
  return updateDraft(
    ctx,
    projectId,
    rev.id,
    { ...rev.content, abox, resolution: { candidates: out } },
    merged
      ? `${rev.summary.replace(/ · \d+ merges? applied$/, "")} · ${merged} merge${merged === 1 ? "" : "s"} applied`.slice(0, 2000)
      : undefined,
  );
}
