import { useState } from "react";
import type { AlignmentRecord } from "../../types/transparency";
import { localName } from "../../lib/ontology/iri";
import { StatusBadge } from "../../components/ui/ui";

const LABELS = {
  not_processed: "Not processed",
  no_candidate: "No candidate found",
  model_unrelated: "No match proposed by model",
  proposed: "Candidates to review",
};

export function AlignmentCoverage({ record, stale }: { record: AlignmentRecord; stale: boolean }) {
  const [filter, setFilter] = useState("not_processed");
  const [search, setSearch] = useState("");
  const d = record.diagnostics;
  const coverage = d.coverage;
  const remaining = d.sourceTerms - d.processedSourceTerms;
  const rows = (coverage ?? []).filter(
    (term) => (filter === "all" || term.state === filter) && term.source.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="alignment-coverage" aria-label="Comparison coverage">
      <div className="workflow-section-title">
        <h3>Last comparison coverage</h3>
        <StatusBadge tone={stale || remaining ? "warn" : "ok"}>
          {stale ? "Inputs changed" : remaining ? "Partial comparison" : "All source terms processed"}
        </StatusBadge>
      </div>
      <p>
        <strong>
          {d.processedSourceTerms} of {d.sourceTerms}
        </strong>{" "}
        source terms processed against {d.targetTerms} target terms.
        {remaining > 0 && (
          <>
            {" "}
            <strong>{remaining} terms were not processed.</strong> Increase the source limit or choose every term, then run matching again.
          </>
        )}
        {stale && <> These results describe the recorded inputs. Run matching again for the current modules.</>}
      </p>
      <div className="workflow-inline-stats">
        <span>
          <strong>{d.retrievedPairs}</strong> retrieved candidates
        </span>
        <span>
          <strong>{d.returnedMappings}</strong> proposed mappings
        </span>
        {coverage && (
          <span>
            <strong>{coverage.filter((c) => c.state === "no_candidate").length}</strong> processed without a candidate
          </span>
        )}
      </div>
      <details className="method-details">
        <summary>Inspect term coverage</summary>
        <div className="method-details-body">
          <p>
            Coverage describes retrieval, not human approval. A term with no candidate may still have a valid correspondence you can add
            manually.
          </p>
          {coverage ? (
            <>
              <div className="alignment-filters">
                <label className="field">
                  <span>Coverage status</span>
                  <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All terms ({coverage.length})</option>
                    {Object.entries(LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label} ({coverage.filter((c) => c.state === key).length})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Find a source term</span>
                  <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
              </div>
              <ul className="alignment-coverage-list">
                {rows.slice(0, 100).map((term) => (
                  <li key={term.source}>
                    <span>
                      <strong>{localName(term.source)}</strong>
                      <small>{term.source}</small>
                    </span>
                    <span>{LABELS[term.state]}</span>
                  </li>
                ))}
              </ul>
              {!rows.length && <p>No terms in this view.</p>}
              {rows.length > 100 && (
                <p>
                  Showing 100 of {rows.length} terms. Search to narrow this list; the complete record is included in the research export.
                </p>
              )}
            </>
          ) : (
            <p>This older comparison has counts but no recorded per-term coverage. Run matching again to capture it.</p>
          )}
        </div>
      </details>
    </section>
  );
}
