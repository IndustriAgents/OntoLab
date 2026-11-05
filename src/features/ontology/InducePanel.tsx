import { BudgetRecovery } from "../runs/BudgetRecovery";
// "From documents": build the ontology from the project's own documents — a
// server-side induction run (topic clusters → classes → merge → relations →
// reuse lookup → pitfall repair) that ends in a draft to review, never in a
// silent commit. Approved competency questions steer it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { api, qk, type RunEstimate } from "../../lib/projectApi";
import { isUnchangedInductionBuild, summarizeBuildSources } from "../../lib/buildChanges";
import { sourceDocumentName } from "../../lib/documentSources";
import { documentsNeedingModel, prepareChunksForModel, savedGenerationModel, type GenerationModelChoice } from "../../lib/buildPreparation";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { EmptyState, InlineError } from "../../components/ui/ui";
import { IconPlay } from "../../components/icons";
import { RunStatusBadge } from "../runs/RunStatusBadge";
import { ExperimentOptions } from "../research/ExperimentOptions";
import "../workflows/builds.css";
import type { ProjectDocument, RunOptions, RunView } from "../../types/project";

export function EstimateLine({ estimate, loading }: { estimate: RunEstimate | undefined; loading: boolean }) {
  if (loading) return <span className="muted">Estimating…</span>;
  if (!estimate) return null;
  const tokens = `${(estimate.inputTokens / 1000).toFixed(0)}k in / ${(estimate.outputTokens / 1000).toFixed(0)}k out tokens`;
  return (
    <span className="estimate">
      About {estimate.modelCalls} model call{estimate.modelCalls === 1 ? "" : "s"} · {tokens} ·{" "}
      {estimate.usd == null ? (
        "price unknown for this model"
      ) : (
        <b>≈ ${estimate.usd < 0.01 && estimate.usd > 0 ? "<0.01" : estimate.usd.toFixed(2)}</b>
      )}
      {estimate.cached ? ` · ${estimate.cached} part${estimate.cached === 1 ? "" : "s"} already cached` : ""}
      {estimate.screened ? ` · ${estimate.screened} part${estimate.screened === 1 ? "" : "s"} skipped as unrelated` : ""}
    </span>
  );
}

export function BuildModelSeed({
  seed,
  documents = [],
  preferred,
}: {
  seed?: RunView;
  documents?: ProjectDocument[];
  preferred?: GenerationModelChoice;
}) {
  const { providers, status, setProvider, setModel, setReasoningEffort } = useModelChoice();
  const applied = useRef<string | null>(null);
  const saved = savedGenerationModel(documents);
  const original = seed
    ? { provider: seed.provider, model: seed.model, reasoningEffort: seed.options?.reasoningEffort ?? "default" }
    : undefined;
  const target = preferred ?? (saved?.provider === original?.provider && saved?.model === original?.model ? original : saved) ?? original;
  const key = JSON.stringify([
    seed?.id,
    documents.map((document) => document.id),
    target?.provider,
    target?.model,
    target?.reasoningEffort,
  ]);
  const provider = providers.find((p) => p.id === target?.provider && p.enabled && p.models.includes(target?.model ?? ""));
  useEffect(() => {
    if (status !== "ready" || !target || !provider || applied.current === key) return;
    setProvider(provider.id);
    setModel(target.model);
    if (target.reasoningEffort) setReasoningEffort(target.reasoningEffort);
    applied.current = key;
  }, [key, target, status, provider, setProvider, setModel, setReasoningEffort]);
  return status === "ready" && target && !provider ? (
    <p className="banner warn">
      The saved model is unavailable. Choose a configured model and prepare the document chunks for it before building.
    </p>
  ) : null;
}

export function InducePanel({
  documentIds,
  onCreated,
  seed,
  baseRevisionId,
  sourceRunId,
  onModelChoice,
  onDocumentsPrepared,
}: {
  documentIds?: string[];
  onCreated?: (run: RunView) => void;
  seed?: RunView;
  baseRevisionId?: string | null;
  sourceRunId?: string;
  onModelChoice?: (choice: GenerationModelChoice) => void;
  onDocumentsPrepared?: (ids: string[], choice: GenerationModelChoice) => void;
} = {}) {
  const { pid, project, current, revisions, activeRun, driver, drafts } = useProject();
  const starting = baseRevisionId === undefined ? current : revisions.find((r) => r.id === baseRevisionId);
  const choice = useModelChoice();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid) });
  const parsed = useMemo(() => (docs.data ?? []).filter((d) => d.parseState === "parsed"), [docs.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<Partial<RunOptions>>(seed?.options ?? {});
  const selectedDocuments = parsed.filter((document) => selected.has(document.id));
  const incompatible = documentsNeedingModel(selectedDocuments, choice);
  const savedModel = savedGenerationModel(selectedDocuments);
  const savedProvider = choice.providers.find((provider) => provider.id === savedModel?.provider);
  const canUseSavedModel = savedProvider?.enabled && savedProvider.models.includes(savedModel?.model ?? "");
  const prepare = useMutation({
    mutationFn: () => prepareChunksForModel(pid, selectedDocuments, { provider: choice.provider, model: choice.model }, api),
    onSuccess: async (prepared) => {
      await qc.invalidateQueries({ queryKey: qk.documents(pid) });
      qc.setQueryData<ProjectDocument[]>(qk.documents(pid), (previous = []) => [
        ...previous.filter((document) => !prepared.some((next) => next.id === document.id)),
        ...prepared,
      ]);
      const ids = prepared.map((document) => document.id);
      setSelected(new Set(ids));
      onDocumentsPrepared?.(ids, { provider: choice.provider, model: choice.model, reasoningEffort: choice.reasoningEffort });
    },
  });
  const original = useQuery({
    queryKey: ["run-research", pid, seed?.id ?? "no-source"],
    queryFn: () => api.runResearch(pid, seed!.id),
    enabled: !!seed,
  });
  const sourceChanges = original.data?.inputs
    ? summarizeBuildSources(
        original.data.inputs.documents,
        parsed.filter((d) => selected.has(d.id)),
      )
    : undefined;
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!seed || seeded.current === seed.id) return;
    setOptions(seed.options ?? {});
    seeded.current = seed.id;
  }, [seed]);
  useEffect(() => setSelected(new Set(documentIds ?? parsed.filter((d) => !d.variantOf).map((d) => d.id))), [parsed, documentIds]);
  const approved =
    (project?.settings.requirements?.cqs ?? []).filter((q) => q.status === "approved").length || (project?.competencyQuestions.length ?? 0);
  const body = {
    kind: "induction" as const,
    documentIds: [...selected],
    mode: "automatic" as const,
    provider: choice.provider,
    model: choice.model,
    options: {
      ...options,
      reasoningEffort: choice.provider === "codex-cli" && choice.reasoningEffort !== "default" ? choice.reasoningEffort : undefined,
    },
    ...(baseRevisionId !== undefined ? { baseRevisionId } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
  };
  const unchanged =
    !!original.data?.run.resultRevisionId &&
    revisions.some((revision) => revision.id === original.data!.run.resultRevisionId) &&
    isUnchangedInductionBuild(original.data, {
      documents: selectedDocuments,
      starting: baseRevisionId === null ? null : starting,
      project,
      provider: choice.provider,
      model: choice.model,
      options: body.options,
    });
  const estimate = useQuery({
    queryKey: ["estimate", pid, body],
    queryFn: ({ signal }) => api.estimateRun(pid, body, signal),
    enabled: selected.size > 0 && choice.providerEnabled && !incompatible.length && !prepare.isPending && !unchanged,
    staleTime: 60_000,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => {
      if (unchanged) throw new Error("No configuration changes. Review the existing build instead.");
      return api.createRun(pid, body);
    },
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: qk.runs(pid) });
      if (onCreated) onCreated(run);
      else {
        driver.start(run.id);
        navigate(`/p/${pid}/runs/${run.id}`);
      }
    },
  });
  const pending = drafts.find((d) => d.source === "induction");
  const chooseModel = (provider: typeof choice.provider, model: string, effort = choice.reasoningEffort) => {
    const reasoningEffort = choice.providers.find((candidate) => candidate.id === provider)?.reasoningEfforts?.[model]?.includes(effort)
      ? effort
      : "default";
    choice.setProvider(provider);
    choice.setModel(model);
    choice.setReasoningEffort(reasoningEffort);
    onModelChoice?.({ provider, model, reasoningEffort });
    prepare.reset();
    start.reset();
  };

  if (!docs.isLoading && !parsed.length)
    return (
      <EmptyState
        title="Upload documents first"
        action={
          <Link className="btn" to={`/p/${pid}/documents`}>
            Go to Documents
          </Link>
        }
      >
        The ontology is induced from the project's own documents.
      </EmptyState>
    );

  return (
    <section className="card" aria-labelledby="induce-h">
      <div className="card-head">
        <h3 id="induce-h">Build the ontology from your documents</h3>
        {starting?.stats.modules ? (
          <span className="file">Starts from {starting.status === "committed" ? `version ${starting.number}` : "a draft"}</span>
        ) : null}
      </div>
      <p className="field-hint">
        OntoLab groups the documents by topic, proposes the classes and relations they need, looks for existing vocabulary terms to reuse,
        checks the result for modelling pitfalls and repairs the serious ones. Each build produces a separate draft. Review it, validate it,
        then save a version when you are ready.
      </p>
      {pending && (
        <div className="banner subtle">
          An induced ontology is waiting for review. <Link to={`/p/${pid}/ontology?tab=review&rev=${pending.id}`}>Review it</Link>
        </div>
      )}
      {approved === 0 ? (
        <div className="banner warn">
          No approved competency questions yet. The ontology will be broader and less focused —{" "}
          <Link to={`/p/${pid}/project-settings#requirements`}>write user stories and approve questions first</Link>.
        </div>
      ) : (
        <p className="muted">
          Steered by {approved} approved competency question{approved === 1 ? "" : "s"}.
        </p>
      )}
      <details open={!documentIds}>
        <summary>Selected source documents</summary>
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
                      disabled={!!documentIds}
                      checked={selected.has(d.id)}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? new Set([...s, d.id]) : new Set([...s].filter((x) => x !== d.id))))
                      }
                    />
                    {sourceDocumentName(d, docs.data ?? [])}
                    <span className="muted">
                      {" "}
                      · {d.chunkCount} part{d.chunkCount === 1 ? "" : "s"}
                    </span>
                  </label>
                </li>
              ))}
          </ul>
        </fieldset>
      </details>
      <ExperimentOptions kind="induction" options={options} onChange={setOptions} />
      <div className="build-plan" role="status" aria-label="Build change plan">
        <h4>{seed ? "What will change in this build" : "Your build plan"}</h4>
        {seed && sourceChanges && (
          <p>
            Copied from build {seed.id.slice(-6)}. {sourceChanges.added} documents added; {sourceChanges.removed} removed;{" "}
            {sourceChanges.reconfigured} source configurations changed.
          </p>
        )}
        {seed && original.data && !original.data.inputs && (
          <p>The original source settings were not recorded. Review the current document configurations before building.</p>
        )}
        {!!sourceChanges?.embeddingChanged && (
          <p>
            Embedding model changed for {sourceChanges.embeddingChanged} sources. Their embeddings and topic assignments will be recomputed.
          </p>
        )}
        {seed && baseRevisionId !== undefined && baseRevisionId !== seed.baseRevisionId && (
          <p>
            The starting ontology differs from the original build. This is a further improvement pass, even when the documents and settings
            are unchanged. To review the existing result, choose Inspect results instead.
          </p>
        )}
        <p>
          {selected.size} source document{selected.size === 1 ? "" : "s"} ·{" "}
          {baseRevisionId === null
            ? "No starting ontology"
            : starting
              ? starting.status === "committed"
                ? `Starting from version ${starting.number}`
                : "Starting from a draft"
              : "Building from documents"}
          .
        </p>
        {seed && (choice.provider !== seed.provider || choice.model !== seed.model) && (
          <p>
            {incompatible.length
              ? "Generation model changed. Prepare the affected document chunks below before building."
              : "Generation model changed. The selected document chunks are ready for it."}
          </p>
        )}
        <p>
          {options.cqGuided === false
            ? "Question guidance is disabled for this build."
            : approved
              ? `The project’s current ${approved} approved question${approved === 1 ? "" : "s"} guide this build. Review them above when comparing with an older build.`
              : "No approved questions are currently selected as guidance. Review requirements above before building."}
        </p>
        <details>
          <summary>Reused and recomputed work</summary>
          <p>
            Saved document text and configured chunks are reused. Compatible cached embeddings may be reused. Topic groups, class proposals,
            properties and checks are computed for the new build. Earlier build results and other drafts are preserved.
          </p>
        </details>
      </div>
      <ProviderModelSelect
        {...selectProps(choice)}
        structuredOnly
        disabled={prepare.isPending}
        onProvider={(provider) => chooseModel(provider, choice.providers.find((candidate) => candidate.id === provider)?.models[0] ?? "")}
        onModel={(model) => chooseModel(choice.provider, model)}
        reasoningEffort={choice.reasoningEffort}
        onReasoningEffort={(effort) => chooseModel(choice.provider, choice.model, effort)}
      />
      {!!incompatible.length && (
        <section className="build-plan build-model-compatibility" aria-label="Document model compatibility">
          <h4>Prepare chunks for the selected model</h4>
          <p>
            {incompatible.length} selected document{incompatible.length === 1 ? " has" : "s have"} chunks saved for a different generation
            model. Prepare them for {choice.selected?.label ?? choice.provider} / {choice.model}, or switch back to the saved model.
          </p>
          <ul>
            {incompatible.map((document) => (
              <li key={document.id}>
                {sourceDocumentName(document, docs.data ?? [])} · {document.preprocessing!.settings.tokens!.generation.provider} /{" "}
                {document.preprocessing!.settings.tokens!.generation.model}
              </li>
            ))}
          </ul>
          <p>This keeps your chunk sizes, embedding choices and token budgets, and saves separate configurations. No generation starts.</p>
          <div className="row-actions">
            <button className="btn" disabled={prepare.isPending || !choice.providerEnabled} onClick={() => prepare.mutate()}>
              {prepare.isPending ? "Preparing document chunks…" : "Prepare all selected documents"}
            </button>
            {canUseSavedModel && savedModel && savedProvider && (
              <button className="btn ghost" disabled={prepare.isPending} onClick={() => chooseModel(savedProvider.id, savedModel.model)}>
                Use saved model
              </button>
            )}
          </div>
        </section>
      )}
      <p className="field-hint">
        {unchanged ? (
          "This configuration already has a completed build. Review its results or change the configuration to build again."
        ) : (
          <EstimateLine estimate={estimate.data} loading={estimate.isFetching} />
        )}
      </p>
      <InlineError error={prepare.error ?? start.error ?? (incompatible.length ? null : estimate.error)} />
      <BudgetRecovery error={start.error ?? estimate.error} />
      <div className="row-actions">
        <button
          className="btn"
          disabled={
            unchanged ||
            (!!seed && original.isLoading) ||
            !selected.size ||
            !choice.providerEnabled ||
            !!activeRun ||
            start.isPending ||
            prepare.isPending ||
            !!incompatible.length ||
            estimate.isFetching ||
            !!estimate.error
          }
          onClick={() => start.mutate()}
        >
          <IconPlay /> {start.isPending ? "Starting build…" : unchanged ? "No configuration changes" : "Build ontology"}
        </button>
        {unchanged && (
          <Link className="btn ghost" to={`/p/${pid}/workflows/tbox?start=documents&step=results&run=${original.data!.run.id}`}>
            Inspect existing results
          </Link>
        )}
        {activeRun && (
          <span className="muted">
            A run is active <RunStatusBadge status={activeRun.status} /> — <Link to={`/p/${pid}/runs/${activeRun.id}`}>open it</Link>
          </span>
        )}
        {!choice.providerEnabled && (
          <p className="field-hint">
            Choose an enabled model to build the ontology. <Link to="/settings#providers">Open model connections →</Link>
          </p>
        )}
        {!selected.size && (
          <p className="field-hint">
            Select prepared documents before building.{" "}
            <Link to={`/p/${pid}/workflows/tbox?start=documents&step=sources`}>Choose documents →</Link>
          </p>
        )}
        {!!seed && original.isLoading && (
          <p className="field-hint">Loading the earlier build’s configuration before checking for changes.</p>
        )}
        {estimate.isFetching && <p className="field-hint">Checking the build estimate before starting.</p>}
      </div>
    </section>
  );
}
