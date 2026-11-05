import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { ValidationPanel } from "../../components/review/ValidationPanel";
import { InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { CommitDialog } from "../revisions/RevisionBar";
import { JsonDetails, ResultTable } from "../research/ResearchResults";
import { MethodDetails } from "../workflows/MethodDetails";
import { AskCq } from "./CompetencyQuery";

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/turtle" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ValidationView({ pid, revisionId, showCommit = true }: { pid: string; revisionId: string; showCommit?: boolean }) {
  const { project, working } = useProject();
  const qc = useQueryClient();
  const [tab, setTab] = useState("schema");
  const [committing, setCommitting] = useState(false);
  const revision = useQuery({ queryKey: qk.revision(pid, revisionId), queryFn: () => api.getRevision(pid, revisionId) });
  const report = useQuery({ queryKey: qk.report(pid, revisionId), queryFn: () => api.report(pid, revisionId) });
  const run = useMutation({
    mutationFn: async () => {
      await working.flush();
      return api.validate(pid, revisionId, project?.settings.savedQueries ?? []);
    },
    onSuccess: (r) => {
      qc.setQueryData(qk.report(pid, revisionId), r);
      void qc.invalidateQueries({ queryKey: qk.revision(pid, revisionId) });
    },
  });
  const r = report.data;
  const stale = r && (r.stale || r.contentHash !== revision.data?.contentHash || working.save === "saving");
  const sh = r?.shaclExecution;
  return (
    <div className="workflow-stack">
      <div className="workflow-section-title">
        <div>
          <h2>Check this revision</h2>
          <p>Review findings before making the result your project's current revision.</p>
        </div>
        <button className="btn" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? "Checking…" : r ? "Run checks again" : "Run validation"}
        </button>
      </div>
      <InlineError error={run.error ?? report.error ?? revision.error} />
      {report.isLoading && <LoadingState />}
      {r ? (
        <>
          <div className="workflow-inline-stats">
            <StatusBadge tone={stale ? "warn" : "ok"}>{stale ? "Outdated — run again" : "Current report"}</StatusBadge>
            <span>
              <strong>{r.counts.errors}</strong> errors
            </span>
            <span>
              <strong>{r.counts.warnings}</strong> warnings
            </span>
            <span>{r.execution?.durationMs ?? "—"} ms</span>
          </div>
          <div className="validation-checks" role="tablist" aria-label="Validation checks">
            {[
              ["schema", "Structure", r.schemaIssues.length + (r.ontologyIssues?.length ?? 0)],
              ["shacl", "SHACL constraints", r.shaclIssues.length],
              ["reasoning", "Logical consistency", r.reasonerIssues?.length ?? 0],
              ["cq", "Research questions", r.cqResults.length],
            ].map(([id, label, count]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(String(id))}>
                <strong>{label}</strong>
                <span>
                  {count} {id === "cq" ? "queries" : "findings"}
                </span>
              </button>
            ))}
          </div>
          <div role="tabpanel" className="workflow-stack">
            {tab === "schema" && (
              <>
                <h3>Classes, properties and assertions</h3>
                {r.ontologyIssues && (
                  <ResultTable
                    label="Ontology structure findings"
                    rows={r.ontologyIssues.map((x) => ({ ...x }))}
                    columns={["severity", "code", "message"]}
                  />
                )}
                <ValidationPanel issues={r.schemaIssues} />
                <MethodDetails>
                  <p>
                    Deterministic ontology checks inspect declarations and references. A-Box checks compare individual types, properties,
                    ranges and values against the parsed T-Box. Findings are reported without silently repairing the graph.
                  </p>
                  <JsonDetails value={r.execution} label="Execution and review policy" />
                </MethodDetails>
              </>
            )}
            {tab === "shacl" && (
              <>
                <h3>Generated constraints and observed violations</h3>
                <p>
                  {sh?.status === "empty-data"
                    ? "No individuals were available. Shapes were generated, but this does not establish that future data will conform."
                    : sh?.status === "failed"
                      ? `SHACL did not complete: ${sh.error ?? "execution failed"}. No conformance conclusion is available.`
                      : sh?.status === "completed"
                        ? sh.conforms
                          ? "The checked data conforms to the generated shapes."
                          : "The checked data violates one or more generated constraints."
                        : "Execution details are unavailable. Run validation to capture them."}
                </p>
                <ValidationPanel
                  issues={r.shaclIssues}
                  emptyMessage={sh?.status === "empty-data" ? "No data was checked." : "No SHACL findings recorded."}
                />
                {sh && (
                  <>
                    <div className="workflow-inline-stats">
                      <span>
                        <strong>{sh.shapeQuads}</strong> shape triples
                      </span>
                      <span>
                        <strong>{sh.dataQuads}</strong> data triples
                      </span>
                      <span>
                        <strong>{sh.inferredTypeQuads}</strong> ancestor types added
                      </span>
                    </div>
                    <MethodDetails title="SHACL method, exact shapes & checked data">
                      <p>
                        The application translates supported T-Box constraints to SHACL and executes {sh.engine}. Ancestor type assertions
                        are added before validation. These generated shapes cover the implemented translation; they are not a complete
                        translation of every OWL axiom.
                      </p>
                      <div className="row-actions">
                        <button className="btn ghost sm" onClick={() => downloadText(sh.shapesTurtle, "shapes.ttl")}>
                          Download shapes.ttl
                        </button>
                        <button className="btn ghost sm" onClick={() => downloadText(sh.dataTurtle, "validated-data.ttl")}>
                          Download checked data
                        </button>
                      </div>
                      <details>
                        <summary>Generated SHACL text</summary>
                        <pre className="ttl-preview">{sh.shapesTurtle || "No shapes generated."}</pre>
                      </details>
                      <details>
                        <summary>Exact validated data graph</summary>
                        <pre className="ttl-preview">{sh.dataTurtle || "Empty graph."}</pre>
                      </details>
                      <ResultTable
                        label="Raw constraint results"
                        rows={sh.results.map((x) => ({ ...x }))}
                        columns={["focusNode", "path", "value", "constraint", "sourceShape", "messages"]}
                      />
                      <JsonDetails value={sh} label="Complete execution record" />
                    </MethodDetails>
                  </>
                )}
              </>
            )}
            {tab === "reasoning" && (
              <>
                <h3>Consistency under the selected reasoner</h3>
                {r.reasoner ? (
                  <>
                    <p>
                      {r.reasoner.reasoner} · {r.reasoner.tier} · {r.reasoner.ms} ms ·{" "}
                      {r.reasoner.consistent ? "No inconsistency detected" : "Inconsistency detected"}
                    </p>
                    <ValidationPanel issues={r.reasonerIssues ?? []} />
                    <MethodDetails>
                      <p>
                        Reasoning derives consequences of the supported axioms and checks for clashes and unsatisfiable classes. Its
                        conclusion is limited to the reasoner's supported constructs.
                      </p>
                      {r.reasoner.incomplete.map((m, i) => (
                        <p key={i}>Not checked: {m}</p>
                      ))}
                      <JsonDetails value={r.reasoner} />
                    </MethodDetails>
                  </>
                ) : (
                  <>
                    <p>No reasoner result recorded.</p>
                    <ValidationPanel issues={r.reasonerIssues ?? []} />
                  </>
                )}
              </>
            )}
            {tab === "cq" && (
              <>
                <h3>Can this graph answer your questions?</h3>
                <p className="muted">Answer rate measures queries returning an answer, not accuracy against a gold standard.</p>
                {!r.cqResults.length && <p>No saved queries were executed.</p>}
                {r.cqResults.map((c, i) => (
                  <details className="method-details" key={i}>
                    <summary>{c.question}</summary>
                    <div className="method-details-body">
                      <pre className="ttl-preview">{c.sparql}</pre>
                      {c.error ? <p role="alert">{c.error}</p> : <ResultTable label="Query results" rows={c.rows} columns={c.columns} />}
                      {c.truncated && <p>Results were truncated by the query limit.</p>}
                    </div>
                  </details>
                ))}
              </>
            )}
          </div>
          <div className="row-actions">
            <button className="btn ghost" onClick={() => void api.downloadReport(pid, revisionId, "json")}>
              Export validation evidence
            </button>
            <Link to={`/p/${pid}/ontology?rev=${revisionId}`}>Open revision editor</Link>
            {showCommit && revision.data?.status === "draft" && (
              <button className="btn" disabled={!!stale || run.isPending} onClick={() => setCommitting(true)}>
                Review & save version
              </button>
            )}
          </div>
        </>
      ) : (
        !report.isLoading && (
          <p className="muted">
            Validation checks ontology structure, SHACL constraints, logical consistency and saved competency queries. Results will appear
            here.
          </p>
        )
      )}
      <MethodDetails title="Add or test a competency question">
        <AskCq revisionId={revisionId} />
      </MethodDetails>
      {committing && revision.data && <CommitDialog revision={revision.data} onClose={() => setCommitting(false)} />}
    </div>
  );
}
