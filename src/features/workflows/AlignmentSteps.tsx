import { BudgetRecovery } from "../runs/BudgetRecovery";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { AlignmentRunPanel } from "./AlignmentRunPanel";
import { useModelChoice } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import { parseTBox } from "../../lib/ontology/tboxParser";
import { Dropzone } from "../../components/Dropzone";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { InlineError, LoadingState } from "../../components/ui/ui";
import { JsonDetails, ResultTable, saveJson } from "../research/ResearchResults";
import { ValidationView } from "../validate/ValidationView";
import { revisionLabel } from "../revisions/RevisionBar";
import { TechnicalResults } from "../research/TechnicalResults";
import { MethodDetails } from "./MethodDetails";
import { AlignmentReviewWorkspace } from "./AlignmentReviewWorkspace";
import { AlignmentCoverage } from "./AlignmentCoverage";
import { alignmentTerms } from "./alignmentTerms";
import { alignmentSetup, comparisonIsCurrent, mappingIsCurrent, ALIGNMENT_MODULE } from "../../lib/alignment";
import type { AlignmentSetup } from "../../types/alignment";
import "./alignment.css";

export function AlignmentSteps({ step, onRevision }: { step: string; onRevision: (id: string) => void }) {
  const { pid, selectedId, revisions, working, driver, activeRun, project } = useProject();
  const { config } = useAuth();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const [params, setParams] = useSearchParams();
  const go = (step: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("step", step);
      return next;
    });
  const rev = useQuery({
    queryKey: qk.revision(pid, selectedId ?? "none"),
    queryFn: () => api.getRevision(pid, selectedId!),
    enabled: !!selectedId,
  });
  const modules = useMemo(() => rev.data?.content.modules ?? [], [rev.data]);
  const standards = modules.filter((m) => m.name !== "alignment.ttl");
  const invalidate = async (id: string) => {
    await qc.invalidateQueries({ queryKey: qk.revisions(pid) });
    await qc.invalidateQueries({ queryKey: qk.revision(pid, id) });
    await qc.invalidateQueries({ queryKey: qk.project(pid) });
    onRevision(id);
  };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      await working.flush();
      const base = selectedId
        ? (await api.getRevision(pid, selectedId)).content
        : { modules: [], abox: null, baseIri: "https://example.org/ontology/" };
      const added = [];
      for (const file of files) {
        const result = await api.convertRdf(file.name, await file.text());
        parseTBox(result.turtle);
        added.push({ id: crypto.randomUUID(), name: file.name, turtle: result.turtle });
      }
      return api.createDraft(pid, { ...base, modules: [...base.modules, ...added] }, "Import standards for alignment", "import");
    },
    onSuccess: (r) => invalidate(r.id),
  });
  const saveSetup = useMutation({
    mutationFn: async (setup: AlignmentSetup) => {
      await working.flush();
      return api.saveAlignmentSetup(pid, selectedId!, setup, rev.data?.contentHash);
    },
    onSuccess: (r) => invalidate(r.id),
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.revision(pid, selectedId!) });
    },
  });
  const setup =
    (saveSetup.isPending ? saveSetup.variables : undefined) ??
    alignmentSetup(rev.data?.content ?? { modules: [], abox: null, baseIri: "" });
  const source = setup.sourceModules,
    target = setup.targetModules,
    matchers = setup.matchers,
    verify = setup.verify;
  const group = (id: string) => (source.includes(id) ? "source" : target.includes(id) ? "target" : "skip");
  const changeSetup = (patch: Partial<AlignmentSetup>) => {
    const next = { ...setup, ...patch };
    next.sourceModules = next.sourceModules.filter((id) => standards.some((m) => m.id === id));
    next.targetModules = next.targetModules.filter((id) => standards.some((m) => m.id === id));
    saveSetup.mutate(next);
  };
  const provider = setup.provider ?? choice.provider;
  const model = setup.model ?? choice.model;
  const providerInfo = choice.providers.find((p) => p.id === provider);
  const modelReady = !!providerInfo?.enabled && providerInfo.models.includes(model) && !providerInfo.chatOnlyModels?.includes(model);
  const effectiveSetup = { ...setup, ...(verify ? { provider, model } : {}) };
  const align = useMutation({
    mutationFn: async () => {
      const savedId = await working.flush();
      if (savedId && savedId !== selectedId) {
        onRevision(savedId);
        throw new Error("Your ontology edits created a new draft. Review its updated comparison plan before starting.");
      }
      if (working.save === "error" || working.save === "conflict") throw new Error("Save your ontology changes before starting alignment.");
      return api.startAlignment(pid, selectedId!, effectiveSetup, rev.data?.contentHash);
    },
    onSuccess: async (r) => {
      qc.setQueryData(qk.run(pid, r.id), r);
      await qc.invalidateQueries({ queryKey: qk.runs(pid) });
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("run", r.id);
        return next;
      });
      if (!config?.features?.worker) driver.start(r.id);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.revision(pid, selectedId!) });
    },
  });
  const busy = upload.isPending || saveSetup.isPending || align.isPending;
  const parsed = useMemo(
    () =>
      modules.map((m) => {
        try {
          return { module: m, model: parseTBox(m.turtle), error: null };
        } catch (e) {
          return { module: m, model: null, error: String(e) };
        }
      }),
    [modules],
  );
  const records = rev.data?.content.review?.alignmentRuns ?? [];
  const latest = records.at(-1);
  const inspected = records.find((record) => record.id === params.get("comparison")) ?? latest;
  const terms = useMemo(() => alignmentTerms(modules), [modules]);
  const sourceCount = new Set(terms.filter((term) => source.includes(term.moduleId)).map((term) => `${term.kind}:${term.uri}`)).size;
  const targetCount = new Set(terms.filter((term) => target.includes(term.moduleId)).map((term) => `${term.kind}:${term.uri}`)).size;
  const planned = setup.maxSource === null ? sourceCount : Math.min(sourceCount, setup.maxSource);
  const missing = [...source, ...target].some((id) => !standards.some((module) => module.id === id));
  const parseErrors = parsed.some(({ module, error }) => !!error && [...source, ...target].includes(module.id));
  const staleMappings = (rev.data?.content.review?.alignment ?? []).filter((mapping) => !mappingIsCurrent(mapping, rev.data!.content));
  const mappings = rev.data?.content.review?.alignment ?? [];
  const estimateReady =
    step === "match" &&
    !!selectedId &&
    !!sourceCount &&
    !!targetCount &&
    !missing &&
    !parseErrors &&
    (matchers.lexical || matchers.semantic) &&
    (!verify || modelReady) &&
    !busy;
  const estimate = useQuery({
    queryKey: ["alignment-estimate", pid, selectedId, rev.data?.contentHash, effectiveSetup],
    queryFn: ({ signal }) => api.estimateAlignment(pid, selectedId!, effectiveSetup, rev.data?.contentHash, signal),
    enabled: estimateReady,
    staleTime: 60_000,
  });
  const overBudget =
    estimate.data?.usd != null &&
    project?.settings.budget?.maxUsdPerRun != null &&
    estimate.data.usd > project.settings.budget.maxUsdPerRun;

  return (
    <div className="workflow-stack">
      <label className="field workflow-revision">
        <span>Ontology version / alignment draft</span>
        <select
          disabled={busy}
          value={selectedId ?? ""}
          onChange={(e) =>
            setParams((old) => {
              const next = new URLSearchParams(old);
              next.set("rev", e.target.value);
              next.delete("run");
              return next;
            })
          }
        >
          <option value="" disabled>
            Choose a version or draft, or import ontologies
          </option>
          {revisions.map((r) => (
            <option key={r.id} value={r.id}>
              {revisionLabel(r)} · {r.summary}
            </option>
          ))}
        </select>
      </label>
      <InlineError error={rev.error ?? upload.error ?? saveSetup.error ?? align.error} />
      <BudgetRecovery error={align.error ?? estimate.error} />
      {rev.isLoading && <LoadingState />}
      <AlignmentRunPanel
        onReview={async (id) => {
          await qc.invalidateQueries({ queryKey: qk.revisions(pid) });
          await qc.invalidateQueries({ queryKey: qk.revision(pid, id) });
          setParams((p) => {
            const next = new URLSearchParams(p);
            next.set("rev", id);
            next.set("step", "merge");
            return next;
          });
        }}
      />
      {!!modules.length && (
        <div className="alignment-scope" aria-label="Current comparison">
          <span>
            <strong>Source</strong>
            {standards
              .filter((m) => source.includes(m.id))
              .map((m) => m.name)
              .join(", ") || "Choose source modules"}
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <strong>Target</strong>
            {standards
              .filter((m) => target.includes(m.id))
              .map((m) => m.name)
              .join(", ") || "Choose target modules"}
          </span>
          <small role="status">
            {saveSetup.isPending
              ? "Saving comparison…"
              : saveSetup.isError
                ? "Setup not saved"
                : rev.data?.status === "committed"
                  ? "Saved ontology · changes create a draft"
                  : rev.data?.content.review?.alignmentSetup
                    ? "Comparison setup saved"
                    : "Choose modules and settings to save your setup"}
          </small>
        </div>
      )}
      {!!staleMappings.length && (
        <p className="banner warn">
          {staleMappings.length} mappings refer to changed inputs. Run matching again before relying on them. Previously accepted mappings
          affected by changed inputs will return to review in this draft.
        </p>
      )}
      {step === "merge" && latest && latest.diagnostics.processedSourceTerms < latest.diagnostics.sourceTerms && (
        <div className="banner warn">
          <p>
            This comparison processed {latest.diagnostics.processedSourceTerms} of {latest.diagnostics.sourceTerms} source terms. The
            remaining terms have not been checked.
          </p>
          <button className="btn ghost sm" onClick={() => go("match")}>
            Adjust source coverage
          </button>
        </div>
      )}
      {step === "sources" && (
        <>
          <h2>Choose ontologies to compare</h2>
          <p>
            Use the modules in the selected ontology version, or import two or more files. Compare your TBOX with a standard, or compare
            imported ontologies. Changes are saved in a draft.
          </p>
          <Dropzone
            title="Add ontology files"
            hint="Turtle, RDF/XML, OWL or JSON-LD"
            formats={[".ttl", ".rdf", ".owl", ".jsonld", ".nt"]}
            accept=".ttl,.rdf,.owl,.jsonld,.nt,.n3"
            multiple
            onFiles={(files) => {
              if (!busy) upload.mutate(files);
            }}
          />
          {upload.isPending && <LoadingState label="Parsing ontology files…" />}
          <ResultTable
            label="Imported modules"
            rows={parsed.map(({ module: m, model: t, error }) => ({
              name: m.name,
              classes: t?.classes.length ?? 0,
              properties: t ? t.objectProps.length + t.dataProps.length : 0,
              error,
            }))}
            columns={["name", "classes", "properties", "error"]}
          />
          <MethodDetails>
            <p>
              RDF is parsed and normalized to Turtle. Ontology files already contain structured statements: they are not split into document
              chunks or sent through document extraction. The parsed T-Box indexes named classes, properties, hierarchies and supported
              restrictions. Referenced imports are not automatically fetched.
            </p>
          </MethodDetails>
        </>
      )}
      {step === "terms" && (
        <>
          <h2>Inspect what was parsed</h2>
          {!modules.length && <p>Import standards in the first step.</p>}
          {parsed.map(({ module: m, model: t, error }) => (
            <details className="method-details" key={m.id}>
              <summary>
                {m.name} · {t?.classes.length ?? 0} classes · {t ? t.objectProps.length + t.dataProps.length : 0} properties
              </summary>
              <div className="method-details-body">
                {error ? (
                  <p role="alert">{error}</p>
                ) : (
                  <>
                    <ResultTable
                      label="Classes"
                      rows={(t?.classes ?? []).map((c) => ({ ...c, parents: t?.subClassOf[c.uri] }))}
                      columns={["uri", "label", "comment", "parents"]}
                    />
                    <ResultTable
                      label="Properties"
                      rows={[...(t?.objectProps ?? []), ...(t?.dataProps ?? [])].map((p) => ({ ...p }))}
                      columns={["uri", "kind", "domain", "range", "functional"]}
                    />
                    <JsonDetails label="Complete parsed T-Box" value={t} />
                  </>
                )}
                <details>
                  <summary>Stored ontology Turtle</summary>
                  <pre className="ttl-preview">{m.turtle}</pre>
                </details>
              </div>
            </details>
          ))}
        </>
      )}
      {step === "match" && (
        <>
          <h2>Choose the comparison</h2>
          <p>
            Choose source and target groups. Settings are saved to this draft as you change them. Modules within each group are combined
            before matching.
          </p>
          <fieldset className="alignment-setup" disabled={busy || !selectedId}>
            <legend className="sr-only">Comparison setup</legend>
            {standards.map((m) => (
              <label className="workflow-module-group" key={m.id}>
                <span>{m.name}</span>
                <select
                  aria-label={`Group for ${m.name}`}
                  value={group(m.id)}
                  onChange={(e) =>
                    changeSetup({
                      sourceModules: [...source.filter((id) => id !== m.id), ...(e.target.value === "source" ? [m.id] : [])],
                      targetModules: [...target.filter((id) => id !== m.id), ...(e.target.value === "target" ? [m.id] : [])],
                    })
                  }
                >
                  <option value="source">Source</option>
                  <option value="target">Target</option>
                  <option value="skip">Exclude</option>
                </select>
              </label>
            ))}
            <MethodDetails title="Matching methods & model verification">
              <p>
                Lexical similarity compares names. Semantic similarity compares embedded term descriptions. Structural matching uses
                neighboring terms and high-scoring anchors. Retrieval scores are similarity measures, not calibrated probabilities.
              </p>
              <div className="row-actions">
                {(["lexical", "semantic", "structural"] as const).map((k) => (
                  <label className="check" key={k}>
                    <input
                      type="checkbox"
                      checked={matchers[k]}
                      onChange={(e) => changeSetup({ matchers: { ...matchers, [k]: e.target.checked } })}
                    />
                    {k}
                  </label>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={verify} onChange={(e) => changeSetup({ verify: e.target.checked, provider, model })} />
                Use a language model to classify candidate relations
              </label>
              {verify && (
                <ProviderModelSelect
                  providers={choice.providers}
                  provider={provider as typeof choice.provider}
                  model={model}
                  models={providerInfo?.models ?? []}
                  onProvider={(id) =>
                    changeSetup({
                      provider: id,
                      model:
                        choice.providers
                          .find((p) => p.id === id)
                          ?.models.find((m) => !choice.providers.find((p) => p.id === id)?.chatOnlyModels?.includes(m)) ?? "",
                    })
                  }
                  onModel={(model) => changeSetup({ model })}
                  structuredOnly
                  compact
                  disabled={busy}
                />
              )}
              {verify && !modelReady && (
                <p className="banner warn">The saved model is unavailable. Choose an enabled model or turn off model classification.</p>
              )}
              <p>
                Without model verification, accepted candidates produce skos:closeMatch links. They do not assert logical equivalence.
                Structural matching needs lexical or semantic seeds.
              </p>
            </MethodDetails>
            <label className="field">
              <span>Source coverage</span>
              <select
                value={setup.maxSource ?? "all"}
                onChange={(e) => changeSetup({ maxSource: e.target.value === "all" ? null : Number(e.target.value) })}
              >
                {[...new Set([150, 500, 1000, ...(setup.maxSource == null ? [] : [setup.maxSource])])]
                  .sort((a, b) => a - b)
                  .map((limit) => (
                    <option key={limit} value={limit}>
                      Up to {limit} source terms
                    </option>
                  ))}
                <option value="all">Every source term</option>
              </select>
            </label>
          </fieldset>
          <section className="alignment-plan" aria-label="Comparison plan">
            <h3>Comparison plan</h3>
            <p>
              <strong>
                {planned} of {sourceCount}
              </strong>{" "}
              source terms will be processed against <strong>{targetCount}</strong> target terms.
            </p>
            {planned < sourceCount && (
              <p className="banner warn">
                This is a partial comparison. {sourceCount - planned} source terms will not be processed. Choose every source term for full
                coverage.
              </p>
            )}
            {estimate.isFetching && <p role="status">Estimating the comparison…</p>}
            <InlineError error={estimate.error} />
            {estimate.data && (
              <>
                <p>
                  Up to {estimate.data.maxCandidatePairs.toLocaleString()} candidate pairs · up to{" "}
                  {estimate.data.modelCalls.toLocaleString()} model calls.
                  {estimate.data.modelCalls > 0 &&
                    ` Approximately ${estimate.data.inputTokens.toLocaleString()} input and ${estimate.data.outputTokens.toLocaleString()} output tokens.`}
                </p>
                <p>
                  <strong>
                    Estimated generation cost:{" "}
                    {estimate.data.usd == null ? "price unavailable for this model" : `≈ $${estimate.data.usd.toFixed(4)}`}
                  </strong>
                  .
                </p>
                <p className="muted">
                  Planning allowance based on at most two candidate pairs per source term. Actual usage depends on retrieval and model
                  responses; retries can add cost.
                  {estimate.data.embeddingCostExcluded
                    ? " Embedding API charges are additional and excluded from this estimate and spend totals."
                    : " No embedding API charge is included."}
                  {estimate.data.usd == null && " Token usage will still be recorded; a dollar total is unavailable."}
                </p>
                {overBudget && (
                  <p className="banner warn">
                    This estimate exceeds the project’s per-run budget. Reduce source coverage or adjust the budget in Settings.
                  </p>
                )}
              </>
            )}
            {!verify && (
              <p>No generation model will be called. Review or correct similarity suggestions before making logical assertions.</p>
            )}
            <p>
              {config?.features?.worker
                ? "The comparison will run in the background."
                : "Keep this project tab open during processing; this server has no background worker."}{" "}
              You can pause and resume from saved checkpoints. Results are saved in a separate draft from a frozen copy of these inputs.
            </p>
            <p>
              Existing decisions with unchanged inputs are retained. Changed inputs return affected mappings to review; only accepted
              mappings enter the draft bridge.
            </p>
            {missing && <p className="banner warn">Some saved modules are missing. Reassign the available modules before matching.</p>}
            {parseErrors && <p className="banner error">Fix the parse errors in the selected modules before matching.</p>}
            {(!sourceCount || !targetCount) && <p>Choose at least one parseable source and target containing named terms.</p>}
            {!matchers.lexical && !matchers.semantic && (
              <p>Enable lexical or semantic matching. Structural matching needs initial candidates.</p>
            )}
            {activeRun && (
              <p className="banner warn">
                A run is already active in this project. Finish, pause or cancel it before starting another comparison.
              </p>
            )}
            <button
              className="btn"
              disabled={
                !estimate.data ||
                estimate.isFetching ||
                !!estimate.error ||
                overBudget ||
                !!activeRun ||
                !selectedId ||
                !sourceCount ||
                !targetCount ||
                missing ||
                parseErrors ||
                (!matchers.lexical && !matchers.semantic) ||
                busy ||
                (verify && !modelReady)
              }
              onClick={() => align.mutate()}
            >
              {align.isPending ? "Starting comparison…" : latest ? "Run comparison again" : "Find matches"}
            </button>
          </section>
          {latest && <AlignmentCoverage record={latest} stale={!!rev.data && !comparisonIsCurrent(latest, rev.data.content)} />}
        </>
      )}
      {step === "merge" &&
        (rev.data ? (
          <>
            <AlignmentReviewWorkspace revision={rev.data} onChanged={invalidate} onFindMatches={() => go("match")} />
            {latest && <AlignmentCoverage record={latest} stale={!comparisonIsCurrent(latest, rev.data.content)} />}
            {modules.find((m) => m.name === ALIGNMENT_MODULE) && (
              <MethodDetails title="Accepted mapping bridge (Turtle)">
                <pre className="ttl-preview">{modules.find((m) => m.name === ALIGNMENT_MODULE)!.turtle}</pre>
              </MethodDetails>
            )}
          </>
        ) : (
          <p>Choose or import ontologies first.</p>
        ))}
      {step === "validate" &&
        (selectedId ? (
          <>
            {!!staleMappings.length && <p className="banner warn">Review the changed mapping inputs before saving an ontology version.</p>}
            <ValidationView
              key={selectedId}
              pid={pid}
              revisionId={selectedId}
              showCommit={!staleMappings.some((m) => m.status === "accepted")}
            />
            {rev.data?.status === "committed" && (
              <section className="build-next-actions">
                <h3>Use this aligned ontology</h3>
                <p>The saved version contains the original ontology modules and accepted mapping bridge.</p>
                <div className="row-actions">
                  <Link className="btn" to={`/p/${pid}/graphs?ontology=${selectedId}`}>
                    Create knowledge graph →
                  </Link>
                  <Link className="btn ghost" to={`/p/${pid}/export?rev=${selectedId}`}>
                    Download ontology
                  </Link>
                  <Link to={`/p/${pid}/ontology?rev=${selectedId}`}>Open ontology</Link>
                </div>
              </section>
            )}
          </>
        ) : (
          <p>Import ontologies first.</p>
        ))}
      {(step === "match" || step === "merge") && !!records.length && (
        <label className="field">
          <span>Inspect comparison history</span>
          <select
            value={inspected?.id ?? ""}
            onChange={(e) =>
              setParams((p) => {
                const next = new URLSearchParams(p);
                next.set("comparison", e.target.value);
                return next;
              })
            }
          >
            {records.map((record, i) => (
              <option key={record.id} value={record.id}>
                Comparison {i + 1} · {new Date(record.createdAt).toLocaleString()} · {record.diagnostics.processedSourceTerms}/
                {record.diagnostics.sourceTerms} terms
              </option>
            ))}
          </select>
          <small>Historical scores and inputs are read-only. The review workspace shows your current decisions.</small>
        </label>
      )}
      {(step === "match" || step === "merge") && inspected && (
        <MethodDetails title="Recorded matcher scores">
          <TechnicalResults
            results={[
              {
                title: "Recorded alignment scores",
                method: "base = max(lexical, max(0, cosine)); score = max(base, 0.75 × base + 0.25 × structural)",
                parameters: {
                  embedder: inspected.diagnostics.embedder,
                  ...inspected.diagnostics.matchers,
                  ...inspected.diagnostics.parameters,
                  maxSource: inspected.diagnostics.parameters.maxSource ?? "All source terms",
                  verifiedPairs: inspected.diagnostics.verifiedPairs,
                },
                columns: [
                  "source",
                  "target",
                  "lexical",
                  "cosine",
                  "structural",
                  "combinedScore",
                  "relation",
                  "verified",
                  "proposalDecision",
                ],
                rows: inspected.candidates.map((c) => ({
                  source: c.source,
                  target: c.target,
                  lexical: inspected.diagnostics.matchers.lexical ? c.scores?.lexical : null,
                  cosine: c.cosine ?? null,
                  structural: inspected.diagnostics.matchers.structural ? c.scores?.structural : null,
                  combinedScore: c.score,
                  relation: c.relation,
                  verified: c.verified,
                  proposalDecision: mappings.some((m) => m.source === c.source && m.target === c.target)
                    ? "Proposed mapping"
                    : c.relation === "unrelated"
                      ? "Rejected by verifier"
                      : "Retrieved alternative",
                })),
                note: "These are candidates that survived retrieval, not all source–target pairs. Negative cosine values are clamped to zero for the combined score. Null cosine means no raw value was recorded. Matcher and combined scores retain their existing three-decimal precision; model verification assigns relations rather than a new probability.",
              },
            ]}
          />
        </MethodDetails>
      )}
      {(step === "match" || step === "merge") && (
        <MethodDetails title="Research trace: retrieval, verification & merge decisions">
          {inspected ? (
            <>
              <p>
                Saved input revision hash: <code>{inspected.inputHash}</code>. Engine: {inspected.diagnostics.embedder ?? "no embeddings"}.
                Verification: {inspected.provider ? `${inspected.provider}/${inspected.model}` : "disabled"}. Duration:{" "}
                {inspected.durationMs} ms.
              </p>
              <p>
                Same-kind pairs pass the prefilter; retrieval keeps the best candidates per source. Verification can classify pairs as
                unrelated; these remain in the trace. Final proposals keep the best pair per source and relation.
              </p>
              <JsonDetails label="Exact matcher configuration, thresholds & counts" value={inspected.diagnostics} />
              <ResultTable
                label="All retrieved candidates, including unrelated pairs"
                rows={inspected.candidates.map((c) => ({ ...c }))}
                columns={["source", "target", "relation", "scores", "score", "verified", "rationale"]}
              />
              <JsonDetails label="Acceptance decisions and coherence conflicts" value={inspected.decisions} />
              <JsonDetails label="Original source and target modules" value={inspected.modules} />
              <button
                className="btn ghost"
                onClick={() =>
                  saveJson(
                    { setup, comparisons: records, mappings, decisions: rev.data?.content.review?.alignmentDecisions ?? [] },
                    "alignment-workspace.json",
                  )
                }
              >
                Export comparison & review history ({records.length})
              </button>
            </>
          ) : (
            <p>No saved alignment trace. Older comparisons may predate trace capture; run matching to record the inputs and methods.</p>
          )}
        </MethodDetails>
      )}
    </div>
  );
}
