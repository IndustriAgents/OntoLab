import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api } from "../../lib/projectApi";
import { downloadText } from "../../lib/format";
import { EmptyState, InlineError, StatusBadge, fmtDate } from "../../components/ui/ui";
import { revisionLabel } from "../revisions/RevisionBar";
import { queryResultsCsv } from "./queryResults";
import "./query-workspace.css";

const EXAMPLES = [
  { label: "Browse triples", query: "SELECT ?subject ?predicate ?object\nWHERE {\n  ?subject ?predicate ?object\n}\nLIMIT 100" },
  {
    label: "Count by class",
    query:
      "SELECT ?class (COUNT(DISTINCT ?entity) AS ?count)\nWHERE {\n  ?entity a ?class\n}\nGROUP BY ?class\nORDER BY DESC(?count)\nLIMIT 100",
  },
  {
    label: "Find relationships",
    query:
      "SELECT ?relationship (COUNT(*) AS ?count)\nWHERE {\n  ?subject ?relationship ?object\n  FILTER(isIRI(?object))\n}\nGROUP BY ?relationship\nORDER BY DESC(?count)\nLIMIT 100",
  },
  { label: "Check for data", query: "ASK {\n  ?subject ?predicate ?object\n}" },
];
const PAGE_SIZE = 50;

function QueryEditor({ pid, revisionId }: { pid: string; revisionId: string }) {
  const [sparql, setSparql] = useState(EXAMPLES[0].query);
  const [page, setPage] = useState(0);
  const query = useMutation({
    mutationFn: async (text: string) => {
      const started = performance.now();
      const result = await api.runSparql(pid, revisionId, text);
      return { ...result, text, duration: Math.round(performance.now() - started) };
    },
    onSuccess: () => setPage(0),
  });
  const run = () => {
    if (sparql.trim() && !query.isPending) query.mutate(sparql);
  };
  const result = query.data;
  const failed = query.isError || !!result?.error;
  return (
    <div className="query-workbench">
      <form
        className="query-editor-card"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <div className="query-card-heading">
          <div>
            <h2>Query editor</h2>
            <span>SPARQL · SELECT or ASK</span>
          </div>
          <StatusBadge tone="muted">Read only</StatusBadge>
        </div>
        <div className="query-examples" aria-label="Example queries">
          <span>Start with</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              className="query-example"
              disabled={query.isPending}
              onClick={() => setSparql(example.query)}
            >
              {example.label}
            </button>
          ))}
        </div>
        <div className="query-code-editor">
          <div className="query-line-numbers" aria-hidden="true">
            {sparql.split("\n").map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <textarea
            aria-label="SPARQL query"
            aria-describedby="query-editor-help"
            value={sparql}
            onChange={(event) => setSparql(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                run();
              }
            }}
          />
        </div>
        <div className="query-editor-footer">
          <p id="query-editor-help">
            Queries use this version’s saved facts and ontology.<span>⌘ / Ctrl + Enter to run</span>
          </p>
          <button type="submit" className="btn" disabled={!sparql.trim() || query.isPending}>
            {query.isPending ? "Running…" : "Run query"}
            <span aria-hidden="true"> →</span>
          </button>
        </div>
      </form>
      <section className="query-results-card" aria-label="Query results" aria-busy={query.isPending}>
        <div className="query-card-heading">
          <div>
            <h2>Results</h2>
            <span role="status">
              {query.isPending
                ? "Running your query…"
                : failed
                  ? "Query could not run"
                  : result
                    ? `${result.rows.length.toLocaleString()} ${result.rows.length === 1 ? "row" : "rows"}${result.truncated ? " · limit reached" : ""} · ${result.duration.toLocaleString()} ms`
                    : "Run a query to explore your data"}
            </span>
          </div>
          {!!result?.rows.length && !failed && !query.isPending && (
            <button
              className="btn ghost sm"
              onClick={() => downloadText(queryResultsCsv(result.columns, result.rows), "query-results.csv", "text/csv;charset=utf-8")}
            >
              Download CSV
            </button>
          )}
        </div>
        {query.isPending ? (
          <div className="query-result-empty" role="status">
            <span className="spinner" />
            <p>Finding matching facts…</p>
          </div>
        ) : failed ? (
          <div className="query-result-error">
            <InlineError error={query.error ?? result?.error} />
            <p>Check the query syntax and prefixes, or try an example above.</p>
          </div>
        ) : result ? (
          <>
            {result.text !== sparql && (
              <div className="query-result-notice" role="status">
                The editor has changed. These results are from your previous query.
              </div>
            )}
            {result.rows.length ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The result region needs keyboard scrolling. */}
                <div className="query-table-scroll" tabIndex={0} role="region" aria-label="Result rows">
                  <table className="query-results-table">
                    <thead>
                      <tr>
                        <th scope="col" className="query-row-number">
                          #
                        </th>
                        {result.columns.map((column) => (
                          <th key={column} scope="col">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row, i) => (
                        <tr key={i}>
                          <td className="query-row-number">{page * PAGE_SIZE + i + 1}</td>
                          {result.columns.map((column) => (
                            <td key={column} title={row[column]}>
                              {row[column] || <span className="muted">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="query-results-footer">
                  <span>
                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, result.rows.length)} of {result.rows.length.toLocaleString()}{" "}
                    rows{result.truncated ? " · Server limit reached; narrow the query to see other matches." : ""}
                  </span>
                  {result.rows.length > PAGE_SIZE && (
                    <div className="row-actions">
                      <button className="btn ghost sm" disabled={!page} onClick={() => setPage(page - 1)}>
                        Previous
                      </button>
                      <button
                        className="btn ghost sm"
                        disabled={(page + 1) * PAGE_SIZE >= result.rows.length}
                        onClick={() => setPage(page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="query-result-empty">
                <span className="query-empty-mark" aria-hidden="true">
                  ∅
                </span>
                <h3>No matching rows</h3>
                <p>Try a broader pattern or check the class and property names in your ontology.</p>
              </div>
            )}
          </>
        ) : (
          <div className="query-result-empty">
            <span className="query-empty-mark" aria-hidden="true">
              ⌕
            </span>
            <h3>Your data, one query away</h3>
            <p>Write a query or choose an example. Matching values will appear here in a table.</p>
          </div>
        )}
      </section>
    </div>
  );
}

export default function SparqlPage() {
  const { pid, project, selectedId, revisions, select, working } = useProject();
  const selected = revisions.find((revision) => revision.id === selectedId);
  const pin = working.content?.corpus?.ontology;
  return (
    <div className="query-workspace">
      <header className="query-page-heading">
        <div>
          <span className="eyebrow">{project?.name}</span>
          <h1>SPARQL</h1>
          <p>Explore facts and relationships with a query.</p>
        </div>
        <div className="query-version-context">
          <label>
            <span>{project?.settings.corpus ? "Graph version" : "Ontology version"}</span>
            <select
              aria-label="Version shown"
              value={selectedId ?? ""}
              onChange={(event) => select(event.target.value)}
              disabled={!selectedId}
            >
              {!selectedId && <option value="">No saved version</option>}
              {[...revisions]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revisionLabel(revision)}
                    {revision.id === project?.currentRevisionId ? " (current)" : ""} — {fmtDate(revision.updatedAt)}
                  </option>
                ))}
            </select>
          </label>
          {selected && (
            <StatusBadge tone={selected.status === "draft" ? "warn" : selected.id === project?.currentRevisionId ? "ok" : "muted"}>
              {selected.status === "draft" ? "Draft" : selected.id === project?.currentRevisionId ? "Current" : "Earlier version"}
            </StatusBadge>
          )}
          {pin && <Link to={`/p/${pin.projectId}/ontology?tab=review&rev=${pin.revisionId}`}>Ontology v{pin.number} · pinned ↗</Link>}
        </div>
      </header>
      {selectedId ? (
        <QueryEditor key={`${pid}:${selectedId}`} pid={pid} revisionId={selectedId} />
      ) : (
        <EmptyState
          title="Save a version before running a query"
          action={
            <Link className="btn" to={`/p/${pid}/ontology`}>
              Open ontology
            </Link>
          }
        />
      )}
    </div>
  );
}
