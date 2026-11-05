// The evaluation harness (phase 0). Runs the product's own services — the same
// code the API calls — on each gold domain with a REAL model, and scores every
// stage against the hand-labelled gold set. The numbers decide whether a phase
// is done, so the harness runs on every change to a prompt, schema or provider.
//
// Stages (select with --stages):
//   cq          user stories → generated competency questions vs the approved ones
//   induction   documents → induced T-Box vs the gold T-Box (+ pitfall counts)
//   extraction  gold T-Box + documents → A-Box vs the gold A-Box, entity
//               resolution, evidence, CQ pass rate, cost and estimate error
//   evidence    entailment gate vs human labels
//   assistant   question answering by type, routed vs passage-only
//   extension   hold out a fifth of the gold leaf classes, extract, accept the
//               proposals: held-out recovery, duplicates, unintended entailments,
//               replayed facts and the A-Box gain from re-extraction
//   alignment   OAEI tracks in eval/gold-oaei (precision/recall, coherence)
//
// Induction also reports axiom precision/recall, schema-level CQ coverage and
// the LLMs4OL taxonomy / relation tasks; extraction reports calibration of the
// evidence gate and the precision of auto-accepted facts. A run configuration
// (`options`, from --ablate or --grid) is passed to every run, so ablations
// compare the same code with one switch changed.
//
// Text2KGBench and WDC Products are smoke tests only; this three-domain gold set
// is what decides a phase.

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ABoxResult } from "../src/types/abox.ts";
import type { ExtractionRun, RunKind, RunOptions } from "../src/types/project.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { pitfallCounts, scanPitfalls } from "../src/lib/ontology/pitfalls.ts";
import { applyMergeDecisions } from "../src/lib/ontology/resolution.ts";
import { createLocalStore } from "../server/store/local.ts";
import { silentLogger, type ServiceCtx } from "../server/services/context.ts";
import * as projects from "../server/services/projects.ts";
import * as documents from "../server/services/documents.ts";
import * as revisions from "../server/services/revisions.ts";
import * as runs from "../server/services/runs.ts";
import * as requirements from "../server/services/requirements.ts";
import * as assistant from "../server/services/assistant.ts";
import * as review from "../server/services/review.ts";
import { Parser, Writer } from "n3";
import { countFacts } from "../src/lib/ontology/factReview.ts";
import { axiomMetrics, calibration, claimScores, cqTermCoverage, extensionRecovery, leafClasses, llms4olMetrics } from "./research.ts";
import { oaeiTracks, runOaeiTrack, type OaeiResult } from "./oaei.ts";
import { mergedGraphTurtle } from "../server/extract.ts";
import { querySparql, stopSparqlPool } from "../server/services/sparqlPool.ts";
import { tboxOf } from "../server/services/ontology.ts";
import { getEmbedder, cosine } from "../server/ml/embeddings.ts";
import { getNliScorer } from "../server/ml/nli.ts";
import { NLI_REVIEW_THRESHOLD } from "../server/config.ts";
import type { ProviderId } from "../server/providers.ts";
import {
  agreement,
  answerCorrect,
  cqSimilarity,
  extractionMetrics,
  inductionMetrics,
  resolutionMetrics,
  round,
  tokenJaccard,
  verifiedShare,
  type GoldAbox,
} from "./metrics.ts";

export interface HarnessArgs {
  provider: string;
  model: string;
  domains: string[];
  stages: string[];
  goldDir: string;
  outDir: string;
  /** cap on assistant questions per domain (cost control) */
  maxQuestions: number;
  /** run options for every run (ablation switches) */
  options?: Partial<RunOptions>;
  /** name of the configuration, for result files */
  configName?: string;
  /** OAEI track folder */
  oaeiDir?: string;
  /** alignment matchers and model verification (study 2 ablations) */
  align?: { lexical?: boolean; semantic?: boolean; structural?: boolean; verify?: boolean };
}

interface Gold {
  name: string;
  tboxTtl: string;
  docs: { name: string; text: string }[];
  abox: GoldAbox;
  domain: { name: string; purpose: string; scope: string; stories: string[]; cqs: { text: string; sparql: string }[] };
  questions: { question: string; type: "single" | "multi" | "aggregate"; answer: string[] }[];
  evidence: { quote: string; claim: string; entailed: boolean }[];
}

async function loadGold(dir: string, name: string): Promise<Gold> {
  const base = join(dir, name);
  const json = async <T>(f: string) => JSON.parse(await readFile(join(base, f), "utf8")) as T;
  const docNames = (await readdir(join(base, "docs"))).filter((f) => f.endsWith(".txt")).sort();
  return {
    name,
    tboxTtl: await readFile(join(base, "tbox.ttl"), "utf8"),
    docs: await Promise.all(docNames.map(async (f) => ({ name: f, text: await readFile(join(base, "docs", f), "utf8") }))),
    abox: await json<GoldAbox>("abox.gold.json"),
    domain: await json<Gold["domain"]>("domain.json"),
    questions: await json<Gold["questions"]>("questions.json").catch(() => []),
    evidence: await json<Gold["evidence"]>("evidence.labels.json").catch(() => []),
  };
}

let reqSeq = 0;
function ctxFor(dataDir: string): ServiceCtx {
  const user = { id: "eval" };
  return { store: createLocalStore(dataDir).forUser(user), user, now: () => new Date(), log: silentLogger, requestId: `eval${String(++reqSeq).padStart(8, "0")}` };
}

async function drive(ctx: ServiceCtx, pid: string, runId: string): Promise<ExtractionRun> {
  for (let i = 0; i < 5000; i++) {
    const r = await runs.advanceRun(ctx, pid, runId);
    if (["ready_for_review", "failed", "cancelled", "awaiting_answers"].includes(r.run.status)) return r.run;
    if (r.waitMs) await new Promise((res) => setTimeout(res, Math.min(r.waitMs!, 5000)));
  }
  throw new Error("run did not finish");
}

async function newProject(ctx: ServiceCtx, g: Gold, withDocs: boolean) {
  const p = await projects.createProject(ctx, { name: `eval-${g.name}`, purpose: g.domain.purpose, scope: g.domain.scope });
  const docIds: string[] = [];
  if (withDocs) for (const d of g.docs) docIds.push((await documents.uploadDocument(ctx, p.id, d.name, Buffer.from(d.text))).id);
  return { pid: p.id, docIds };
}

async function runOf(ctx: ServiceCtx, pid: string, kind: RunKind, docIds: string[], args: HarnessArgs, extra: Partial<RunOptions> = {}) {
  const created = await runs.createRun(ctx, pid, { kind, documentIds: docIds, mode: "automatic", provider: args.provider, model: args.model, options: { ...args.options, ...extra } });
  const done = await drive(ctx, pid, created.id);
  if (done.status !== "ready_for_review") throw new Error(`${kind} run ended ${done.status}: ${done.error ?? ""}`);
  return done;
}

type DomainResult = Record<string, unknown>;

async function evalDomain(g: Gold, args: HarnessArgs, dataDir: string): Promise<DomainResult> {
  const ctx = ctxFor(dataDir);
  const embedder = getEmbedder();
  const out: DomainResult = { domain: g.name, documents: g.docs.length, goldIndividuals: g.abox.individuals.length };
  const goldTbox = parseTBox(g.tboxTtl);
  const allText = g.docs.map((d) => d.text).join("\n\n");

  if (args.stages.includes("cq")) {
    const { pid } = await newProject(ctx, g, false);
    await requirements.saveRequirements(ctx, pid, { stories: g.domain.stories, cqs: [] });
    const p = await requirements.generateCqs(ctx, pid, { provider: args.provider, model: args.model });
    const generated = requirementsTexts(p.settings.requirements?.cqs ?? []);
    const approved = g.domain.cqs.map((c) => c.text);
    let simFn = tokenJaccard;
    if (embedder) {
      const texts = [...generated, ...approved];
      const vecs = await embedder.embed(texts);
      const m = new Map(texts.map((t, i) => [t, vecs[i]]));
      simFn = (a, b) => (m.has(a) && m.has(b) ? cosine(m.get(a)!, m.get(b)!) : tokenJaccard(a, b));
    }
    out.cq = { generated: generated.length, ...cqSimilarity(generated, approved, simFn, embedder ? 0.75 : 0.35), similarity: embedder ? embedder.id : "token-jaccard" };
  }

  if (args.stages.includes("induction")) {
    const { pid, docIds } = await newProject(ctx, g, true);
    await requirements.saveRequirements(ctx, pid, { stories: g.domain.stories, cqs: g.domain.cqs.map((c) => ({ text: c.text, status: "approved" })) });
    const done = await runOf(ctx, pid, "induction", docIds, args);
    const draft = await revisions.requireRevision(ctx, pid, done.resultRevisionId!);
    const induced = tboxOf(draft.content);
    out.induction = {
      ...inductionMetrics(induced, goldTbox),
      axioms: axiomMetrics(induced, goldTbox),
      cqCoverage: cqTermCoverage(g.domain.cqs, induced, goldTbox),
      llms4ol: llms4olMetrics(induced, goldTbox),
      axiomsAdmitted: draft.content.review?.axioms ? { accepted: draft.content.review.axioms.accepted.length, rejected: draft.content.review.axioms.rejected.length } : null,
      ungroundedTerms: (draft.content.review?.termEvidence ?? []).filter((e) => !e.located).length,
      sizes: { classes: induced.classes.length, properties: induced.objectProps.length + induced.dataProps.length },
      pitfalls: pitfallCounts(scanPitfalls(induced, { modules: draft.content.modules })),
      pitfallsBeforeRepair: draft.content.review?.pitfallsBefore ?? null,
      usage: done.usage,
      costUsd: done.cost?.actualUsd ?? null,
    };
  }

  let committedAbox: ABoxResult | null = null;
  let extractionPid: string | null = null;
  if (args.stages.includes("extraction") || args.stages.includes("assistant")) {
    const { pid, docIds } = await newProject(ctx, g, true);
    extractionPid = pid;
    await requirements.saveRequirements(ctx, pid, { stories: g.domain.stories, cqs: g.domain.cqs.map((c) => ({ text: c.text, status: "approved", sparql: c.sparql })) });
    const t = await revisions.createRevision(ctx, pid, { content: { modules: [{ id: "gold", name: "gold-tbox.ttl", turtle: g.tboxTtl }], abox: null, baseIri: "" }, source: "import", summary: "gold T-Box" });
    await revisions.commitRevision(ctx, pid, t.id);
    const done = await runOf(ctx, pid, "extraction", docIds, args);
    const draft = await revisions.requireRevision(ctx, pid, done.resultRevisionId!);
    const raw = draft.content.abox ?? { individuals: [] };
    const candidates = draft.content.resolution?.candidates ?? [];
    const merged = applyMergeDecisions(raw, candidates);
    const tbox = tboxOf(draft.content);
    const baseIri = draft.content.baseIri || tbox.baseIri;

    // CQ pass rate on the merged graph, with the gold queries
    let passed = 0;
    const cqErrors: string[] = [];
    for (const c of g.domain.cqs) {
      try {
        const r = await querySparql(`eval:${g.name}:${done.id}`, () => mergedGraphTurtle({ tbox, abox: merged, question: "", baseIri }), c.sparql);
        if (r.rows.length) passed++;
      } catch (e) {
        cqErrors.push(e instanceof Error ? e.message.slice(0, 120) : "error");
      }
    }
    const est = done.cost?.estimatedUsd ?? null;
    const act = done.cost?.actualUsd ?? null;
    if (args.stages.includes("extraction")) {
      out.extraction = {
        ...extractionMetrics(merged, g.abox, goldTbox, allText),
        beforeMerges: extractionMetrics(raw, g.abox, goldTbox, allText).individuals,
        resolution: { before: resolutionMetrics(raw, g.abox), after: resolutionMetrics(merged, g.abox, raw), candidates: candidates.length, recommended: candidates.filter((c) => c.decision === "merge").length },
        evidence: verifiedShare(merged),
        calibration: calibration(claimScores(merged, g.abox)),
        factReview: countFacts(merged),
        cqPassRate: g.domain.cqs.length ? passed / g.domain.cqs.length : null,
        cqErrors,
        cost: {
          usage: done.usage,
          estimatedUsd: est,
          actualUsd: act,
          usdPerDocument: act != null ? act / g.docs.length : null,
          estimateError: est != null && act ? Math.abs(est - act) / act : null,
          skippedByScreen: done.skipped ?? 0,
          cached: done.cached ?? 0,
        },
        proposals: (done.proposals ?? []).length,
      };
    }
    // commit the merged graph for the assistant stage
    if (args.stages.includes("assistant")) {
      await revisions.updateDraft(ctx, pid, draft.id, { ...draft.content, abox: merged });
      await revisions.commitRevision(ctx, pid, draft.id);
      committedAbox = merged;
    }
  }

  if (args.stages.includes("evidence") && g.evidence.length) {
    const scorer = getNliScorer({ call: { provider: args.provider as ProviderId, model: args.model } });
    if (scorer) {
      const scores = await scorer.score(g.evidence.map((e) => ({ premise: e.quote, hypothesis: e.claim })));
      out.evidenceAgreement = { scorer: scorer.id, threshold: NLI_REVIEW_THRESHOLD, ...agreement(scores.map((s) => s >= NLI_REVIEW_THRESHOLD), g.evidence.map((e) => e.entailed)) };
    }
  }

  if (args.stages.includes("extension")) out.extension = await evalExtension(ctx, g, goldTbox, args);

  if (args.stages.includes("assistant") && extractionPid && committedAbox) {
    const byType: Record<string, { routed: number; passageOnly: number; n: number }> = {};
    for (const q of g.questions.slice(0, args.maxQuestions)) {
      const t = (byType[q.type] ??= { routed: 0, passageOnly: 0, n: 0 });
      t.n++;
      const routed = await assistant.ask(ctx, extractionPid, { question: q.question, provider: args.provider, model: args.model });
      const plain = await assistant.ask(ctx, extractionPid, { question: q.question, provider: args.provider, model: args.model, route: "single" });
      if (answerCorrect(routed.message.content, q.answer)) t.routed++;
      if (answerCorrect(plain.message.content, q.answer)) t.passageOnly++;
    }
    out.assistant = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { n: v.n, routed: v.routed / v.n, passageOnly: v.passageOnly / v.n }]));
  }
  return out;
}

/** The T-Box with every triple that mentions one of the terms removed (as if they had never been modelled). */
function withoutTerms(turtle: string, uris: Set<string>): string {
  const quads = new Parser().parse(turtle).filter((q) => !(uris.has(q.subject.value) || uris.has(q.object.value)));
  const writer = new Writer();
  writer.addQuads(quads);
  let out = "";
  writer.end((err, result) => {
    if (!err) out = result;
  });
  return out;
}

/**
 * Extension: hide a fifth of the gold leaf classes from the T-Box, extract,
 * accept every class the run proposes, and score what came back — the
 * minimal-change evolution protocol of the research plan.
 */
async function evalExtension(ctx: ServiceCtx, g: Gold, goldTbox: ReturnType<typeof parseTBox>, args: HarnessArgs) {
  const leaves = leafClasses(goldTbox);
  const heldOut = leaves.filter((_, i) => i % 5 === 0);
  if (!heldOut.length) return { skipped: "the gold T-Box has no leaf classes to hold out" };
  const reduced = withoutTerms(g.tboxTtl, new Set(heldOut));
  const { pid, docIds } = await newProject(ctx, g, true);
  await requirements.saveRequirements(ctx, pid, { stories: g.domain.stories, cqs: g.domain.cqs.map((c) => ({ text: c.text, status: "approved", sparql: c.sparql })) });
  const t = await revisions.createRevision(ctx, pid, { content: { modules: [{ id: "gold", name: "reduced-tbox.ttl", turtle: reduced }], abox: null, baseIri: "" }, source: "import", summary: "gold T-Box minus held-out classes" });
  await revisions.commitRevision(ctx, pid, t.id);
  const first = await runOf(ctx, pid, "extraction", docIds, args);
  const firstDraft = await revisions.requireRevision(ctx, pid, first.resultRevisionId!);
  await revisions.commitRevision(ctx, pid, firstDraft.id);
  const classProposals = (first.proposals ?? []).filter((p) => p.kind === "class");
  const keptNames = goldTbox.classes.map((c) => c.uri).filter((u) => !heldOut.includes(u)).map((u) => u.replace(/^.*[#/]/, ""));
  const heldNames = heldOut.map((u) => u.replace(/^.*[#/]/, ""));
  if (!classProposals.length) return { heldOut: heldNames, proposals: 0, recovery: extensionRecovery([], heldNames, keptNames) };
  const acc = await review.acceptProposals(ctx, pid, first.id, classProposals.map((p) => p.id));
  const out: Record<string, unknown> = {
    heldOut: heldNames,
    proposals: classProposals.length,
    relations: Object.fromEntries(["new", "synonym", "specialization", "conflict"].map((r) => [r, classProposals.filter((p) => p.relation === r).length])),
    ...extensionRecovery(
      classProposals.map((p) => p.name),
      heldNames,
      keptNames,
    ),
    committed: acc.committed,
    unintendedEntailments: acc.impact?.unintended.length ?? null,
    newlyUnsatisfiable: acc.impact?.newlyUnsat.length ?? null,
    changeSize: acc.impact?.changes.length ?? null,
    cqRegressions: acc.impact?.cq.regressions.length ?? null,
  };
  if (!acc.committed) return out;
  const before = extractionMetrics(firstDraft.content.abox ?? { individuals: [] }, g.abox, goldTbox, g.docs.map((d) => d.text).join("\n\n")).assertions.f1;
  if (acc.reextract?.pendingFacts) {
    const replay = await review.replayRun(ctx, pid, first.id).catch(() => null);
    out.replayed = replay?.replayed ?? 0;
  }
  if (acc.reextract?.chunkIds.length) {
    const again = await runOf(ctx, pid, "extraction", acc.reextract.documentIds, args, { incremental: true, onlyChunks: acc.reextract.chunkIds });
    const draft = await revisions.requireRevision(ctx, pid, again.resultRevisionId!);
    const after = extractionMetrics(draft.content.abox ?? { individuals: [] }, g.abox, goldTbox, g.docs.map((d) => d.text).join("\n\n")).assertions.f1;
    out.assertionF1 = { before, after, gain: after - before };
  }
  return out;
}

function requirementsTexts(cqs: { text: string; source: string }[]): string[] {
  return cqs.filter((c) => c.source === "generated").map((c) => c.text);
}

/* ───────────────────────── gates (the plan's "target by phase 3") ───────────────────────── */

interface Gate {
  name: string;
  target: string;
  value: number | null;
  pass: boolean | null;
}

const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function gates(results: DomainResult[], alignment: OaeiResult[] = []): Gate[] {
  const get = (path: string) => mean(results.map((r) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), r) as number | undefined));
  const g = (name: string, target: string, value: number | null, ok: (v: number) => boolean): Gate => ({ name, target, value, pass: value == null ? null : ok(value) });
  const multi = results.map((r) => (r.assistant as Record<string, { routed: number; passageOnly: number }> | undefined)?.multi).filter(Boolean) as { routed: number; passageOnly: number }[];
  return [
    g("Generated CQs kept after review (proxy: match an approved CQ)", "≥ 0.80", get("cq.keptShare"), (v) => v >= 0.8),
    g("Induced ontology similarity to gold (continuous F1 on classes)", "> 0.70", get("induction.classes.continuous"), (v) => v > 0.7),
    g("Critical pitfalls after repair", "0", get("induction.pitfalls.critical"), (v) => v === 0),
    g("Extraction precision (individuals)", "> 0.85", get("extraction.individuals.precision"), (v) => v > 0.85),
    g("Subject hallucination", "< 0.03", get("extraction.hallucination.subject"), (v) => v < 0.03),
    g("Relation hallucination", "< 0.03", get("extraction.hallucination.relation"), (v) => v < 0.03),
    g("Object hallucination", "< 0.03", get("extraction.hallucination.object"), (v) => v < 0.03),
    g("Duplicates after merge", "< 0.05", get("extraction.resolution.after.duplicateRate"), (v) => v < 0.05),
    g("Wrong merges", "< 0.01", get("extraction.resolution.after.wrongMergeRate"), (v) => v < 0.01),
    g("Claims with a verified quote", "≥ 0.95", get("extraction.evidence.share"), (v) => v >= 0.95),
    g("Entailment agreement with human labels", "> 0.80", get("evidenceAgreement.accuracy"), (v) => v > 0.8),
    g("Multi-hop: routed minus passage-only", "≥ +0.10", multi.length ? mean(multi.map((m) => m.routed - m.passageOnly)) : null, (v) => v >= 0.1),
    g("Cost estimate error", "≤ 0.20", get("extraction.cost.estimateError"), (v) => v <= 0.2),
    g("Schema-level CQ coverage of the induced ontology", "≥ 0.80", get("induction.cqCoverage.share"), (v) => v >= 0.8),
    g("Calibration of the evidence gate (ECE)", "≤ 0.10", get("extraction.calibration.ece"), (v) => v <= 0.1),
    g("Precision of auto-accepted facts", "≥ 0.95", get("extraction.calibration.autoAcceptedPrecision"), (v) => v >= 0.95),
    g("Unintended entailment changes per extension", "0", get("extension.unintendedEntailments"), (v) => v === 0),
    g("Unsatisfiable classes after alignment (repaired)", "0", alignment.length ? mean(alignment.map((a) => a.repaired.unsatisfiable)) : null, (v) => v === 0),
  ];
}

function markdown(args: HarnessArgs, results: DomainResult[], gateList: Gate[], started: Date, alignment: OaeiResult[] = []): string {
  const f = (v: unknown) => (typeof v === "number" ? (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(0)) : v == null ? "—" : String(v));
  const lines = [
    `# OntoLab evaluation — ${started.toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `Model: ${args.provider}/${args.model} · stages: ${args.stages.join(", ")} · domains: ${args.domains.join(", ")}${args.configName ? ` · configuration: ${args.configName}` : ""}`,
    ...(args.options && Object.keys(args.options).length ? ["", `Run options: \`${JSON.stringify(args.options)}\``] : []),
    "",
    "The gold set is a SEED drafted by AI and must be reviewed by a person before these numbers are trusted (eval/gold/README.md).",
    "",
    "## Gates",
    "",
    "| Check | Target | Value | Pass |",
    "| --- | --- | --- | --- |",
    ...gateList.map((g) => `| ${g.name} | ${g.target} | ${f(g.value)} | ${g.pass == null ? "not run" : g.pass ? "yes" : "no"} |`),
    "",
    "## Per domain",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.domain}`, "", "```json", JSON.stringify(round(r), null, 2), "```", "");
  }
  if (alignment.length) {
    lines.push("## Alignment (OAEI)", "");
    for (const a of alignment) lines.push(`### ${a.track}`, "", "```json", JSON.stringify(round(a), null, 2), "```", "");
  }
  return lines.join("\n");
}

export async function main(args: HarnessArgs): Promise<{ jsonPath: string; mdPath: string; gates: Gate[] }> {
  const started = new Date();
  const dataDir = await mkdtemp(join(tmpdir(), "ontolab-eval-"));
  const results: DomainResult[] = [];
  const alignment: OaeiResult[] = [];
  try {
    for (const name of args.domains) {
      const gold = await loadGold(args.goldDir, name);
      process.stdout.write(`[eval] ${name}: ${gold.docs.length} documents, ${gold.abox.individuals.length} gold individuals … `);
      const t0 = Date.now();
      try {
        results.push(await evalDomain(gold, args, dataDir));
        process.stdout.write(`done in ${Math.round((Date.now() - t0) / 1000)}s\n`);
      } catch (e) {
        process.stdout.write("failed\n");
        results.push({ domain: name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (args.stages.includes("alignment")) {
      const dir = args.oaeiDir ?? resolve("eval/gold-oaei");
      const tracks = await oaeiTracks(dir);
      if (!tracks.length) process.stdout.write(`[eval] alignment: no OAEI tracks in ${dir} (see eval/oaei.ts)\n`);
      for (const t of tracks) {
        process.stdout.write(`[eval] alignment ${t} … `);
        try {
          const call = args.align?.verify === false ? undefined : { provider: args.provider as ProviderId, model: args.model };
          const { verify: _v, ...matchers } = args.align ?? {};
          void _v;
          alignment.push(await runOaeiTrack(join(dir, t), t, { embedder: getEmbedder(), call, matchers }));
          process.stdout.write("done\n");
        } catch (e) {
          process.stdout.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
  } finally {
    await stopSparqlPool();
  }
  const gateList = gates(results, alignment);
  await mkdir(args.outDir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = resolve(args.outDir, `${stamp}-${args.provider}-${args.model.replace(/[^A-Za-z0-9.-]+/g, "_")}${args.configName ? `-${args.configName.replace(/[^A-Za-z0-9.-]+/g, "_")}` : ""}`);
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  await writeFile(jsonPath, JSON.stringify(round({ args, started: started.toISOString(), gates: gateList, results, alignment }), null, 2));
  await writeFile(mdPath, markdown(args, results, gateList, started, alignment));
  return { jsonPath, mdPath, gates: gateList };
}
