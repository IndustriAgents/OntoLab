import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/projectApi";
import { STAGE_METHODS } from "../../lib/research";
import type { JobCheckpoint, RunStep } from "../../types/project";
import type { RunResearch } from "../../types/research";
import { ErrorState, LoadingState, StatusBadge, fmtDate } from "../../components/ui/ui";
import { ABoxResults, JsonDetails, PayloadResults, ResultTable, saveJson } from "./ResearchResults";
import { TechnicalResults } from "./TechnicalResults";
import { ChunkBrowser } from "./ChunkLab";
import "./research.css";
import { useEvidenceViewer } from "../evidence/useEvidence";

function statusOf(report: RunResearch, step: RunStep, cp: JobCheckpoint | undefined) {
  if (cp?.via === "screen") return "Screened out";
  if (cp?.via === "cache") return "Cached";
  if (cp) return "Completed";
  if (step.kind === "finalize" && report.run.resultRevisionId) return "Draft saved";
  if (report.run.status === "failed" && report.run.steps.find((s) => !report.checkpoints.some((c) => c.key === s.key))?.key === step.key)
    return "Failed";
  if (report.run.nextStep?.key === step.key && report.run.lease) return "In progress";
  return "No checkpoint";
}

function SampledInputs({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return null;
  const docs = value.filter(
    (d): d is { name: string; text: string; chunkId: string; start: number } => d && typeof d === "object" && typeof d.text === "string",
  );
  return (
    <div>
      <h3>Passages actually sent to the model</h3>
      <p className="field-hint">These are the recorded model inputs. Historical runs may contain sampled or shortened passages.</p>
      {docs.map((d, i) => (
        <details key={i} className="research-json">
          <summary>
            {d.name} · {d.text.length.toLocaleString()} characters · offset {d.start}
          </summary>
          <pre>{d.text}</pre>
        </details>
      ))}
    </div>
  );
}

function StageView({ report, step, cp, pid }: { report: RunResearch; step: RunStep; cp?: JobCheckpoint; pid: string }) {
  const evidence = useEvidenceViewer(pid);
  const [tab, setTab] = useState<"output" | "input" | "parameters">("output");
  const method = STAGE_METHODS[step.kind];
  const sourceIds = step.chunkIds ?? (step.chunkId ? [step.chunkId] : []);
  const chunks =
    report.inputs?.chunks.filter((c) => sourceIds.includes(c.id) || (step.kind === "summary" && c.documentId === step.documentId)) ?? [];
  const state = statusOf(report, step, cp);
  return (
    <section className="card research-stage">
      <div className="research-section-head">
        <div>
          <span className="research-eyebrow">
            {step.kind} / {step.key}
          </span>
          <h2>{method.title}</h2>
        </div>
        <StatusBadge tone={state === "Failed" ? "alert" : cp?.via === "screen" ? "warn" : cp ? "ok" : "muted"}>{state}</StatusBadge>
      </div>
      <p className="muted">{step.label}</p>
      <p className="stage-method-summary">
        <strong>Method: </strong>
        {method.method}
      </p>
      <details className="method-details">
        <summary>Method & execution details</summary>
        <div className="method-details-body">
          <div className="research-method">
            <div className="research-io">
              <div>
                <strong>Input</strong>
                <span>{method.input}</span>
              </div>
              <div>
                <strong>Output</strong>
                <span>{method.output}</span>
              </div>
            </div>
          </div>
          <div className="research-metrics">
            <div>
              <small>Execution time</small>
              <strong>{cp?.trace ? `${(cp.trace.durationMs / 1000).toFixed(2)} s` : "—"}</strong>
              <span>{cp?.trace ? "Recorded wall time" : "Not recorded"}</span>
            </div>
            <div>
              <small>Input / output tokens</small>
              <strong>{cp ? `${cp.usage.inputTokens.toLocaleString()} / ${cp.usage.outputTokens.toLocaleString()}` : "—"}</strong>
              <span>Recorded model usage</span>
            </div>
            <div>
              <small>Individuals</small>
              <strong>{cp?.abox.individuals.length ?? "—"}</strong>
              <span>{step.kind === "chunk" ? "This chunk's output" : "Saved stage output"}</span>
            </div>
          </div>
        </div>
      </details>
      <div className="research-tabs" role="group" aria-label="Stage detail">
        {(["output", "input", "parameters"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === "output" ? "Results" : t === "input" ? "Inputs & lineage" : "Parameters & tuning"}
          </button>
        ))}
      </div>
      {tab === "output" && (
        <div className="research-stack">
          <TechnicalResults results={[...(step.technical ?? []), ...(cp?.trace?.technical ?? [])]} />
          {cp && !step.technical?.length && !cp.trace?.technical?.length && ["terms", "merge", "chunk", "resolve"].includes(step.kind) && (
            <p className="field-hint">
              {cp.via === "cache"
                ? "Cached result: this execution did not recompute similarity scores."
                : "Numerical comparison records are unavailable for this checkpoint. Older runs cannot show scores that were not captured."}
            </p>
          )}
          {cp?.trace?.diagnostics && (
            <ResultTable
              label="Recorded execution measurements"
              rows={Object.entries(cp.trace.diagnostics)
                .filter(([, v]) => v == null || typeof v !== "object")
                .map(([measurement, value]) => ({ measurement, value }))}
              columns={["measurement", "value"]}
            />
          )}
          {!cp ? (
            <div className="banner subtle">
              {step.kind === "finalize" && report.run.resultRevisionId
                ? "This older run created a draft but did not save a final-stage snapshot. Open the revision to inspect its current content."
                : report.run.status === "failed"
                  ? `No successful checkpoint for this step. Run error: ${report.run.error ?? "not recorded"}`
                  : "There is no saved result for this step yet. Pending, failed and cancelled steps do not have fabricated outputs."}
            </div>
          ) : (
            <>
              {cp.via === "cache" && (
                <div className="banner subtle">
                  This result was reused from the extraction/summary cache. No new generation call was made for this checkpoint. The
                  original call's prompt context and timing are not recorded here.
                </div>
              )}
              {cp.via === "screen" && (
                <div className="banner warn">
                  Relevance screening skipped extraction. An empty output here means “not processed”, not “the passage contains no facts”.
                </div>
              )}
              {cp.summary !== undefined && (
                <div className="research-summary">
                  <h3>Generated document summary</h3>
                  <p>{cp.summary || "Empty summary returned."}</p>
                </div>
              )}
              {!!cp.abox.individuals.length && <ABoxResults abox={cp.abox} pid={pid} runId={report.run.id} />}
              {cp.payload !== undefined && <PayloadResults payload={cp.payload} />}
              {cp.candidates && (
                <ResultTable
                  label="Entity-resolution candidates"
                  rows={cp.candidates.map((c) => ({ ...c }))}
                  columns={["label", "ids", "method", "score", "decision"]}
                />
              )}
              {cp.unmatched && (
                <ResultTable
                  label="Unmatched ontology terms"
                  rows={cp.unmatched.map((c) => ({ ...c }))}
                  columns={["name", "kind", "definition", "quote"]}
                />
              )}
              {cp.questions && (
                <ResultTable label="Clarification questions" rows={cp.questions.map((c) => ({ ...c }))} columns={["text", "options"]} />
              )}
              {cp.notes.length > 0 && (
                <div>
                  <h3>Execution notes</h3>
                  <ul className="notes">
                    {cp.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
              {cp.trace?.diagnostics && <JsonDetails label="Execution diagnostics" value={cp.trace.diagnostics} />}
              {!cp.abox.individuals.length && !cp.payload && cp.summary === undefined && !cp.notes.length && (
                <p className="muted">This checkpoint recorded no individuals or other output artifacts.</p>
              )}
              <JsonDetails label="Complete saved checkpoint · JSON" value={cp} />
            </>
          )}
          {step.kind === "finalize" && report.run.resultRevisionId && (
            <div className="row-actions">
              <Link
                className="btn"
                to={`/p/${pid}/${report.run.kind === "alignment" ? "workflows/alignment?step=merge&" : report.run.kind === "induction" ? "ontology?tab=review&" : "explore?"}rev=${report.run.resultRevisionId}`}
              >
                Open draft revision
              </Link>
              <Link className="btn ghost" to={`/p/${pid}/validate?rev=${report.run.resultRevisionId}`}>
                Validation & competency questions
              </Link>
            </div>
          )}
        </div>
      )}
      {tab === "input" && (
        <div className="research-stack">
          <p className="field-hint">
            Inputs below come from the run's saved snapshot. Checkpoint references identify the earlier outputs available to this step.
            These are processing artifacts, not hidden model reasoning.
          </p>
          {!report.inputs && (
            <div className="banner warn">
              This run predates input snapshots. Current document text is not substituted for historical inputs.
            </div>
          )}
          {chunks.length > 0 && (
            <>
              <p className="field-hint">
                {chunks.length} saved source chunk(s)
                {step.kind === "summary"
                  ? "; the summary call reads up to the first 60,000 characters of the parsed document, rather than these chunks separately"
                  : ""}
                .
              </p>
              <ChunkBrowser
                chunks={chunks}
                onInspect={(chunk) =>
                  evidence.openTarget({
                    kind: "passage",
                    runId: report.run.id,
                    documentId: chunk.documentId,
                    chunkId: chunk.id,
                    stepKey: step.key,
                  })
                }
              />
            </>
          )}
          <SampledInputs value={cp?.trace?.input?.sampledDocuments} />
          {cp?.trace?.input ? (
            <JsonDetails label="Recorded stage inputs, schema and context" value={cp.trace.input} />
          ) : (
            <p className="muted">Detailed execution inputs were not recorded for this checkpoint.</p>
          )}
          <JsonDetails
            label="Planned input references"
            value={{ documentId: step.documentId, chunkIds: sourceIds, baseRevisionId: report.run.baseRevisionId }}
          />
          {report.inputs && <JsonDetails label="Requirements at run creation" value={report.inputs.requirements} />}
          {report.inputs?.baseRevision && (
            <JsonDetails label="Pinned base revision · ontology and existing individuals" value={report.inputs.baseRevision} />
          )}
        </div>
      )}
      {tab === "parameters" && (
        <div className="research-stack">
          <div className="research-method">
            <h3>What to vary in an experiment</h3>
            <p>{method.tuning}</p>
            <div className="row-actions">
              <Link to={`/p/${pid}/research?view=documents`}>Chunking experiments</Link>
              <Link to={`/p/${pid}/runs`}>Extraction controls</Link>
              <Link to={`/p/${pid}/ontology`}>Induction controls</Link>
              <Link to={`/p/${pid}`}>Project model settings</Link>
            </div>
          </div>
          <p className="field-hint">
            Run configuration records the selected settings. Execution diagnostics, when available, report the backend actually used after
            fallback. Fixed algorithm limits are described above; changing a project setting does not rerun an existing checkpoint.
          </p>
          <dl className="research-kv">
            <dt>Provider / model</dt>
            <dd>
              {report.run.provider} / {report.run.model}
            </dd>
            <dt>Prompt version</dt>
            <dd>{report.run.config?.promptVersion ?? "Not recorded"}</dd>
            <dt>Prompt rendering</dt>
            <dd>{report.run.config?.promptStyle ?? "Not recorded"}</dd>
            <dt>Schema retrieval</dt>
            <dd>
              {report.run.config
                ? `${report.run.config.schemaRetrieval} · top-k ${report.run.config.schemaTopK} · threshold ${report.run.config.schemaMinTerms} terms`
                : "Not recorded"}
            </dd>
            <dt>Embedding model</dt>
            <dd>{report.run.config?.embedder ?? "Off / not recorded"}</dd>
            <dt>NLI backend</dt>
            <dd>{report.run.config?.nli ?? "Not recorded"}</dd>
            <dt>Relevance / review / acceptance thresholds</dt>
            <dd>
              {report.run.config
                ? `${report.run.config.relevanceThreshold} / ${report.run.config.nliReviewThreshold} / ${report.run.config.acceptAt ?? "not recorded"}`
                : "Not recorded"}
            </dd>
          </dl>
          <JsonDetails label="All recorded options and configuration" value={{ options: report.run.options, config: report.run.config }} />
        </div>
      )}
    </section>
  );
}

export function RunInspector({
  pid,
  runId,
  compact = false,
  initialStep,
}: {
  pid: string;
  runId: string;
  compact?: boolean;
  initialStep?: string;
}) {
  const report = useQuery({
    queryKey: ["run-research", pid, runId],
    queryFn: () => api.runResearch(pid, runId),
    refetchInterval: (q) => (q.state.data && ["running", "queued"].includes(q.state.data.run.status) ? 5000 : false),
  });
  const [selected, setSelected] = useState<string | null>(initialStep ?? null);
  if (report.isLoading) return <LoadingState label="Loading recorded pipeline artifacts…" />;
  if (report.error || !report.data) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const data = report.data;
  const planned = new Set(data.run.steps.map((s) => s.key));
  const steps: RunStep[] = [...data.run.steps];
  const qa = data.checkpoints
    .filter((c) => !planned.has(c.key) && c.key.startsWith("qa:"))
    .map((c) => ({ key: c.key, kind: "qa" as const, label: `Clarification round ${c.key.split(":")[1]}` }));
  if (qa.length) {
    const at = steps.findIndex((s) => ["ground", "resolve", "verify", "finalize"].includes(s.kind));
    steps.splice(at < 0 ? steps.length : at, 0, ...qa);
  }
  const byKey = new Map(data.checkpoints.map((c) => [c.key, c]));
  const current = steps.find((s) => !byKey.has(s.key));
  const step =
    steps.find((s) => s.key === selected) ?? (["running", "queued", "failed"].includes(data.run.status) ? current : undefined) ?? steps[0];
  return (
    <div className="research-stack">
      {!compact && (
        <section className="card">
          <div className="research-section-head">
            <div>
              <span className="research-eyebrow">
                {data.run.kind === "alignment"
                  ? "Ontology alignment"
                  : data.run.kind === "induction"
                    ? "T-Box / ontology induction"
                    : "A-Box / instance extraction"}
              </span>
              <h2>Run evidence</h2>
            </div>
            <button className="btn ghost" onClick={() => saveJson(data, `${data.run.kind ?? "extraction"}-${data.run.id}-research.json`)}>
              Export research record
            </button>
          </div>
          <p className="muted">
            {fmtDate(data.run.createdAt)} · {data.run.provider}/{data.run.model} · {data.run.status.replaceAll("_", " ")}
          </p>
          <p className="field-hint">
            Select a stage to inspect its method, recorded inputs and actual output. Completion is determined by checkpoint keys, including
            parallel steps.
          </p>
          <div className="row-actions">
            <StatusBadge tone={data.inputs ? "ok" : "warn"}>
              {data.inputs ? "Source snapshot available" : "Historical input snapshot unavailable"}
            </StatusBadge>
            <Link to={`/p/${pid}/runs/${runId}`}>Run controls & progress</Link>
          </div>
          <details className="research-json">
            <summary>Input documents and fingerprints</summary>
            <ResultTable
              label="Document inputs"
              rows={(data.inputs?.documents ?? []).map((d) => ({
                name: d.name,
                checksum: d.checksum,
                parser: d.parser,
                chunks: d.chunkCount,
                preprocessing: d.preprocessing?.settings ?? "Not recorded",
              }))}
              columns={["name", "parser", "chunks", "preprocessing", "checksum"]}
            />
          </details>
        </section>
      )}
      {compact && (
        <div className="workflow-inspector-toolbar">
          <label className="field">
            <span>Processing stage</span>
            <select value={step?.key ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {steps.map((s) => (
                <option value={s.key} key={s.key}>
                  {STAGE_METHODS[s.kind].title} · {s.label} · {statusOf(data, s, byKey.get(s.key))}
                </option>
              ))}
            </select>
          </label>
          <button className="btn ghost sm" onClick={() => saveJson(data, `${runId}-research.json`)}>
            Export trace
          </button>
        </div>
      )}
      <div className={compact ? "workflow-inspector" : "research-pipeline"}>
        {!compact && (
          <nav className="research-stage-list" aria-label="Pipeline stages">
            {steps.map((s, i) => {
              const cp = byKey.get(s.key);
              return (
                <button
                  key={s.key}
                  aria-pressed={step?.key === s.key}
                  onClick={() => setSelected(s.key)}
                  className={step?.key === s.key ? "is-selected" : ""}
                >
                  <span className="research-stage-number">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{STAGE_METHODS[s.kind].title}</strong>
                    <small>{s.label}</small>
                    <span className="research-stage-state">{statusOf(data, s, cp)}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        {step && <StageView key={step.key} report={data} step={step} cp={byKey.get(step.key)} pid={pid} />}
      </div>
      <p className="field-hint">
        Export contains source text and saved results. Token counts are recorded counters; provider-based evidence judging may not be
        included. Stage outputs have not been independently evaluated for research accuracy.
      </p>
    </div>
  );
}
