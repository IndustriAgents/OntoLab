// Runs: configure an extraction (documents, pinned ontology revision,
// provider/model, mode, quality options) with a cost estimate, follow its
// progress step by step, answer clarification questions, resume / cancel /
// retry, and act on what it found: the draft to review and the terms the
// ontology had no place for (the improvement loop). Induction runs show here
// too and end in an ontology draft.
//
// Processing is driven by this open tab (one bounded step per request) unless
// the server runs a background worker; reopening offers Resume.

import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import { useAuth } from "../../app/auth";
import type { ImpactReport, RunMode, RunOptions, RunView, TermProposal } from "../../types/project";
import { EstimateLine } from "../ontology/InducePanel";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { EmptyState, ErrorState, InlineError, LoadingState, PageHead, StatusBadge, fmtDate } from "../../components/ui/ui";
import { IconArrowRight, IconPlay } from "../../components/icons";
import { RunStatusBadge } from "./RunStatusBadge";
import { ExperimentOptions } from "../research/ExperimentOptions";
import { runOutcome, outcomeCopy } from "../../lib/runOutcome";
import { ApiError } from "../../lib/http";
import { BudgetRecovery } from "./BudgetRecovery";
import { RunStages } from "./RunStages";
import { runKindLabel } from "../../lib/runNavigation";
import "./runs.css";
import { RunInspector } from "../research/RunInspector";

export function NewRun({ onCreated, documentIds }: { onCreated: (run: RunView) => void; documentIds?: string[] }) {
  const { pid, current, activeRun } = useProject();
  const choice = useModelChoice();
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid) });
  const parsed = useMemo(() => (docs.data ?? []).filter((d) => d.parseState === "parsed"), [docs.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vision, setVision] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RunMode>("automatic");
  const [options, setOptions] = useState<Partial<RunOptions>>({
    incremental: true,
    relevanceScreen: true,
    resolveEntities: true,
    verifyEvidence: true,
  });
  const { config } = useAuth();
  useEffect(() => {
    setSelected(new Set(documentIds ?? parsed.filter((d) => !d.variantOf).map((d) => d.id)));
  }, [parsed, documentIds]);
  const qc = useQueryClient();
  const body = {
    documentIds: [...selected],
    mode,
    provider: choice.provider,
    model: choice.model,
    vision: choice.selected?.supportsVision ? [...vision].filter((v) => selected.has(v)) : [],
    options,
  };
  const estimate = useQuery({
    queryKey: ["estimate", pid, body],
    queryFn: ({ signal }) => api.estimateRun(pid, body, signal),
    enabled: selected.size > 0 && choice.providerEnabled && !!current?.stats.modules,
    staleTime: 60_000,
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => api.createRun(pid, body),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      onCreated(run);
    },
  });
  const chunks = parsed.filter((d) => selected.has(d.id)).reduce((n, d) => n + (vision.has(d.id) ? 1 : d.chunkCount), 0);

  if (!current || current.stats.modules === 0)
    return (
      <EmptyState
        title="Commit an ontology first"
        action={
          <Link className="btn" to={`/p/${pid}/ontology`}>
            Go to Ontology
          </Link>
        }
      >
        Extraction is constrained to the classes and properties of a committed T-Box revision.
      </EmptyState>
    );
  if (!docs.isLoading && !parsed.length)
    return (
      <EmptyState
        title="No parsed documents"
        action={
          <Link className="btn" to={`/p/${pid}/documents`}>
            Upload documents
          </Link>
        }
      >
        Upload at least one document to extract from.
      </EmptyState>
    );

  return (
    <section className="card" aria-labelledby="new-run">
      <div className="card-head">
        <h3 id="new-run">Extract knowledge</h3>
        <span className="file">Ontology: revision {current.number}</span>
      </div>
      <details open={!documentIds}>
        <summary>Selected documents & PDF vision options</summary>
        <fieldset className="fieldset">
          <legend>Documents</legend>
          <ul className="check-list">
            {parsed
              .filter((d) => !documentIds || documentIds.includes(d.id))
              .map((d) => (
                <li key={d.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      disabled={!!documentIds}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? new Set([...s, d.id]) : new Set([...s].filter((x) => x !== d.id))))
                      }
                    />
                    {d.name}
                    <span className="muted">
                      {" "}
                      · {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
                    </span>
                  </label>
                  {d.kind === "pdf" && choice.selected?.supportsVision && (
                    <label className="check sub">
                      <input
                        type="checkbox"
                        checked={vision.has(d.id)}
                        onChange={(e) =>
                          setVision((s) => (e.target.checked ? new Set([...s, d.id]) : new Set([...s].filter((x) => x !== d.id))))
                        }
                      />
                      Read as images (for diagrams)
                    </label>
                  )}
                </li>
              ))}
          </ul>
        </fieldset>
      </details>
      <fieldset className="fieldset">
        <legend>Mode</legend>
        <div className="mode-grid">
          {(
            [
              ["automatic", "Automatic", "Extract everything in one pass per chunk."],
              ["interactive", "Interactive", "After extraction, the model asks clarifying questions you answer before review."],
            ] as const
          ).map(([id, label, desc]) => (
            <label key={id} className={"mode-card" + (mode === id ? " on" : "")}>
              <input type="radio" name="run-mode" value={id} checked={mode === id} onChange={() => setMode(id)} />
              <span className="mode-title">{label}</span>
              <span className="mode-desc">{desc}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Options</legend>
        <ul className="check-list">
          {(
            [
              [
                "incremental",
                "Add to the current graph",
                `Merge into the ${current.stats.individuals} individuals of revision ${current.number} instead of replacing them.`,
              ],
              ["relevanceScreen", "Skip unrelated parts", "A free similarity check skips parts that mention nothing the ontology covers."],
              [
                "resolveEntities",
                "Find duplicate entities",
                "Names, meaning and grounding are compared; the model only judges unclear pairs. You decide in Explore.",
              ],
              [
                "verifyEvidence",
                "Check claims against their quotes",
                "Each extracted fact is scored for whether its quote really says it; weak ones are marked for review.",
              ],
            ] as const
          ).map(([key, label, hint]) => (
            <li key={key}>
              <label className="check">
                <input type="checkbox" checked={options[key]} onChange={(e) => setOptions((o) => ({ ...o, [key]: e.target.checked }))} />
                {label}
                <span className="row-sub">{hint}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <ExperimentOptions kind="extraction" options={options} onChange={setOptions} />
      <ProviderModelSelect {...selectProps(choice)} structuredOnly />
      <p className="field-hint">
        <EstimateLine estimate={estimate.data} loading={estimate.isFetching} />
      </p>
      <p className="field-hint">
        {chunks} part{chunks === 1 ? "" : "s"} to read plus merging and checks. Each step is saved as it completes.{" "}
        {config?.features?.worker
          ? "The server keeps processing even if you close this tab."
          : "The run advances while this tab is open — if you close it, reopen the project and choose Resume."}{" "}
        Provider usage is billed by your provider; the estimate is approximate.
      </p>
      <InlineError error={create.error ?? estimate.error} />
      <BudgetRecovery error={create.error ?? estimate.error} />
      <div className="row-actions">
        <button
          className="btn"
          disabled={!selected.size || !choice.providerEnabled || !!activeRun || create.isPending}
          onClick={() => create.mutate()}
        >
          <IconPlay /> {create.isPending ? "Starting…" : "Extract knowledge"}
        </button>
        {activeRun && (
          <span className="muted">
            Finish or pause the active activity first. <Link to={`/p/${pid}/runs/${activeRun.id}`}>Open active activity →</Link>
          </span>
        )}
        {!choice.providerEnabled && (
          <p>
            Choose an enabled model. <Link to="/settings#providers">Open model connections →</Link>
          </p>
        )}
        {!selected.size && <p>Select at least one document above to extract knowledge.</p>}
      </div>
    </section>
  );
}

export function Questions({ run }: { run: RunView }) {
  const { pid, driver } = useProject();
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: (finish: boolean) => api.answer(pid, run.id, answers, finish),
    onSuccess: (r) => {
      qc.setQueryData(qk.run(pid, run.id), r);
      setAnswers({});
      driver.start(run.id);
    },
  });
  return (
    <section className="card attention" aria-labelledby="qa-title">
      <div className="card-head">
        <h3 id="qa-title">Clarification round {run.qaRound}</h3>
        <span className="file">
          {run.questions.length} question{run.questions.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="field-hint">Answer what you can; unanswered questions are skipped. Finish to go straight to review.</p>
      {run.questions.map((q, i) => (
        <div className="field" key={q.id}>
          <label htmlFor={`qa-${q.id}`}>
            {i + 1}. {q.text}
          </label>
          {q.options?.length ? (
            <div className="qa-options" role="group" aria-label="Suggested answers">
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={"qa-opt" + (answers[q.id] === o ? " on" : "")}
                  aria-pressed={answers[q.id] === o}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <input
            id={`qa-${q.id}`}
            value={answers[q.id] ?? ""}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            placeholder="Your answer"
          />
        </div>
      ))}
      <InlineError error={submit.error} />
      <div className="row-actions">
        <button className="btn ghost" onClick={() => submit.mutate(true)} disabled={submit.isPending}>
          Finish and review
        </button>
        <button
          className="btn"
          onClick={() => submit.mutate(false)}
          disabled={submit.isPending || !Object.values(answers).some((a) => a.trim())}
        >
          Submit answers <IconArrowRight />
        </button>
      </div>
    </section>
  );
}

const RELATION_TEXT = { synonym: "another name for", specialization: "a kind of", conflict: "clashes with", new: "new" } as const;
const shortName = (iri: string) => iri.replace(/^.*[#/]/, "");

/** What accepting the proposals did to the ontology and the competency questions. */
function ImpactSummary({ impact }: { impact: ImpactReport }) {
  return (
    <div className="impact">
      <div className="sec-label">Impact of the change</div>
      <ul className="finding-list">
        {impact.changes.length > 0 && <li>Changes: {impact.changes.slice(0, 20).join(", ")}</li>}
        <li>
          {impact.cq.checked
            ? impact.cq.regressions.length
              ? `${impact.cq.regressions.length} of ${impact.cq.checked} saved competency queries stopped answering: ${impact.cq.regressions.join("; ")}`
              : `All ${impact.cq.checked} saved competency queries still answer as before.`
            : "No saved competency queries to re-run."}
        </li>
        {impact.newlyUnsat.length > 0 && <li>Classes that can no longer have members: {impact.newlyUnsat.map(shortName).join(", ")}</li>}
        {impact.unintended.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * After accepted terms are committed: the facts that waited for them can be
 * replayed (no model call) and the chunks the ideas came from re-extracted
 * with the extended ontology.
 */
function CloseTheLoop({ run, scope }: { run: RunView; scope: { chunkIds: string[]; documentIds: string[]; pendingFacts: number } }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const choice = useModelChoice();
  const replay = useMutation({
    mutationFn: () => api.replayRun(pid, run.id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      navigate(`/p/${pid}/explore?rev=${r.revision.id}`);
    },
  });
  const body = {
    documentIds: scope.documentIds,
    mode: "automatic" as const,
    provider: choice.provider,
    model: choice.model,
    options: { incremental: true, onlyChunks: scope.chunkIds },
  };
  const estimate = useQuery({
    queryKey: ["reextract-estimate", pid, run.id, scope.chunkIds.join(","), choice.provider, choice.model],
    queryFn: ({ signal }) => api.estimateRun(pid, body, signal),
    enabled: scope.chunkIds.length > 0 && scope.documentIds.length > 0 && choice.providerEnabled,
    retry: false,
  });
  const reextract = useMutation({
    mutationFn: () => api.createRun(pid, body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      navigate(`/p/${pid}/runs/${r.id}`);
    },
  });
  if (!scope.pendingFacts && !scope.chunkIds.length) return null;
  return (
    <div className="banner subtle">
      <div>The ontology now has these terms. Bring the facts that needed them into the graph:</div>
      <div className="row-actions">
        {scope.pendingFacts > 0 && (
          <button
            className="btn sm"
            disabled={replay.isPending}
            onClick={() => replay.mutate()}
            title="No model call: the facts and their quotes were kept from this run"
          >
            {replay.isPending ? "Replaying…" : `Replay ${scope.pendingFacts} waiting fact${scope.pendingFacts === 1 ? "" : "s"}`}
          </button>
        )}
        {scope.chunkIds.length > 0 && scope.documentIds.length > 0 && (
          <button className="btn ghost sm" disabled={reextract.isPending || !choice.providerEnabled} onClick={() => reextract.mutate()}>
            {reextract.isPending ? "Starting…" : `Re-extract ${scope.chunkIds.length} part${scope.chunkIds.length === 1 ? "" : "s"}`}
            {estimate.data?.usd != null ? ` (≈ $${estimate.data.usd.toFixed(2)})` : ""}
          </button>
        )}
      </div>
      <InlineError error={replay.error ?? reextract.error} />
    </div>
  );
}

function Proposals({ run }: { run: RunView }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const open = (run.proposals ?? []).filter((p) => p.status === "open");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const decide = useMutation({
    mutationFn: (dismiss: boolean) => api.decideProposals(pid, run.id, dismiss ? [] : [...chosen], dismiss ? [...chosen] : []),
    onSuccess: (r) => {
      setChosen(new Set());
      qc.setQueryData(qk.run(pid, run.id), { ...run, proposals: r.proposals });
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
    },
  });
  if (!(run.proposals ?? []).length) return null;
  const toggle = (p: TermProposal, on: boolean) =>
    setChosen((s) => (on ? new Set([...s, p.id]) : new Set([...s].filter((x) => x !== p.id))));
  return (
    <section className="card" aria-labelledby="run-props">
      <div className="card-head">
        <h3 id="run-props">Missing from the ontology</h3>
        <span className="file">{open.length} open</span>
      </div>
      <p className="field-hint">
        Ideas the documents state that no class or property could express, grouped by meaning. Adding them commits a new ontology revision;
        the next run can then extract them.
      </p>
      <ul className="finding-list">
        {(run.proposals ?? []).map((p) => (
          <li key={p.id}>
            <label className="check">
              {p.status === "open" ? (
                <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p, e.target.checked)} />
              ) : (
                <StatusBadge tone={p.status === "accepted" ? "ok" : "muted"}>{p.status}</StatusBadge>
              )}
              <b>{p.name}</b>{" "}
              <span className="muted">{p.kind === "class" ? "class" : p.kind === "objectProperty" ? "relation" : "attribute"}</span>
              <span className="muted"> · asked for {p.count}×</span>
              {p.relation && p.relation !== "new" && (
                <>
                  {" "}
                  <StatusBadge
                    tone={p.relation === "conflict" ? "alert" : p.relation === "synonym" ? "warn" : "info"}
                    title={p.match ? `Closest existing term: ${p.match.uri} (${p.match.score})` : undefined}
                  >
                    {RELATION_TEXT[p.relation]}
                    {p.match ? ` ${shortName(p.match.uri)}` : ""}
                  </StatusBadge>
                </>
              )}
            </label>
            <div>{p.definition}</div>
            <div className="row-sub">
              {p.parent ? `under ${p.parent}` : ""}
              {p.domain ? ` ${p.domain} →` : ""}
              {p.range ? ` ${p.range}` : ""}
              {p.variants.length ? ` · also called ${p.variants.join(", ")}` : ""}
            </div>
            {p.examples.map((e, i) => (
              <blockquote key={i} className="quote">
                {e.quote}
              </blockquote>
            ))}
          </li>
        ))}
      </ul>
      <InlineError error={decide.error} />
      {decide.data && !decide.data.committed && decide.data.revision && (
        <div className="banner warn">
          The additions were not committed ({decide.data.issues.join("; ")}). They are in a draft —{" "}
          <Link to={`/p/${pid}/ontology?tab=history`}>fix it on the Ontology page</Link>.
        </div>
      )}
      {decide.data?.impact && <ImpactSummary impact={decide.data.impact} />}
      {decide.data?.committed && decide.data.reextract && <CloseTheLoop run={run} scope={decide.data.reextract} />}
      {decide.data?.committed && <div className="banner subtle">Added to the ontology as revision {decide.data.revision?.number}.</div>}
      <div className="row-actions">
        <button className="btn sm" disabled={!chosen.size || decide.isPending} onClick={() => decide.mutate(false)}>
          Add {chosen.size || ""} to the ontology
        </button>
        <button className="btn ghost sm" disabled={!chosen.size || decide.isPending} onClick={() => decide.mutate(true)}>
          Dismiss
        </button>
      </div>
    </section>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { pid, driver, activeRun } = useProject();
  const [inspecting, setInspecting] = useState(false);
  const { config } = useAuth();
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: qk.run(pid, runId),
    queryFn: () => api.getRun(pid, runId),
    refetchInterval: (q) => (q.state.data && ["running", "queued"].includes(q.state.data.status) && !driver.driving ? 10_000 : false),
  });
  const resultId = run.data?.resultRevisionId;
  const result = useQuery({
    queryKey: qk.revision(pid, resultId ?? "no-result"),
    queryFn: () => api.getRevision(pid, resultId!),
    enabled: run.data?.status === "ready_for_review" && !!resultId,
    retry: false,
    refetchInterval: run.data?.status === "ready_for_review" && resultId ? 10000 : false,
    refetchOnMount: "always",
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(pid, runId),
    onSuccess: (r) => {
      if (driver.runId === runId) driver.stop();
      qc.setQueryData(qk.run(pid, runId), r);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
    },
  });
  const pause = useMutation({
    mutationFn: () => api.pauseRun(pid, runId),
    onSuccess: (r) => {
      if (driver.runId === runId) driver.stop();
      qc.setQueryData(qk.run(pid, runId), r);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
    },
  });
  const retry = useMutation({
    mutationFn: () => api.retryRun(pid, runId),
    onSuccess: (r) => {
      qc.setQueryData(qk.run(pid, runId), r);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      if (r.status === "running") driver.start(runId);
    },
  });

  if (run.isLoading) return <LoadingState label="Loading run…" />;
  if (run.error || !run.data) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  const driving = driver.runId === r.id;
  const total = r.steps.length;
  const pct = Math.min(100, Math.round((r.completedSteps / Math.max(1, total)) * 100));
  const active = r.status === "running" || r.status === "queued";
  const outcome = runOutcome(
    r,
    result.data,
    result.isLoading
      ? "loading"
      : result.error instanceof ApiError && result.error.status === 404
        ? "missing"
        : result.error
          ? "error"
          : "ready",
  );
  const copy = outcomeCopy[outcome];
  const anotherActive = activeRun && activeRun.id !== r.id;
  const resultHref =
    r.kind === "alignment" && outcome === "draft"
      ? `/p/${pid}/workflows/alignment?step=merge&rev=${resultId}&run=${r.id}`
      : r.kind === "induction" || r.kind === "alignment"
        ? `/p/${pid}/ontology?tab=${outcome === "saved" ? "terms" : "review"}&rev=${resultId}`
        : `/p/${pid}/explore?rev=${resultId}`;

  return (
    <div className="run-detail">
      <section className="card run-summary" aria-labelledby="run-title">
        <div className="card-head">
          <span className="run-eyebrow">
            {runKindLabel(r.kind)} · {r.mode === "interactive" ? "Interactive" : "Automatic"}
          </span>
          {outcome === "saved" ? (
            <StatusBadge tone="ok">Saved version {result.data?.number}</StatusBadge>
          ) : outcome === "draft" ? (
            <StatusBadge tone="ok">Draft ready</StatusBadge>
          ) : outcome === "missing" || outcome === "unavailable" ? (
            <StatusBadge tone="warn">Result unavailable</StatusBadge>
          ) : (
            <RunStatusBadge status={r.status} resumable={r.resumable && !driving} />
          )}
        </div>
        <h2 id="run-title">{copy.title}</h2>
        <p className="run-summary-description">{copy.description}</p>
        <dl className="run-summary-facts">
          <div>
            <dt>Source documents</dt>
            <dd>{r.documentIds.length}</dd>
          </div>
          <div>
            <dt>Steps completed</dt>
            <dd>
              {r.completedSteps}
              <span> / {total}</span>
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd className="run-model">
              {r.model}
              <small>{r.provider}</small>
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd className="run-started">
              {fmtDate(r.createdAt)}
              <small>{new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
            </dd>
          </div>
        </dl>
        <div className="run-progress-label">
          <span>{active && r.nextStep ? r.nextStep.label : `${r.completedSteps} of ${total} steps saved`}</span>
          <strong>{pct}%</strong>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={r.completedSteps}
          aria-label="Run progress"
        >
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
        {driver.error && driving && <div className="banner error">{driver.error}</div>}
        {r.error && <div className={"banner " + (r.status === "failed" ? "error" : "subtle")}>{r.error}</div>}
        <div className="row-actions">
          {active && !driving && r.resumable && !config?.features?.worker && (
            <button className="btn" onClick={() => driver.start(r.id)}>
              <IconPlay /> {r.completedSteps > 0 || r.status === "running" ? "Continue processing" : "Start processing"}
            </button>
          )}
          {active && (driving || !r.resumable || config?.features?.worker) && (
            <a className="btn" href="#run-stages-title">
              View progress
            </a>
          )}
          {r.status === "awaiting_answers" && (
            <a className="btn" href="#qa-title">
              Answer questions
            </a>
          )}
          {driving && (
            <span className="busy-note">
              <span className="spinner sm" aria-hidden="true" /> Processing {r.nextStep?.label ?? "…"}
            </span>
          )}
          {active && (
            <button className="btn ghost" disabled={pause.isPending} onClick={() => pause.mutate()}>
              {pause.isPending ? "Pausing…" : "Pause"}
            </button>
          )}
          {pause.error && <InlineError error={pause.error} />}
          {(active || r.status === "awaiting_answers" || r.status === "paused") && (
            <button className="btn ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel run
            </button>
          )}
          {(r.status === "failed" || r.status === "cancelled" || r.status === "paused") && (
            <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending || !!anotherActive}>
              {retry.isPending ? "Resuming…" : r.status === "paused" ? "Resume processing" : "Retry unfinished work"}
            </button>
          )}
          {(outcome === "draft" || outcome === "saved") && (
            <Link className="btn" to={resultHref}>
              {outcome === "saved" ? "Open saved version" : "Review draft"} <IconArrowRight />
            </Link>
          )}
          {outcome === "missing" && (
            <button className="btn" onClick={() => setInspecting(true)}>
              View recorded processing details
            </button>
          )}
          {outcome === "unavailable" && (
            <button className="btn" onClick={() => void result.refetch()}>
              Retry loading result
            </button>
          )}
          {anotherActive && ["failed", "paused", "cancelled"].includes(r.status) && (
            <p>
              Finish or pause the active activity before retrying. <Link to={`/p/${pid}/runs/${activeRun.id}`}>Open active activity →</Link>
            </p>
          )}
        </div>
        <div className="run-inspection-actions">
          <button
            className="btn ghost sm"
            aria-expanded={inspecting}
            aria-controls={`run-technical-${runId}`}
            onClick={() => setInspecting(!inspecting)}
          >
            {inspecting ? "Hide processing details" : "Processing details"}
          </button>
          <details className="run-usage">
            <summary>Token usage & configuration</summary>
            <dl>
              <div>
                <dt>Input tokens</dt>
                <dd>{r.usage.inputTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Output tokens</dt>
                <dd>{r.usage.outputTokens.toLocaleString()}</dd>
              </div>
              {r.requirementsSnapshot && (
                <div>
                  <dt>Requirements</dt>
                  <dd>Version {r.requirementsSnapshot.version}</dd>
                </div>
              )}
              {r.cost?.actualUsd != null && (
                <div>
                  <dt>Estimated spend</dt>
                  <dd>${r.cost.actualUsd.toFixed(2)}</dd>
                </div>
              )}
              {r.cost?.estimatedUsd != null && (
                <div>
                  <dt>Original estimate</dt>
                  <dd>${r.cost.estimatedUsd.toFixed(2)}</dd>
                </div>
              )}
              {!!r.cached && (
                <div>
                  <dt>Steps reused from cache</dt>
                  <dd>{r.cached}</dd>
                </div>
              )}
              {!!r.skipped && (
                <div>
                  <dt>Unrelated steps skipped</dt>
                  <dd>{r.skipped}</dd>
                </div>
              )}
            </dl>
          </details>
        </div>
        <InlineError error={cancel.error ?? retry.error} />
        <BudgetRecovery error={r.error ?? retry.error} />
      </section>

      {inspecting && (
        <section id={`run-technical-${runId}`} className="card" aria-label="Run methods, inputs and stage results">
          <RunInspector pid={pid} runId={runId} compact />
        </section>
      )}

      {r.status === "awaiting_answers" && <Questions run={r} />}
      {outcome === "draft" && r.kind !== "induction" && r.kind !== "alignment" && !!r.proposals?.length && (
        <details className="card">
          <summary>Advanced: extend the ontology and replay extraction</summary>
          <Proposals run={r} />
        </details>
      )}

      <RunStages run={r} />
      {(r.clarifications.length > 0 || r.notes.length > 0) && (
        <section className="card run-notes" aria-label="Run notes and clarifications">
          {r.clarifications.length > 0 && (
            <details>
              <summary>{r.clarifications.length} answered clarification(s)</summary>
              <ul>
                {r.clarifications.map((c, i) => (
                  <li key={i}>
                    <b>{c.question}</b> — {c.answer}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {r.notes.length > 0 && (
            <details>
              <summary>
                {r.notes.length} note{r.notes.length === 1 ? "" : "s"}
              </summary>
              <ul className="notes">
                {r.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

export default function RunsPage() {
  const { pid, driver } = useProject();
  const { runId } = useParams();
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const list = runs.data ?? [];
  const selected = list.find((run) => run.id === runId);
  if (!runId) return <Navigate to={`/p/${pid}/activity`} replace />;

  return (
    <div className="page run-page">
      <div className="page-wide">
        <Link className="run-back-link" to={`/p/${pid}/activity`}>
          ← All activity
        </Link>
        <PageHead
          title={selected ? runKindLabel(selected.kind) : "Activity details"}
          actions={
            selected?.kind === "induction" ? (
              <Link className="btn ghost" to={`/p/${pid}/workflows/tbox`}>
                Build & sources →
              </Link>
            ) : selected?.kind === "alignment" ? (
              <Link className="btn ghost" to={`/p/${pid}/workflows/alignment`}>
                Alignment workspace →
              </Link>
            ) : (
              <Link className="btn ghost" to={`/p/${pid}/graphs`}>
                Knowledge graphs →
              </Link>
            )
          }
        >
          Progress, results and recorded inputs for this activity.
        </PageHead>

        <div className={`runs-layout${list.length <= 1 ? " is-single" : ""}`}>
          <div className="runs-main">
            <RunDetail key={runId} runId={runId} />
          </div>
          {list.length > 1 && (
            <nav className="runs-list card" aria-label="Run history">
              <div className="card-head">
                <h3>Project runs</h3>
              </div>
              <ul>
                {list.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/p/${pid}/runs/${r.id}`}
                      className={"run-link" + ((runId ?? list[0].id) === r.id ? " is-active" : "")}
                      aria-current={(runId ?? list[0].id) === r.id ? "page" : undefined}
                    >
                      <span className="grow">
                        {fmtDate(r.createdAt)}
                        <span className="row-sub">
                          {r.kind === "alignment" ? "alignment · " : r.kind === "induction" ? "ontology · " : ""}
                          {r.kind === "alignment"
                            ? `${r.alignment?.estimate.processedSourceTerms ?? "?"} source terms`
                            : `${r.documentIds.length} documents`}{" "}
                          · {r.model}
                        </span>
                      </span>
                      <RunStatusBadge status={r.status} resumable={r.resumable && driver.runId !== r.id} />
                    </Link>
                  </li>
                ))}
              </ul>
              {runs.error && <StatusBadge tone="alert">Could not refresh</StatusBadge>}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
