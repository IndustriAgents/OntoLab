import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { api, qk } from "../../lib/projectApi";
import { corpusApi, type CorpusDetail } from "../../lib/corpusApi";
import type { CorpusPlan, CorpusUpdateMode } from "../../types/corpus";
import { corpusChanges } from "../../lib/corpusGraph";
import { InlineError, LoadingState, Modal, StatusBadge } from "../../components/ui/ui";
import { RunInspector } from "../research/RunInspector";
import { BudgetRecovery } from "../runs/BudgetRecovery";
import { Questions } from "../runs/RunsPage";
import { CorpusReview } from "./CorpusReview";
import { corpusPlanSummary, corpusRunStage } from "../../lib/corpusWorkflow";
const active = (s: string) => ["queued", "running", "awaiting_answers"].includes(s);
export function CorpusUpdates({
  pid,
  detail,
  plan,
  planLoading,
  mode,
  onMode,
  selected,
  refresh,
  onStart,
  startPending,
}: {
  pid: string;
  detail: CorpusDetail;
  plan?: CorpusPlan;
  planLoading: boolean;
  mode: CorpusUpdateMode;
  onMode: (m: CorpusUpdateMode) => void;
  selected: string[];
  refresh: () => void;
  onStart: () => void;
  startPending: boolean;
}) {
  const { driver, activeRun, select } = useProject(),
    { config } = useAuth(),
    qc = useQueryClient(),
    [params, setParams] = useSearchParams();
  const history = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid), refetchInterval: 5000 });
  const runId = params.get("run") ?? activeRun?.id ?? null,
    rid = params.get("rev");
  const run = useQuery({
    queryKey: qk.run(pid, runId ?? "none"),
    queryFn: () => api.getRun(pid, runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && active(q.state.data.status) ? 1500 : false),
  });
  useEffect(() => {
    if (run.data?.status === "ready_for_review" && run.data.resultRevisionId && !rid) {
      select(run.data.resultRevisionId);
      refresh();
    }
  }, [run.data?.status, run.data?.resultRevisionId, rid, select, refresh]);
  const control = useMutation({
    mutationFn: async (action: "retry" | "cancel" | "pause") => {
      if (action === "cancel") {
        if (driver.runId === runId) driver.stop();
        return api.cancelRun(pid, runId!);
      }
      if (action === "pause") return api.pauseRun(pid, runId!);
      return api.retryRun(pid, runId!);
    },
    onSuccess: (r) => {
      if (r.status === "paused") {
        if (driver.runId === r.id) driver.stop();
        setParams((p) => {
          const next = new URLSearchParams(p);
          next.set("run", r.id);
          return next;
        });
      }
      qc.setQueryData(qk.run(pid, r.id), r);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      if (active(r.status) && !config?.features?.worker) driver.start(r.id);
      refresh();
    },
  });
  const prepare = useMutation({
    mutationFn: async () => {
      for (const source of plan?.sources.filter(
        (s) => !s.member.removed && s.document?.parseState === "parsed" && s.status !== "included",
      ) ?? [])
        await corpusApi.prepare(pid, source.member.id);
    },
    onSuccess: refresh,
  });
  const graphDrafts = detail.revisions.filter((r) => r.status === "draft" && r.parentId === detail.graph.id);
  const r = run.data,
    done = new Set(r?.completedStepKeys ?? []),
    passages = r?.steps.filter((s) => s.kind === "chunk" || s.kind === "vision") ?? [],
    completed = passages.filter((s) => done.has(s.key)).length,
    currentStage = r?.steps.find((s) => s.kind !== "finalize" && !done.has(s.key));
  const upToDate =
    plan && !plan.processDocumentIds.length && !plan.removeDocumentIds.length && plan.ontology.hash === plan.currentOntology.hash;
  const otherDrafts = graphDrafts.filter((d) => d.id !== rid && d.id !== r?.resultRevisionId);
  return (
    <div className="corpus-stack">
      {rid && <CorpusReview key={rid} pid={pid} revisionId={rid} refresh={refresh} />}
      {!!history.data?.length && (
        <details className="card corpus-run-history">
          <summary>
            Extraction history · {history.data.length} update{history.data.length === 1 ? "" : "s"}
          </summary>
          <div className="corpus-version-list">
            {history.data.map((r) => (
              <Link key={r.id} className="corpus-version" to={`/p/${pid}/graph?tab=updates&run=${r.id}`}>
                <span>
                  {new Date(r.createdAt).toLocaleString()} · {r.documentIds.length} sources
                </span>
                <StatusBadge tone={active(r.status) ? "info" : r.status === "failed" ? "warn" : "muted"}>
                  {r.status.replaceAll("_", " ")}
                </StatusBadge>
              </Link>
            ))}
          </div>
        </details>
      )}
      {!rid && r && (
        <section className="card corpus-run-progress">
          <div className="corpus-run-stage">
            <div>
              <h2>
                {r.status === "ready_for_review"
                  ? "Ready for review"
                  : r.status === "failed"
                    ? "Extraction needs attention"
                    : r.status === "cancelled"
                      ? "Update cancelled"
                      : r.status === "awaiting_answers"
                        ? "Waiting for answers"
                        : driver.driving || !r.resumable
                          ? "Extracting knowledge"
                          : config?.features?.worker
                            ? "Waiting for background processing"
                            : "Extraction paused"}
              </h2>
              <p>Your saved graph remains available. Completed work is retained if this update is interrupted.</p>
            </div>
            <StatusBadge tone={r.status === "failed" ? "alert" : r.status === "ready_for_review" ? "ok" : "info"}>
              {r.status.replaceAll("_", " ")}
            </StatusBadge>
          </div>
          <progress max={Math.max(1, passages.length)} value={completed} aria-label="Extraction passage progress" />
          {currentStage && (
            <p>
              {r.status === "failed" ? "Stopped while" : "Current stage"}: <strong>{corpusRunStage(currentStage.kind)}</strong>
            </p>
          )}
          <p className="field-hint">
            {config?.features?.worker
              ? "Processing continues on the server; you can leave this page."
              : "This tab advances extraction. Closing it pauses advancement after the current request. Completed steps are retained."}
          </p>
          <div className="row-actions">
            {r.status === "failed" || r.status === "cancelled" || r.status === "paused" ? (
              <button className="btn" disabled={control.isPending} onClick={() => control.mutate("retry")}>
                {r.status === "paused" ? "Resume extraction" : "Retry unfinished work"}
              </button>
            ) : (
              active(r.status) && (
                <>
                  <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("pause")}>
                    Pause after current step
                  </button>
                  {!config?.features?.worker && !driver.driving && (
                    <button className="btn" onClick={() => driver.start(r.id)}>
                      Continue extraction
                    </button>
                  )}
                </>
              )
            )}
            {active(r.status) && (
              <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("cancel")}>
                Cancel update
              </button>
            )}
            {r.resultRevisionId && (
              <Link className="btn" to={`/p/${pid}/graph?tab=updates&rev=${r.resultRevisionId}`}>
                Review graph changes →
              </Link>
            )}
          </div>
          {r.error && (
            <div className="banner error" role="alert">
              {r.error}
            </div>
          )}
          <BudgetRecovery error={r.error ?? control.error} />
          <InlineError error={control.error ?? (driver.error ? Error(driver.error) : null)} />
          {r.status === "awaiting_answers" && <Questions run={r} />}
          <details className="method-details">
            <summary>Technical progress and saved stages</summary>
            <div className="method-details-body">
              <p>
                {completed} / {passages.length} passages completed · {r.cached ?? 0} cached steps · {r.skipped ?? 0} screened passages
              </p>
              <RunInspector key={r.id} pid={pid} runId={r.id} compact />
            </div>
          </details>
          {!!r.proposals?.length && (
            <p className="banner warn">
              Some claims need terms the ontology does not yet provide.{" "}
              <Link to={`/p/${detail.corpus.settings.corpus!.parentProjectId}/ontology`}>Improve the ontology</Link>, then choose its saved
              version in corpus settings and update affected sources.
            </p>
          )}
        </section>
      )}
      {!rid && !r && (
        <section className="card corpus-update-plan">
          <h2>{upToDate ? "Knowledge graph is up to date" : "Update knowledge graph"}</h2>
          <p>{plan ? corpusPlanSummary(plan) : "Checking document changes…"}</p>
          <p className="field-hint">Existing entities and review decisions are kept. Your saved graph changes after review and saving.</p>
          {!plan && <LoadingState label="Checking documents…" />}
          {plan?.estimatedUsd != null && <p>Estimated processing cost: ${plan.estimatedUsd.toFixed(2)}</p>}
          {plan?.warnings.map((w) => (
            <p className="banner warn" key={w}>
              {w}
            </p>
          ))}
          {plan?.errors.map((e) => (
            <p className="banner error" key={e}>
              {e}
            </p>
          ))}
          {!!plan?.errors.length && (
            <div className="row-actions">
              <Link className="btn ghost" to={`/p/${pid}/graph?tab=settings`}>
                Check preparation settings
              </Link>
              <button className="btn ghost" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
                {prepare.isPending ? "Preparing documents…" : "Retry document preparation"}
              </button>
            </div>
          )}
          <div className="row-actions">
            <button
              className="btn"
              disabled={!plan || upToDate || planLoading || startPending || !!plan.errors.length || !!graphDrafts.length}
              onClick={onStart}
            >
              {startPending
                ? "Starting update…"
                : upToDate
                  ? "Everything is up to date"
                  : (detail.graph.number ?? 0) > 0
                    ? "Update knowledge graph"
                    : "Create knowledge graph"}
            </button>
            <Link to={`/p/${pid}/graph`}>Back to documents</Link>
          </div>
          <details className="method-details">
            <summary>Advanced update options and processing details</summary>
            <div className="method-details-body">
              <label className="field">
                <span>Update mode</span>
                <select value={mode} onChange={(e) => onMode(e.target.value as CorpusUpdateMode)}>
                  <option value="changes">Process new and replaced documents</option>
                  <option value="reprocess">Reprocess selected documents · {selected.length} selected</option>
                  <option value="rebuild">Rebuild from all active documents</option>
                </select>
              </label>
              {mode === "reprocess" && !selected.length && <p>Select documents in their details to reprocess them.</p>}
              {plan && (
                <>
                  <p>
                    Model: {detail.corpus.settings.provider} / {detail.corpus.settings.model}. {plan.calls} estimated calls ·{" "}
                    {plan.inputTokens.toLocaleString()} input / {plan.outputTokens.toLocaleString()} output tokens.
                  </p>
                  <ul className="corpus-plan-sources">
                    {plan.sources
                      .filter((s) => s.status !== "removed")
                      .map((s) => (
                        <li key={s.member.id}>
                          <span>
                            <strong>{s.member.name}</strong>
                            <br />
                            {s.reason}
                          </span>
                          <StatusBadge tone={s.status === "included" ? "ok" : "info"}>
                            {s.status === "included" ? "Reuse" : s.member.removed ? "Remove support" : "Process"}
                          </StatusBadge>
                        </li>
                      ))}
                  </ul>
                </>
              )}
              <button className="btn ghost sm" onClick={refresh}>
                Refresh processing details
              </button>
            </div>
          </details>
        </section>
      )}
      {!!otherDrafts.length && (
        <section className="card">
          <h3>Draft updates</h3>
          {otherDrafts.map((d) => (
            <div className="corpus-history-row" key={d.id}>
              <div>
                <h3>{d.summary}</h3>
                <p>
                  {new Date(d.createdAt).toLocaleString()} · {d.stats.individuals} entities
                </p>
              </div>
              <Link className="btn ghost sm" to={`/p/${pid}/graph?tab=updates&rev=${d.id}`}>
                Review draft
              </Link>
            </div>
          ))}
        </section>
      )}
      <InlineError error={run.error ?? prepare.error} />
    </div>
  );
}
export function CorpusHistory({ pid, detail, refresh }: { pid: string; detail: CorpusDetail; refresh: () => void }) {
  const qc = useQueryClient(),
    versions = detail.revisions.filter((r) => r.status === "committed").sort((a, b) => (b.number ?? 0) - (a.number ?? 0)),
    drafts = detail.revisions.filter((r) => r.status === "draft").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [from, setFrom] = useState(versions[1]?.id ?? versions[0]?.id ?? ""),
    [to, setTo] = useState(versions[0]?.id ?? ""),
    [restore, setRestore] = useState<string | null>(null);
  const a = useQuery({ queryKey: qk.revision(pid, from), queryFn: () => api.getRevision(pid, from), enabled: !!from }),
    b = useQuery({ queryKey: qk.revision(pid, to), queryFn: () => api.getRevision(pid, to), enabled: !!to });
  const compare =
    a.data && b.data ? corpusChanges(a.data.content.abox ?? { individuals: [] }, b.data.content.abox ?? { individuals: [] }) : null;
  const restoring = useMutation({
    mutationFn: () => api.restore(pid, restore!),
    onSuccess: () => {
      setRestore(null);
      refresh();
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
    },
  });
  const download = useMutation({ mutationFn: (id: string) => api.downloadTurtle(pid, id, "combined", true, "source") });
  return (
    <div className="corpus-stack">
      <section className="card">
        <h2>Compare saved graph versions</h2>
        {from && to && from !== to && (
          <Link
            className="btn ghost"
            to={`/p/${pid}/evaluate?new=1&baseline=${encodeURIComponent(from)}&candidate=${encodeURIComponent(to)}`}
          >
            Compare answers on these versions
          </Link>
        )}
        <div className="corpus-form">
          <label className="field">
            <span>From graph version</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {Math.max(0, v.number ?? 0)} · {v.summary}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>To graph version</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {Math.max(0, v.number ?? 0)} · {v.summary}
                </option>
              ))}
            </select>
          </label>
        </div>
        {compare && (
          <>
            <div className="corpus-plan-stats">
              <div>
                New entities<strong>{compare.addedEntities.length}</strong>
              </div>
              <div>
                Added facts<strong>{compare.added.length}</strong>
              </div>
              <div>
                Removed facts<strong>{compare.removed.length}</strong>
              </div>
              <div>
                Source support added<strong>{compare.enriched.length}</strong>
              </div>
              {!!compare.reduced.length && (
                <div>
                  Source support reduced<strong>{compare.reduced.length}</strong>
                </div>
              )}
              {!!compare.reviewed.length && (
                <div>
                  Review decisions changed<strong>{compare.reviewed.length}</strong>
                </div>
              )}
            </div>
            <p className="field-hint">
              Ontology: version {a.data?.content.corpus?.ontology.number} → {b.data?.content.corpus?.ontology.number}. Source versions:{" "}
              {a.data?.content.corpus?.sources.length ?? 0} → {b.data?.content.corpus?.sources.length ?? 0}.
            </p>
          </>
        )}
      </section>
      <section className="card">
        <h2>Graph version history</h2>
        {versions.map((v) => (
          <div className="corpus-history-row" key={v.id}>
            <div>
              <h3>
                Graph version {Math.max(0, v.number ?? 0)} {v.id === detail.graph.id && <StatusBadge tone="ok">Current</StatusBadge>}
              </h3>
              <p>{v.summary}</p>
              <p>
                {v.stats.acceptedIndividuals ?? v.stats.individuals} published entities ·{" "}
                {new Date(v.committedAt ?? v.createdAt).toLocaleString()}
              </p>
            </div>
            <div className="row-actions">
              <Link className="btn ghost sm" to={`/p/${pid}/graph?tab=updates&rev=${v.id}`}>
                Inspect version
              </Link>
              <button className="btn ghost sm" disabled={download.isPending} onClick={() => download.mutate(v.id)}>
                Download
              </button>
              {v.id !== detail.graph.id && (
                <button className="btn ghost sm" onClick={() => setRestore(v.id)}>
                  Restore as new version
                </button>
              )}
            </div>
          </div>
        ))}
      </section>
      {!!drafts.length && (
        <section className="card">
          <h2>Preserved drafts</h2>
          {drafts.map((draft) => (
            <div className="corpus-history-row" key={draft.id}>
              <div>
                <h3>{draft.summary}</h3>
                <p>
                  {draft.parentId === detail.graph.id
                    ? "Based on the current graph version."
                    : "Based on an earlier graph version; prepare a new update before saving."}
                </p>
              </div>
              <Link className="btn ghost sm" to={`/p/${pid}/graph?tab=updates&rev=${draft.id}`}>
                Review preserved draft
              </Link>
            </div>
          ))}
        </section>
      )}
      <InlineError error={a.error ?? b.error ?? download.error} />
      {restore && (
        <Modal
          title="Restore graph version"
          onClose={() => setRestore(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRestore(null)}>
                Cancel
              </button>
              <button className="btn" disabled={restoring.isPending} onClick={() => restoring.mutate()}>
                {restoring.isPending ? "Restoring…" : "Restore as new graph version"}
              </button>
            </>
          }
        >
          <p>
            This saves a new current graph version with the selected version's ontology, facts and review decisions. All existing versions
            remain in history.
          </p>
          <p>
            The graph workspace keeps its current document membership and preparation defaults. The next extraction plan will show source
            changes and ontology upgrades still pending.
          </p>
          <InlineError error={restoring.error} />
        </Modal>
      )}
    </div>
  );
}
