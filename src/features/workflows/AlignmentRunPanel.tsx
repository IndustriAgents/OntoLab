import { BudgetRecovery } from "../runs/BudgetRecovery";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { api, qk } from "../../lib/projectApi";
import { InlineError } from "../../components/ui/ui";
import { RunStatusBadge } from "../runs/RunStatusBadge";
import { revisionLabel } from "../revisions/RevisionBar";
import type { RunView } from "../../types/project";

export function AlignmentRunPanel({ onReview }: { onReview: (revisionId: string) => Promise<void> }) {
  const { pid, selectedId, revisions, driver, working } = useProject();
  const { config } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const history = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid), refetchInterval: 5000 });
  const list = (history.data ?? []).filter((r) => r.kind === "alignment");
  const id =
    params.get("run") ??
    list.find((r) => ["queued", "running", "paused"].includes(r.status))?.id ??
    list.find((r) => r.resultRevisionId === selectedId)?.id ??
    list[0]?.id;
  const query = useQuery({
    queryKey: qk.run(pid, id ?? "none"),
    queryFn: () => api.getRun(pid, id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && (["queued", "running"].includes(q.state.data.status) || q.state.data.lease) ? 1500 : false),
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") =>
      action === "pause" ? api.pauseRun(pid, id!) : action === "cancel" ? api.cancelRun(pid, id!) : api.retryRun(pid, id!),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(pid, run.id), run);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      if (["paused", "cancelled"].includes(run.status) && driver.runId === run.id) driver.stop();
      if (run.status === "running" && !config?.features?.worker) driver.start(run.id);
    },
  });
  const review = useMutation({
    mutationFn: async (revisionId: string) => {
      await working.flush();
      await onReview(revisionId);
    },
  });
  const run = query.data;
  useEffect(() => {
    if (run) qc.setQueryData<RunView[]>(qk.runs(pid), (list) => list?.map((entry) => (entry.id === run.id ? run : entry)));
  }, [run, pid, qc]);
  if (!id && !history.error) return null;
  const active = !!run && ["queued", "running"].includes(run.status);
  const finishing = !!run?.lease && new Date(run.lease.expiresAt).getTime() > Date.now();
  const sourceRevision = revisions.find((r) => r.id === run?.baseRevisionId);
  const panel = (
    <section className="card alignment-run" aria-label="Alignment run">
      <div className="card-head">
        <h3>Alignment run</h3>
        {run && <RunStatusBadge status={run.status} />}
      </div>
      {list.length > 0 && (
        <label className="field">
          <span>Run history</span>
          <select
            value={id}
            onChange={(e) =>
              setParams((old) => {
                const next = new URLSearchParams(old);
                const selected = list.find((r) => r.id === e.target.value);
                next.set("run", e.target.value);
                const revisionId = selected?.resultRevisionId ?? selected?.baseRevisionId;
                if (revisionId) next.set("rev", revisionId);
                else next.delete("rev");
                next.set("step", selected?.resultRevisionId ? "merge" : "match");
                return next;
              })
            }
          >
            {list.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.createdAt).toLocaleString()} · {r.status.replaceAll("_", " ")} ·{" "}
                {r.alignment?.estimate.processedSourceTerms ?? "?"} source terms
              </option>
            ))}
          </select>
        </label>
      )}
      <InlineError error={query.error ?? history.error ?? control.error ?? review.error ?? (driver.runId === id ? driver.error : null)} />
      {run?.kind === "alignment" && (
        <>
          <p className="muted">
            {sourceRevision ? revisionLabel(sourceRevision) : "Saved inputs"} ·{" "}
            {run.alignment?.setup.verify ? `${run.provider} / ${run.model}` : "Similarity matching without model classification"}
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-label="Alignment progress"
            aria-valuemin={0}
            aria-valuemax={run.steps.length}
            aria-valuenow={run.completedSteps}
          >
            <div className="progress-bar" style={{ width: `${(100 * run.completedSteps) / Math.max(1, run.steps.length)}%` }} />
          </div>
          <p role="status">
            {run.completedSteps} of {run.steps.length} steps saved{active && run.nextStep ? ` · ${run.nextStep.label}` : ""}.
            {run.status === "paused" &&
              (finishing ? " Pausing after the current step finishes saving." : " Paused. Resume continues from saved checkpoints.")}
            {run.status === "ready_for_review" && " Your mapping review draft is ready."}
          </p>
          <p className="muted">
            Generation cost: {run.cost?.actualUsd == null ? "price unavailable" : `≈ $${run.cost.actualUsd.toFixed(4)} spent`}
            {run.cost?.estimatedUsd != null ? ` · estimated ≈ $${run.cost.estimatedUsd.toFixed(4)}` : ""} ·{" "}
            {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens.
            {run.alignment?.estimate.embeddingCostExcluded && " Embedding API charges are additional and are not tracked here."}
          </p>
          <p className="muted">
            {config?.features?.worker
              ? "Runs continue on the server while you navigate away or close this tab. Keep the server or desktop app running."
              : "This server has no background worker. Keep this project tab open while processing; saved checkpoints let you continue after reopening."}{" "}
            Pausing lets an in-flight step finish; completed batches are kept.
          </p>
          <p className="muted">
            Inputs and existing decisions were copied when this run started. Later edits stay in their original draft.
          </p>
          {run.error && (
            <p className="banner error" role="alert">
              {run.error}
            </p>
          )}
          <BudgetRecovery error={run.error ?? control.error} />
          <div className="row-actions">
            {active && (
              <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("pause")}>
                Pause
              </button>
            )}
            {active && !config?.features?.worker && driver.runId !== run.id && (
              <button className="btn" disabled={control.isPending} onClick={() => driver.start(run.id)}>
                Continue processing
              </button>
            )}
            {["paused", "failed", "cancelled"].includes(run.status) && (
              <button className="btn" disabled={control.isPending || finishing} onClick={() => control.mutate("resume")}>
                {run.status === "paused" ? "Resume" : "Retry from last checkpoint"}
              </button>
            )}
            {(active || run.status === "paused") && (
              <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("cancel")}>
                Cancel run
              </button>
            )}
            {run.status === "ready_for_review" && run.resultRevisionId && (
              <button className="btn" disabled={review.isPending} onClick={() => review.mutate(run.resultRevisionId!)}>
                Review mappings
              </button>
            )}
            <Link className="btn ghost" to={`/p/${pid}/runs/${run.id}`}>
              Run details
            </Link>
          </div>
          <details className="method-details">
            <summary>Saved processing steps</summary>
            <div className="method-details-body">
              <ol>
                {run.steps.map((s) => (
                  <li key={s.key}>
                    {run.completedStepKeys?.includes(s.key) || run.status === "ready_for_review" ? "✓ " : ""}
                    {s.label}
                  </li>
                ))}
              </ol>
            </div>
          </details>
        </>
      )}
    </section>
  );
  return run?.status === "ready_for_review" && run.resultRevisionId === selectedId && params.get("step") !== "match" ? (
    <details className="method-details">
      <summary>Alignment complete · {run.alignment?.estimate.processedSourceTerms ?? 0} source terms · run details</summary>
      <div className="method-details-body">{panel}</div>
    </details>
  ) : (
    panel
  );
}
