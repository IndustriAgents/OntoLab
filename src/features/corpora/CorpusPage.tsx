import { BudgetRecovery } from "../runs/BudgetRecovery";
import { useState, useCallback } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { qk } from "../../lib/projectApi";
import type { CorpusUpdateMode } from "../../types/corpus";
import { PageHead, LoadingState, InlineError, ErrorState } from "../../components/ui/ui";
import { CorpusDocuments } from "./CorpusDocuments";
import { CorpusSettings } from "./CorpusSettings";
import { CorpusUpdates, CorpusHistory } from "./CorpusUpdates";
import { corpusPlanSummary, corpusRunStage } from "../../lib/corpusWorkflow";
import { graphTab } from "../../app/navigation";
import "../research/research.css";
import "./corpora.css";
export default function CorpusPage() {
  const { pid, project, activeRun, driver } = useProject(),
    { config } = useAuth(),
    qc = useQueryClient(),
    [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<CorpusUpdateMode>("changes"),
    [selected, setSelected] = useState<string[]>([]);
  const tab = graphTab(params.toString());
  const detail = useQuery({
    queryKey: corpusKeys.detail(pid),
    queryFn: () => corpusApi.detail(pid),
    enabled: !!project?.settings.corpus,
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.parseState === "pending" || !!d.processing) ? 2000 : false),
  });
  const plan = useQuery({
    queryKey: [
      ...corpusKeys.plan(pid),
      mode,
      selected,
      detail.data?.corpus.settings.corpus?.version,
      detail.data?.documents.map((d) => [d.id, d.parseState, d.chunkCount]),
    ],
    queryFn: () => corpusApi.plan(pid, mode, selected),
    enabled: !!detail.data,
  });
  const parentId = project?.settings.corpus?.parentProjectId;
  const refresh = useCallback(() => {
    for (const key of [corpusKeys.detail(pid), corpusKeys.plan(pid), qk.project(pid), qk.documents(pid), qk.revisions(pid), qk.runs(pid)])
      void qc.invalidateQueries({ queryKey: key });
    if (parentId) void qc.invalidateQueries({ queryKey: corpusKeys.list(parentId) });
  }, [pid, qc, parentId]);
  const start = useMutation({
    mutationFn: () => corpusApi.start(pid, { hash: plan.data!.hash, mode, selected }),
    onSuccess: (result) => {
      refresh();
      if (result.revision) setParams({ tab: "updates", rev: result.revision.id });
      else if (result.run) {
        qc.setQueryData(qk.run(pid, result.run.id), result.run);
        void qc.invalidateQueries({ queryKey: qk.runs(pid) });
        setParams({ tab: "updates", run: result.run.id });
        if (!config?.features?.worker) driver.start(result.run.id);
      }
    },
    onError: refresh,
  });
  if (project && !project.settings.corpus) return <Navigate to={`/p/${pid}/graphs`} replace />;
  if (detail.error)
    return (
      <div className="page">
        <ErrorState title="Unable to open knowledge graph" error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  if (!detail.data)
    return (
      <div className="page corpus-page">
        <LoadingState label="Opening knowledge graph…" />
        <InlineError error={detail.error} />
      </div>
    );
  const d = detail.data,
    version = Math.max(0, d.graph.number ?? 0);
  const draft = d.revisions
    .filter((r) => r.status === "draft" && r.parentId === d.graph.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const preparing = d.documents.filter(
    (doc) =>
      d.corpus.settings.corpus!.members.some((m) => !m.removed && m.headDocumentId === doc.id) &&
      (doc.parseState === "pending" || !!doc.processing),
  ).length;
  const changed =
    !!plan.data &&
    (!!plan.data.processDocumentIds.length ||
      !!plan.data.removeDocumentIds.length ||
      plan.data.ontology.hash !== plan.data.currentOntology.hash);
  const updateLabel = version > 0 ? "Update knowledge graph" : "Create knowledge graph";
  const ready = changed && !preparing && !plan.data?.errors.length;
  const openUpdate = () =>
    setParams(activeRun ? { tab: "updates", run: activeRun.id } : draft ? { tab: "updates", rev: draft.id } : { tab: "updates" });
  return (
    <div className="page corpus-page">
      <div className="page-wide">
        <PageHead
          title={{ documents: "Documents", updates: "Extract & review", history: "Graph versions", settings: "Graph settings" }[tab]}
        >
          {d.corpus.name} · {d.corpus.settings.corpus!.members.filter((m) => !m.removed).length} documents ·{" "}
          {version > 0
            ? `${d.graph.stats.acceptedIndividuals ?? d.graph.stats.individuals} published entities. Last saved ${new Date(d.graph.committedAt ?? d.graph.createdAt).toLocaleString()}.`
            : "No graph generated yet. Add documents, extract and review facts, then save a graph version."}
        </PageHead>
        {tab === "documents" && (
          <section className="corpus-action-bar corpus-update-status" aria-label="Knowledge graph update" aria-live="polite">
            <div>
              <h2>
                {activeRun
                  ? "Updating knowledge graph"
                  : draft
                    ? "Graph changes are ready to review"
                    : preparing
                      ? `Preparing ${preparing} document${preparing === 1 ? "" : "s"}…`
                      : ready
                        ? "Document changes are ready"
                        : plan.data?.errors.length
                          ? "Some documents need attention"
                          : version > 0
                            ? "Knowledge graph is up to date"
                            : "Add documents to get started"}
              </h2>
              <p>
                {activeRun
                  ? corpusRunStage(
                      activeRun.steps.find((s) => s.kind !== "finalize" && !activeRun.completedStepKeys?.includes(s.key))?.kind,
                    )
                  : draft
                    ? "Review this draft before starting the next update. Documents added afterward will be included in a later update."
                    : plan.data
                      ? corpusPlanSummary(plan.data)
                      : "Checking document changes…"}
              </p>
              <p>
                {version > 0
                  ? "Your saved graph stays available until you review and save the update."
                  : "Documents are prepared automatically. Review the extracted facts before saving your first graph."}
              </p>
              {!!plan.data?.errors.length && !activeRun && !draft && <p className="row-error">{plan.data.errors[0]}</p>}
              {plan.data?.estimatedUsd != null && ready && !draft && !activeRun && (
                <p>Estimated processing cost: ${plan.data.estimatedUsd.toFixed(2)}</p>
              )}
            </div>
            {activeRun || draft ? (
              <button className="btn" onClick={openUpdate}>
                {activeRun ? "View update progress" : "Review changes"}
              </button>
            ) : (
              changed && (
                <button className="btn" disabled={!ready || plan.isFetching || start.isPending} onClick={() => start.mutate()}>
                  {start.isPending ? "Starting update…" : preparing ? "Preparing documents…" : updateLabel}
                </button>
              )
            )}
          </section>
        )}
        <InlineError error={start.error} />
        <BudgetRecovery error={start.error} />
        <InlineError error={plan.error} />
        {tab === "documents" && (
          <CorpusDocuments
            pid={pid}
            detail={d}
            plan={plan.data}
            selected={selected}
            onSelected={(ids) => {
              setSelected(ids);
              setMode(ids.length ? "reprocess" : "changes");
            }}
            onPlan={openUpdate}
            refresh={refresh}
          />
        )}
        {tab === "updates" && (
          <CorpusUpdates
            pid={pid}
            detail={d}
            plan={plan.data}
            planLoading={plan.isFetching}
            mode={mode}
            onMode={setMode}
            selected={selected}
            refresh={refresh}
            onStart={() => start.mutate()}
            startPending={start.isPending}
          />
        )}
        {tab === "history" && <CorpusHistory pid={pid} detail={d} refresh={refresh} />}
        {tab === "settings" && <CorpusSettings key={d.corpus.settings.corpus!.version} pid={pid} detail={d} refresh={refresh} />}
      </div>
    </div>
  );
}
