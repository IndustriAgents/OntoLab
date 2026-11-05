import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Link, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import type { ProjectDocument, RunView } from "../../types/project";
import { InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { InducePanel, BuildModelSeed } from "../ontology/InducePanel";
import { NewRun, Questions } from "../runs/RunsPage";
import { BudgetRecovery } from "../runs/BudgetRecovery";
import { RequirementsCard } from "../overview/RequirementsCard";
import { RunInspector } from "../research/RunInspector";
import { TboxEvidenceExplorer } from "../research/TboxEvidenceExplorer";
import { ValidationView } from "../validate/ValidationView";
import { processingPoll } from "../documents/useDocumentUpload";
import { DocumentSources, PreprocessingStep } from "./DocumentSteps";
import { BatchChunkStep } from "./BatchChunkStep";
import { AlignmentSteps } from "./AlignmentSteps";
import { MethodDetails } from "./MethodDetails";
import { BuildHistory } from "./BuildHistory";
import { WORKFLOWS, workflowId, workflowStep, workflowSteps, tboxStart, type TboxStart } from "./model";
import { OntologyStart } from "./OntologyStart";
import { OntologyDraftSteps } from "./OntologyDraftSteps";
import { selectSourceConfiguration, sourceDocumentName } from "../../lib/documentSources";
import CorporaPage from "../corpora/CorporaPage";
import CorpusPage from "../corpora/CorpusPage";
import "./ontology-start.css";
import "./workflows.css";
import "../research/research.css";

function DocumentWorkflow({ kind, step }: { kind: "tbox" | "abox"; step: string }) {
  const { pid, project, revisions, selectedId, driver, working } = useProject();
  const modelChoice = useModelChoice();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const update = (patch: Record<string, string | null>) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid), refetchInterval: processingPoll });
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const runId = params.get("run");
  const seedId = params.get("from");
  const seed = useQuery({ queryKey: qk.run(pid, seedId ?? "no-source"), queryFn: () => api.getRun(pid, seedId!), enabled: !!seedId });
  const seedEvidence = useQuery({
    queryKey: ["run-research", pid, seedId ?? "no-source"],
    queryFn: () => api.runResearch(pid, seedId!),
    enabled: kind === "tbox" && !runId && !!seedId,
  });
  const startingId = params.has("base")
    ? params.get("base") === "none"
      ? null
      : params.get("base")
    : (project?.currentRevisionId ?? null);
  const run = useQuery({
    queryKey: qk.run(pid, runId ?? "none"),
    queryFn: () => api.getRun(pid, runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && ["queued", "running", "awaiting_answers"].includes(q.state.data.status) ? 2000 : false),
  });
  const evidence = useQuery({ queryKey: ["run-research", pid, runId], queryFn: () => api.runResearch(pid, runId!), enabled: !!runId });
  const docsParam = params.get("docs");
  const selected = useMemo(
    () =>
      docsParam !== null
        ? docsParam.split(",").filter(Boolean)
        : (seed.data?.documentIds ??
          (docs.data ?? []).filter((d) => d.parseState === "parsed" && d.charCount > 0 && !d.variantOf).map((d) => d.id)),
    [docsParam, docs.data, seed.data],
  );
  const historical = !!runId;
  const liveInputs = (docs.data ?? []).filter((d) => selected.includes(d.id));
  const inputs = historical ? (evidence.data?.inputs?.documents ?? []) : liveInputs;
  const readyForGeneration =
    selected.length > 0 &&
    inputs.length === selected.length &&
    inputs.every((d) => d.parseState === "parsed" && d.charCount > 0 && d.chunkCount > 0);
  const doc = (historical ? inputs : (docs.data ?? [])).find((d) => d.id === params.get("doc")) ?? inputs[0];
  const inspectionInputs = doc && !inputs.some((d) => d.id === doc.id) ? [doc, ...inputs] : inputs;
  const inspectingSelectedOriginal =
    step === "parse" &&
    params.get("view") === "original" &&
    !!doc &&
    liveInputs.some((input) => (input.variantOf ?? input.id) === (doc.variantOf ?? doc.id));
  const created = (r: RunView) => {
    update({ run: r.id, step: "results", rev: null, from: null, base: null });
    driver.start(r.id);
  };
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
      if (r.status === "paused" && driver.runId === r.id) driver.stop();
      qc.setQueryData(qk.run(pid, r.id), r);
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      void qc.invalidateQueries({ queryKey: ["run-research", pid, r.id] });
      if (r.status === "queued" || r.status === "running") driver.start(r.id);
    },
  });
  const history = (runs.data ?? []).filter((r) =>
    kind === "tbox" ? r.kind === "induction" : r.kind !== "induction" && r.kind !== "alignment",
  );
  const revisionId = run.data?.resultRevisionId ?? (!runId ? selectedId : null);
  const duplicate = (r: RunView, base = r.baseRevisionId) =>
    update({
      run: null,
      from: r.id,
      base: base ?? "none",
      rev: null,
      history: null,
      step: "sources",
      start: "documents",
      docs: r.documentIds.join(","),
      doc: null,
      provider: null,
      model: null,
      effort: null,
    });
  const applyChunks = (prepared: ProjectDocument[]) => {
    const available = [...(docs.data ?? []), ...prepared];
    const next = prepared.reduce(
      (ids, document) => selectSourceConfiguration(ids, available, document.variantOf ?? document.id, document.id),
      selected,
    );
    const first = prepared[0]?.preprocessing?.settings;
    const generation = first?.unit === "tokens" ? first.tokens?.generation : undefined;
    update({
      docs: next.join(","),
      doc: prepared.length === 1 ? prepared[0].id : null,
      ...(generation ? { provider: generation.provider, model: generation.model, effort: modelChoice.reasoningEffort } : {}),
    });
  };
  return (
    <>
      {kind === "tbox" && !historical && docs.data && (!seedId || seed.data) && (
        <BuildModelSeed
          seed={seed.data}
          documents={liveInputs}
          preferred={
            params.get("provider") && params.get("model")
              ? { provider: params.get("provider")!, model: params.get("model")!, reasoningEffort: params.get("effort") ?? undefined }
              : undefined
          }
        />
      )}
      <div className="workflow-context">
        <label>
          {kind === "tbox" ? "Build" : "Extraction"}{" "}
          <select
            aria-label={kind === "tbox" ? "Build" : "Extraction"}
            value={runId ?? ""}
            onChange={(e) =>
              update({
                run: e.target.value || null,
                rev: null,
                doc: null,
                from: null,
                base: null,
                ...(e.target.value ? {} : { step: kind === "tbox" ? "start" : "sources", start: null }),
              })
            }
          >
            <option value="">{kind === "tbox" ? "Prepare a new build" : "New extraction"}</option>
            {history.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.createdAt).toLocaleString()} · {r.status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        {kind === "tbox" && (
          <div className="row-actions">
            {historical && run.data && (
              <button className="btn ghost sm" onClick={() => duplicate(run.data!)}>
                Duplicate and adjust
              </button>
            )}
            {historical && run.data?.resultRevisionId && (
              <button className="btn sm" onClick={() => duplicate(run.data!, run.data!.resultRevisionId!)}>
                Improve this version
              </button>
            )}
            <button className="btn ghost sm" onClick={() => update({ history: "1" })}>
              Build history
            </button>
          </div>
        )}
        {historical && kind !== "tbox" && (
          <button
            className="btn ghost sm"
            onClick={() => update({ run: null, rev: null, step: "sources", docs: run.data?.documentIds.join(",") ?? null })}
          >
            Start a new extraction
          </button>
        )}
      </div>
      {kind === "tbox" && !historical && (
        <div className="build-lifecycle" aria-label="Ontology development loop">
          <span>
            <strong>Build</strong>
            <small>Recorded inputs and settings</small>
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <strong>Draft</strong>
            <small>Inspect, edit and validate</small>
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <strong>Version</strong>
            <small>Save a version, then improve</small>
          </span>
        </div>
      )}
      {kind === "tbox" && !historical && seedId && (
        <div className="build-copy-note">
          <strong>Preparing from build {seedId.slice(-6)}</strong>
          <p>
            The documents, starting ontology and generation settings are copied into this setup. Starting the build creates a separate
            draft. Review the current project questions before building.
          </p>
          {docs.data && selected.some((id) => !docs.data!.some((d) => d.id === id)) && (
            <p className="banner warn">
              Some original files are no longer available.{" "}
              <button
                className="btn ghost sm"
                onClick={() => update({ docs: selected.filter((id) => docs.data!.some((d) => d.id === id)).join(",") })}
              >
                Remove unavailable inputs
              </button>
            </p>
          )}
        </div>
      )}
      <InlineError error={docs.error ?? runs.error ?? run.error ?? evidence.error ?? seed.error ?? seedEvidence.error} />
      {kind === "tbox" && params.get("history") === "1" && (
        <BuildHistory
          pid={pid}
          runs={history}
          selected={runId}
          onClose={() => update({ history: null })}
          onOpen={(r) => update({ run: r.id, history: null, from: null, base: null, step: "results" })}
          onDuplicate={(r) => duplicate(r)}
        />
      )}
      {kind === "tbox" &&
        step === "requirements" &&
        (historical ? (
          <section className="card">
            <h2>Recorded requirements{run.data?.requirementsSnapshot ? ` v${run.data.requirementsSnapshot.version}` : ""}</h2>
            {run.data?.requirementsSnapshot ? (
              <>
                <p>These requirements are fixed for this build.</p>
                <ul>
                  {run.data.requirementsSnapshot.requirements.stories.map((story, i) => (
                    <li key={i}>{story}</li>
                  ))}
                </ul>
                <ul>
                  {run.data.requirementsSnapshot.requirements.cqs.map((q) => (
                    <li key={q.id}>
                      {q.text} ({q.status})
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>This earlier build has no versioned requirements. Its original inputs are available in Inspect results.</p>
            )}
          </section>
        ) : (
          <RequirementsCard />
        ))}
      {step === "sources" &&
        (historical ? (
          <div className="workflow-stack">
            <h2>Recorded source documents</h2>
            <p>
              {kind === "tbox"
                ? "These are the recorded inputs of this build. Duplicate and adjust prepares a separate build without changing this record."
                : "These inputs belong to the selected extraction. Choose New extraction to change them."}
            </p>
            {evidence.isLoading ? (
              <LoadingState />
            ) : inputs.length ? (
              inputs.map((d) => (
                <div className="workflow-document" key={d.id}>
                  <span>
                    {d.name} · {d.chunkCount} chunks
                  </span>
                  <button className="btn ghost sm" onClick={() => update({ doc: d.id, step: "parse" })}>
                    Inspect input
                  </button>
                </div>
              ))
            ) : (
              <p>This older run has no input snapshot.</p>
            )}
          </div>
        ) : (
          <DocumentSources
            pid={pid}
            documents={docs.data ?? []}
            loading={docs.isLoading}
            preferredModel={{ provider: modelChoice.provider, model: modelChoice.model }}
            selected={selected}
            previousBuild={
              kind === "tbox" && seed.data
                ? { id: seed.data.id, documentIds: seed.data.documentIds, documents: seedEvidence.data?.inputs?.documents }
                : undefined
            }
            onSelect={(ids) => update({ docs: ids.join(","), doc: null })}
            onInspect={(id, view) => update({ doc: id, step: "parse", view: view ?? null })}
          />
        ))}
      {step === "chunks" && !historical && (
        <BatchChunkStep
          key={selected.join(",")}
          pid={pid}
          documents={liveInputs}
          allDocuments={docs.data ?? []}
          selected={selected}
          onUseVariants={applyChunks}
          onModelChoice={(choice) =>
            update({ provider: choice.provider, model: choice.model, effort: choice.reasoningEffort ?? "default" })
          }
        />
      )}
      {(step === "parse" || (step === "chunks" && historical)) && (
        <>
          {inspectionInputs.length > 1 && (
            <label className="field workflow-document-picker">
              <span>Document</span>
              <select value={doc?.id} onChange={(e) => update({ doc: e.target.value })}>
                {inspectionInputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {sourceDocumentName(d, docs.data ?? [])}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!historical && doc && !selected.includes(doc.id) && !inspectingSelectedOriginal && (
            <div className="banner subtle workflow-inspection-note" role="status">
              <span>Inspecting only · this file is not selected for the next build.</span>
              <button
                className="btn ghost sm"
                disabled={doc.parseState !== "parsed" || !doc.charCount}
                onClick={() =>
                  update({ docs: selectSourceConfiguration(selected, docs.data ?? [], doc.variantOf ?? doc.id, doc.id).join(",") })
                }
              >
                Include in next build
              </button>
            </div>
          )}
          {historical && evidence.isLoading ? (
            <LoadingState />
          ) : doc ? (
            <PreprocessingStep
              key={`${doc.id}-${runId ?? "live"}`}
              pid={pid}
              doc={doc}
              mode={step}
              documents={docs.data ?? []}
              selectedDocumentIds={selected}
              initialView={params.get("view") === "original" ? "original" : "text"}
              snapshot={historical ? evidence.data?.inputs : undefined}
              runId={historical ? (runId ?? undefined) : undefined}
              onModelChoice={(choice) =>
                update({ provider: choice.provider, model: choice.model, effort: choice.reasoningEffort ?? "default" })
              }
              onUseVariant={(variant) => applyChunks([variant])}
            />
          ) : (
            <p className="muted">
              {historical
                ? "No recorded source snapshot is available for this run."
                : "Select documents in the first step to inspect their parsed text and chunks."}
            </p>
          )}
        </>
      )}
      {step === "generate" &&
        (historical ? (
          <div className="workflow-stack">
            <h2>Recorded generation settings</h2>
            <p>
              {run.data?.provider} / {run.data?.model} · {run.data?.status.replaceAll("_", " ")}
            </p>
            <MethodDetails title="Exact run configuration">
              <pre className="ttl-preview">{JSON.stringify(run.data?.options, null, 2)}</pre>
            </MethodDetails>
            {run.data?.requirementsSnapshot && <p>Requirements v{run.data.requirementsSnapshot.version} · fixed at build start.</p>}
            <p>Inspect results to follow the processing stages. Start a new extraction to change the inputs or settings.</p>
          </div>
        ) : !readyForGeneration ? (
          <div className="banner subtle">
            <p>Every selected document needs readable text and configured chunks before generation.</p>
            <button className="btn" onClick={() => update({ step: "chunks" })}>
              Configure chunks
            </button>
          </div>
        ) : (
          <>
            {kind === "tbox" && (
              <div className="banner subtle">
                <p>This build will use the current saved requirements. Changes after it starts apply to future builds.</p>
                <Link
                  to={{
                    search: (() => {
                      const next = new URLSearchParams(params);
                      next.set("step", "requirements");
                      return next.toString();
                    })(),
                  }}
                >
                  Review requirements →
                </Link>
              </div>
            )}
            {kind === "tbox" ? (
              <>
                <section className="build-starting-point">
                  <label className="field">
                    <span>Starting ontology</span>
                    <select aria-label="Starting ontology" value={startingId ?? "none"} onChange={(e) => update({ base: e.target.value })}>
                      <option value="none">Build from documents · no starting ontology</option>
                      {revisions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.status === "committed" ? `Version ${r.number}` : "Draft"}
                          {r.id === project?.currentRevisionId ? " · current" : ""} · {r.summary}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="field-hint">
                    The selected ontology supplies existing terms. This build creates a separate draft.{" "}
                    <Link to={`/p/${pid}/ontology?tab=workspace`}>Import a TTL ontology</Link> or{" "}
                    <Link to={`/p/${pid}/ontology?tab=history`}>browse versions</Link>.
                  </p>
                </section>
                {seedId && seed.isLoading ? (
                  <LoadingState label="Loading copied build settings…" />
                ) : (
                  <InducePanel
                    key={seedId ?? "new"}
                    documentIds={selected}
                    onCreated={created}
                    seed={seed.data}
                    baseRevisionId={startingId}
                    sourceRunId={seedId ?? undefined}
                    onModelChoice={(choice) =>
                      update({ provider: choice.provider, model: choice.model, effort: choice.reasoningEffort ?? "default" })
                    }
                    onDocumentsPrepared={(ids, choice) =>
                      update({
                        docs: ids.join(","),
                        doc: null,
                        provider: choice.provider,
                        model: choice.model,
                        effort: choice.reasoningEffort ?? "default",
                      })
                    }
                  />
                )}
              </>
            ) : (
              <NewRun documentIds={selected} onCreated={created} />
            )}
          </>
        ))}
      {step === "results" &&
        (runId && run.data ? (
          <div className="workflow-stack">
            <div className="workflow-run-status">
              <StatusBadge tone={run.data.status === "ready_for_review" ? "ok" : "info"}>
                {run.data.status.replaceAll("_", " ")}
              </StatusBadge>
              <span>
                {run.data.completedSteps} / {run.data.steps.length} steps saved
              </span>
              {run.data.resumable && driver.runId !== runId && (
                <button className="btn" onClick={() => driver.start(runId)}>
                  Resume processing
                </button>
              )}
              {["queued", "running"].includes(run.data.status) && (
                <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("pause")}>
                  Pause
                </button>
              )}
              {["failed", "paused", "cancelled"].includes(run.data.status) && (
                <button className="btn" disabled={control.isPending} onClick={() => control.mutate("retry")}>
                  {run.data.status === "paused" ? "Resume processing" : "Retry unfinished work"}
                </button>
              )}
              {["queued", "running", "awaiting_answers", "paused"].includes(run.data.status) && (
                <button className="btn ghost" disabled={control.isPending} onClick={() => control.mutate("cancel")}>
                  Cancel run
                </button>
              )}
            </div>
            <InlineError error={control.error ?? (driver.runId === runId && driver.error ? new Error(driver.error) : null)} />
            {run.data.error && (
              <div className="banner error" role="alert">
                {run.data.error}
              </div>
            )}
            <BudgetRecovery error={run.data.error} />
            {(run.data.notes ?? [])
              .filter((note) => note.startsWith("Automatic repair did not finish:"))
              .map((note) => (
                <div className="banner warn" role="alert" key={note}>
                  {note}
                </div>
              ))}
            {run.data.status === "awaiting_answers" && <Questions run={run.data} />}
            {kind === "tbox" ? (
              <TboxEvidenceExplorer key={runId} pid={pid} runId={runId} />
            ) : (
              <RunInspector key={runId} pid={pid} runId={runId} compact />
            )}
            {kind === "abox" && revisionId && <Link to={`/p/${pid}/explore?rev=${revisionId}`}>Review & edit result</Link>}
            <MethodDetails title="Additional run actions">
              <Link to={`/p/${pid}/runs/${runId}`}>Open clarification, proposal and replay controls</Link>
            </MethodDetails>
          </div>
        ) : (
          <p className="muted">
            {run.isLoading ? "Loading extraction…" : "Start generation or select a previous extraction to inspect each processing stage."}
          </p>
        ))}
      {step === "validate" &&
        (revisionId ? (
          <>
            <p className="field-hint">Validating {runId ? "the selected extraction's output" : "the selected project revision"}.</p>
            <ValidationView key={revisionId} pid={pid} revisionId={revisionId} />
            {kind === "tbox" && (
              <section className="build-next-actions">
                {revisions.find((r) => r.id === revisionId)?.status === "committed" && (
                  <Link className="btn" to={`/p/${pid}/graphs?ontology=${revisionId}`}>
                    New knowledge graph using this ontology →
                  </Link>
                )}
                <h3>Your ontology and next steps</h3>
                <p>
                  Saving a version makes this the project's current ontology. You can browse older versions or prepare another build
                  whenever you want to improve it.
                </p>
                <div className="row-actions">
                  <Link className="btn" to={`/p/${pid}/ontology?rev=${revisionId}`}>
                    Open ontology
                  </Link>
                  <Link className="btn ghost" to={`/p/${pid}/export?rev=${revisionId}`}>
                    Download ontology
                  </Link>
                  {run.data && (
                    <button className="btn ghost" onClick={() => duplicate(run.data!, revisionId)}>
                      Improve this version
                    </button>
                  )}
                  <Link to={`/p/${pid}/ontology?tab=history`}>Versions & comparison</Link>
                </div>
              </section>
            )}
          </>
        ) : (
          <p className="muted">Complete generation to create a result revision for validation.</p>
        ))}
      {working.saveError && <p role="alert">{working.saveError}</p>}
    </>
  );
}

export default function WorkflowPage() {
  const page = useRef<HTMLDivElement>(null);
  const [requirementsDirty, setRequirementsDirty] = useState(false);
  const { pid, project, selectedId } = useProject();
  useEffect(() => setRequirementsDirty(false), [pid]);
  const { workflow } = useParams();
  const kind = workflowId(workflow);
  const flow = WORKFLOWS[kind];
  const [params, setParams] = useSearchParams();
  const steps = workflowSteps(kind, params);
  const step = workflowStep(kind, params.get("step"), params);
  useEffect(() => {
    if (kind === "alignment") page.current?.scrollTo({ top: 0 });
  }, [kind, step]);
  const at = steps.findIndex(([id]) => id === step);
  const runId = params.get("run");
  const selectedRun = useQuery({ queryKey: qk.run(pid, runId ?? "none"), queryFn: () => api.getRun(pid, runId!), enabled: !!runId });
  const draftPath = kind === "tbox" && !runId && tboxStart(params) !== "documents";
  const preparedRevisionId = params.get("rev") ?? (step !== "start" ? selectedId : null);
  const canValidate = runId ? !!selectedRun.data?.resultRevisionId : draftPath ? !!preparedRevisionId : !!(params.get("rev") ?? selectedId);
  const chooseStart = (start: TboxStart) =>
    setParams({ start, step: start === "documents" ? "sources" : "start", ...(start === "documents" ? { base: "none" } : {}) });
  const go = (id: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("step", id);
      return n;
    });
  if (kind === "abox") {
    if (project?.settings.corpus) return <CorpusPage />;
    if (!runId) return <CorporaPage />;
  }
  if (project?.settings.corpus) return <Navigate to={`/p/${project.settings.corpus.parentProjectId}/workflows/${kind}`} replace />;
  return (
    <div className="page workflow-page" ref={page}>
      <div className="page-wide">
        <header className="workflow-heading">
          <span className="research-eyebrow">{flow.term} workflow</span>
          <h1>{flow.title}</h1>
          <p>{flow.description}</p>
        </header>
        {steps.length > 1 && (
          <nav className="workflow-steps" aria-label={`${flow.term} workflow steps`}>
            {steps.map(([id, label], i) => (
              <button
                key={id}
                aria-current={step === id ? "step" : undefined}
                disabled={
                  (requirementsDirty && id !== step) ||
                  (draftPath && id !== "start" && id !== "requirements" && !preparedRevisionId) ||
                  (id === "validate" && !canValidate)
                }
                onClick={() => go(id)}
              >
                <span>{i + 1}</span>
                <strong>{label}</strong>
              </button>
            ))}
          </nav>
        )}
        <section className="workflow-stage" aria-label={steps[at]?.[1]}>
          {kind === "tbox" && step === "start" ? (
            <OntologyStart onChoose={chooseStart} />
          ) : kind === "tbox" && !runId && step === "requirements" ? (
            <>
              {requirementsDirty && (
                <p className="banner subtle">Save or discard your requirements changes before moving to another step.</p>
              )}
              <RequirementsCard onDirtyChange={setRequirementsDirty} />
            </>
          ) : kind === "tbox" && !runId && tboxStart(params) !== "documents" ? (
            <OntologyDraftSteps step={step} />
          ) : kind === "alignment" ? (
            <AlignmentSteps
              key={selectedId ?? "new-alignment"}
              step={step}
              onRevision={(id) =>
                setParams((p) => {
                  const n = new URLSearchParams(p);
                  if (id) n.set("rev", id);
                  else n.delete("rev");
                  return n;
                })
              }
            />
          ) : (
            <DocumentWorkflow key={kind} kind={kind} step={step} />
          )}
        </section>
        {steps.length > 1 && (
          <footer className="workflow-footer">
            <button className="btn ghost" disabled={at === 0 || requirementsDirty} onClick={() => go(steps[at - 1]![0])}>
              ← Previous step
            </button>
            <span>
              Step {at + 1} of {steps.length}
            </span>
            {step !== "start" && at < steps.length - 1 ? (
              <button
                className="btn"
                disabled={requirementsDirty || (steps[at + 1]?.[0] === "validate" && !canValidate)}
                onClick={() => go(steps[at + 1]![0])}
              >
                Next: {steps[at + 1]![1]} →
              </button>
            ) : (
              <span />
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
