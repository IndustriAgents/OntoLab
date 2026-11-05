import { SourceInspector } from "./SourceInspector";
import type { AnswerPassage } from "../../types/sourceEvidence";
// The evidence window beside the chat (from kg_chatbot): for the selected
// answer, the evidence graph, every SPARQL query, the raw results, the answer
// with its citations, and the trace of reasoning and tool calls.

import { useEffect, useMemo, useState } from "react";
import type { SparqlRun, Term } from "../../types/graphChat";
import { IconClose } from "../../components/icons";
import { EvidenceGraphView } from "./EvidenceGraphView";
import { Markdown } from "./Markdown";
import { SparqlCode } from "./SparqlCode";
import {
  citedIds,
  formatMs,
  makeCompactor,
  plural,
  queryLine,
  toolLabel,
  workbenchSparqlUrl,
  type Compactor,
  type Turn,
} from "./graphChat";

export type PanelTab = "sources" | "graph" | "sparql" | "results" | "answer" | "trace";

interface Props {
  pid: string;
  conversationId?: string;
  focusSource?: string;
  onUsePassage?: (p: AnswerPassage) => void;
  onOpenDocument?: (p: AnswerPassage) => void;
  turn?: Turn;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  focusQuery?: string;
  onFocusQuery: (id?: string) => void;
  theme: "light" | "dark";
  onClose: () => void;
  onIndividual: (id: string) => void;
  onSource: (ref: string) => void;
}

export function EvidencePanel({
  pid,
  conversationId,
  focusSource,
  onUsePassage,
  onOpenDocument,
  turn,
  tab,
  onTab,
  focusQuery,
  onFocusQuery,
  theme,
  onClose,
  onIndividual,
  onSource,
}: Props) {
  if (!turn) {
    return (
      <aside className="gc-panel" aria-label="Evidence window">
        <div className="gc-empty">
          <h2>Every answer, shown in full</h2>
          <p>When you ask a question, this window shows how the answer was produced from your graph.</p>
          <ol className="gc-steps">
            <li>
              <b>Queries</b> — each query the assistant ran, highlighted.
            </li>
            <li>
              <b>Results</b> — the rows each query returned.
            </li>
            <li>
              <b>Evidence graph</b> — the triples that matched, rebuilt from the query patterns and their bindings.
            </li>
            <li>
              <b>Answer and trace</b> — the answer with its citations, and every step and tool call.
            </li>
          </ol>
        </div>
      </aside>
    );
  }
  const agentRuns = turn.runs.filter((r) => r.purpose === "agent");
  const cypher = agentRuns.some((r) => r.kind === "cypher");
  const activeTab = cypher && tab === "graph" ? "sparql" : tab;
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: "sources", label: "Sources" },
    { id: "graph", label: "Evidence graph", count: turn.graph?.edges.length },
    { id: "sparql", label: "Queries", count: agentRuns.length || undefined },
    { id: "results", label: "Results" },
    { id: "answer", label: "Answer" },
    { id: "trace", label: "Trace", count: turn.tools.length || undefined },
  ];
  return (
    <aside className="gc-panel" aria-label="Evidence window">
      <div className="gc-panel-head">
        <div className="gc-panel-title">
          <div>
            <p className="gc-eyebrow">
              <span className={`badge-dot gc-dot gc-dot-${turn.status}`} aria-hidden="true" />
              {turn.status === "streaming" ? "Answering…" : turn.status === "error" ? "Failed" : "Evidence"}
              {turn.sourceLabel ? ` · ${turn.sourceLabel}` : ""}
            </p>
            <h2>{turn.question}</h2>
          </div>
          <button type="button" className="icon-btn sm gc-close" onClick={onClose} aria-label="Back to answer">
            <IconClose />
          </button>
        </div>
        {activeTab !== "sources" && (
          <div className="gc-stats">
            <span className="badge">{plural(agentRuns.length, "query", "queries")}</span>
            {turn.graph && <span className="badge">{plural(turn.graph.edges.length, "triple")}</span>}
            {turn.durationMs !== undefined && <span className="badge">{formatMs(turn.durationMs)}</span>}
            {turn.model && <span className="badge badge-muted">{turn.model}</span>}
          </div>
        )}
        <div className="tabbar gc-tabs" role="tablist" aria-label="Evidence">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "sources"}
            className={"tab" + (activeTab === "sources" ? " on" : "")}
            onClick={() => onTab("sources")}
          >
            Sources
          </button>
          <details className="gc-technical">
            <summary>Details{activeTab !== "sources" ? ` · ${tabs.find((t) => t.id === activeTab)?.label ?? ""}` : ""}</summary>
            {tabs
              .filter((t) => t.id !== "sources" && t.id !== "answer" && (!cypher || t.id !== "graph"))
              .map((t) => (
                <button key={t.id} type="button" className="btn ghost sm" onClick={() => onTab(t.id)}>
                  {t.label}
                </button>
              ))}
          </details>
        </div>
      </div>
      <div className="gc-panel-body">
        {activeTab === "sources" && (
          <SourceInspector
            key={`${turn.id}:${focusSource ?? "list"}`}
            pid={pid}
            conversationId={conversationId}
            turn={turn}
            focus={focusSource}
            onUse={onUsePassage}
            onOpenDocument={onOpenDocument}
          />
        )}
        {activeTab === "graph" && (
          <GraphTab turn={turn} theme={theme} focusQuery={focusQuery} onFocusQuery={onFocusQuery} onIndividual={onIndividual} />
        )}
        {activeTab === "sparql" && (
          <SparqlTab turn={turn} focusQuery={focusQuery} onShowResults={(id) => (onFocusQuery(id), onTab("results"))} />
        )}
        {activeTab === "results" && <ResultsTab turn={turn} focusQuery={focusQuery} onFocusQuery={onFocusQuery} />}
        {activeTab === "answer" && (
          <AnswerTab turn={turn} onQuery={(id) => (onFocusQuery(id), onTab("sparql"))} onIndividual={onIndividual} onSource={onSource} />
        )}
        {activeTab === "trace" && <TraceTab turn={turn} />}
      </div>
    </aside>
  );
}

function GraphTab({
  turn,
  theme,
  focusQuery,
  onFocusQuery,
  onIndividual,
}: {
  turn: Turn;
  theme: "light" | "dark";
  focusQuery?: string;
  onFocusQuery: (id?: string) => void;
  onIndividual: (id: string) => void;
}) {
  if (!turn.graph) {
    const msg =
      turn.status === "streaming"
        ? "The evidence graph is built once the answer is complete."
        : turn.runs.some((r) => r.purpose === "agent" && r.ok && r.rowCount > 0)
          ? "No triple patterns could be rebuilt from these queries."
          : "No query returned data, so there is no evidence graph for this answer.";
    return <p className="gc-empty-tab">{msg}</p>;
  }
  if (!turn.graph.edges.length)
    return <p className="gc-empty-tab">The answering queries matched no triple patterns that could be drawn.</p>;
  return (
    <EvidenceGraphView
      graph={turn.graph}
      theme={theme}
      workbenchUrl={turn.workbenchUrl}
      focusQuery={focusQuery}
      onFocusQuery={onFocusQuery}
      onIndividual={turn.source === "project" ? onIndividual : undefined}
    />
  );
}

function SparqlTab({ turn, focusQuery, onShowResults }: { turn: Turn; focusQuery?: string; onShowResults: (id: string) => void }) {
  const cited = new Set(turn.graph?.queryIds ?? citedIds(turn.answer));
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (focusQuery) document.getElementById(`qcard-${focusQuery}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusQuery]);
  if (!turn.runs.length)
    return (
      <p className="gc-empty-tab">
        {turn.status === "streaming" ? "Waiting for the first query…" : "No database queries were run for this answer."}
      </p>
    );
  const copy = async (id: string, q: string) => {
    try {
      await navigator.clipboard.writeText(q);
      setCopied(id);
      setTimeout(() => setCopied(undefined), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="gc-pad">
      {turn.runs.map((r) => (
        <div key={r.id} id={`qcard-${r.id}`} className={"gc-qcard" + (focusQuery === r.id ? " is-focus" : "")}>
          <div className="gc-qcard-head">
            <span className={"gc-qid" + (r.purpose === "evidence" ? " is-evidence" : "")}>{r.id}</span>
            <span className="badge">{r.kind.toUpperCase()}</span>
            {r.purpose === "evidence" && <span className="badge badge-muted">evidence expansion of {r.parentId}</span>}
            {r.purpose === "agent" && r.ok && cited.has(r.id) && <span className="badge badge-ok">used in answer</span>}
            {!r.ok && <span className="badge badge-alert">error</span>}
            {r.ok && (
              <span className="small muted">
                {plural(r.rowCount, r.kind === "construct" || r.kind === "describe" ? "triple" : "row")} · {r.durationMs} ms
              </span>
            )}
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => void copy(r.id, r.query)}>
              {copied === r.id ? "Copied" : "Copy"}
            </button>
            {r.ok && (
              <button type="button" className="btn ghost sm" onClick={() => onShowResults(r.id)}>
                Results
              </button>
            )}
            {turn.workbenchUrl && (
              <a
                className="btn ghost sm"
                href={workbenchSparqlUrl(turn.workbenchUrl, r.query)}
                target="_blank"
                rel="noreferrer"
                title="Open in GraphDB Workbench"
              >
                Workbench ↗
              </a>
            )}
          </div>
          {r.kind === "cypher" ? <pre className="code-block">{r.query.trim()}</pre> : <SparqlCode query={r.query.trim()} />}
          {!r.ok && <p className="gc-qerr">{r.error}</p>}
        </div>
      ))}
      {turn.runs.some((r) => r.purpose === "evidence") && (
        <p className="field-hint">
          Evidence expansions re-run an answering query’s WHERE clause as SELECT * (restricted to the rows it returned) so that every joined
          resource can be drawn in the evidence graph.
        </p>
      )}
    </div>
  );
}

function TermView({ term, compact }: { term?: Term; compact: Compactor }) {
  if (!term) return <span className="muted">—</span>;
  if (term.type === "uri")
    return (
      <span className="gc-iri" title={term.value}>
        {compact(term.value)}
      </span>
    );
  if (term.type === "bnode") return <span className="gc-iri">_:{term.value}</span>;
  const meta = term.lang ? `@${term.lang}` : term.datatype && !term.datatype.endsWith("#string") ? compact(term.datatype) : "";
  return (
    <span>
      {term.value}
      {meta && <span className="gc-meta">{meta}</span>}
    </span>
  );
}

function ResultsTable({ run, compact }: { run: SparqlRun; compact: Compactor }) {
  if (!run.ok) return <p className="dz-error">{run.error}</p>;
  if (!run.rowCount) return <p className="gc-empty-tab">The query ran and returned no results.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="data-table compact gc-results">
          <thead>
            <tr>
              <th scope="col">#</th>
              {run.vars.map((v) => (
                <th key={v} scope="col">
                  ?{v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {run.vars.map((v) => (
                  <td key={v}>
                    <TermView term={row[v]} compact={compact} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        {run.rows.length < run.rowCount
          ? `Showing ${run.rows.length} of ${run.rowCount.toLocaleString()} rows.`
          : plural(run.rowCount, "row")}{" "}
        · {run.durationMs} ms
      </p>
    </>
  );
}

function ResultsTab({ turn, focusQuery, onFocusQuery }: { turn: Turn; focusQuery?: string; onFocusQuery: (id?: string) => void }) {
  const compact = useMemo(() => makeCompactor(turn.graph?.prefixes), [turn.graph]);
  const selected =
    turn.runs.find((r) => r.id === focusQuery) ?? [...turn.runs].reverse().find((r) => r.purpose === "agent" && r.ok) ?? turn.runs[0];
  if (!selected) return <p className="gc-empty-tab">No results yet.</p>;
  return (
    <div className="gc-pad">
      <div className="og-legend gc-pills">
        {turn.runs.map((r) => (
          <button
            key={r.id}
            type="button"
            className={"og-type" + (r.id === selected.id ? " is-current" : "")}
            aria-pressed={r.id === selected.id}
            onClick={() => onFocusQuery(r.id)}
          >
            {r.id}
            {!r.ok && " ⚠"}
          </button>
        ))}
      </div>
      <ResultsTable run={selected} compact={compact} />
    </div>
  );
}

function AnswerTab({
  turn,
  onQuery,
  onIndividual,
  onSource,
}: {
  turn: Turn;
  onQuery: (id: string) => void;
  onIndividual: (id: string) => void;
  onSource: (ref: string) => void;
}) {
  const cited = citedIds(turn.answer);
  return (
    <div className="gc-pad">
      {turn.answer ? (
        <Markdown text={turn.answer} onQuery={onQuery} onEntity={onIndividual} onSource={onSource} />
      ) : (
        <p className="muted">{turn.status === "streaming" ? "Writing…" : "No answer text."}</p>
      )}
      {turn.error && <p className="dz-error">{turn.error}</p>}
      {cited.length > 0 && (
        <ul className="gc-grounding">
          {cited.map((id) => {
            const r = turn.runs.find((x) => x.id === id);
            return (
              <li key={id}>
                <button type="button" className="cite cite-q" onClick={() => onQuery(id)}>
                  {id}
                </button>
                <span className="mono-sm grow">{r ? queryLine(r.query) : "query not found in this answer"}</span>
                <span className="small muted">{r?.ok ? plural(r.rowCount, "row") : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
      {turn.usage && (
        <p className="field-hint">
          {turn.model} · {formatMs(turn.durationMs)} · {turn.usage.input.toLocaleString()} input / {turn.usage.output.toLocaleString()}{" "}
          output tokens
          {turn.usage.cacheRead ? ` (${turn.usage.cacheRead.toLocaleString()} from cache)` : ""}
        </p>
      )}
    </div>
  );
}

function TraceTab({ turn }: { turn: Turn }) {
  if (!turn.trace.length) return <p className="gc-empty-tab">No steps recorded yet.</p>;
  return (
    <ol className="gc-pad gc-trace">
      {turn.trace.map((item, i) => {
        if (item.kind !== "tool")
          return (
            <li key={i} className="gc-trace-item">
              <p className="gc-eyebrow">{item.kind === "thinking" ? "Reasoning" : "Note"}</p>
              <p className="gc-trace-text">{item.text.trim()}</p>
            </li>
          );
        const call = turn.tools.find((c) => c.id === item.id);
        if (!call) return null;
        return (
          <li key={i} className={"gc-trace-item is-tool" + (call.ok === false ? " is-bad" : "")}>
            <p className="gc-eyebrow">
              {toolLabel(call.name)}
              {call.queryId && <span className="gc-qid">{call.queryId}</span>}
              {call.durationMs !== undefined && <span>{formatMs(call.durationMs)}</span>}
              {call.ok === undefined && <span className="spinner sm" aria-label="running" />}
            </p>
            <pre className="gc-pre">
              {call.name === "sparql_query" ? String(call.input.query ?? "") : JSON.stringify(call.input, null, 2)}
            </pre>
            {call.preview && <pre className="gc-pre">{call.preview}</pre>}
          </li>
        );
      })}
    </ol>
  );
}
