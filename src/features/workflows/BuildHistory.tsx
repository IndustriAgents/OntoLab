import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import type { RunView } from "../../types/project";
import { Modal, LoadingState, InlineError, StatusBadge, fmtDate } from "../../components/ui/ui";
import { buildTboxEvidence } from "../../lib/tboxEvidence";

const title = (run: RunView) => `${fmtDate(run.createdAt)} · ${run.id.slice(-6)}`;

function BuildComparison({ pid, runs, initial }: { pid: string; runs: RunView[]; initial?: string }) {
  const [leftId, setLeftId] = useState(initial ?? runs[0]?.id ?? "");
  const [rightId, setRightId] = useState(runs.find((r) => r.id !== leftId)?.id ?? "");
  const left = useQuery({ queryKey: ["run-research", pid, leftId], queryFn: () => api.runResearch(pid, leftId), enabled: !!leftId });
  const right = useQuery({ queryKey: ["run-research", pid, rightId], queryFn: () => api.runResearch(pid, rightId), enabled: !!rightId });
  const leftRevisionId = left.data?.run.resultRevisionId;
  const rightRevisionId = right.data?.run.resultRevisionId;
  const leftRevision = useQuery({
    queryKey: qk.revision(pid, leftRevisionId ?? "none"),
    queryFn: () => api.getRevision(pid, leftRevisionId!),
    enabled: !!leftRevisionId,
  });
  const rightRevision = useQuery({
    queryKey: qk.revision(pid, rightRevisionId ?? "none"),
    queryFn: () => api.getRevision(pid, rightRevisionId!),
    enabled: !!rightRevisionId,
  });
  const diff = useMemo(() => {
    if (!left.data || !right.data || !leftRevision.data || !rightRevision.data) return undefined;
    const a = buildTboxEvidence(left.data, leftRevision.data).terms.filter((t) => t.inResult);
    const b = buildTboxEvidence(right.data, rightRevision.data).terms.filter((t) => t.inResult);
    const key = (t: (typeof a)[number]) => `${t.kind}:${t.uri ?? t.name}`;
    const describe = (t: (typeof a)[number]) =>
      JSON.stringify([t.label, t.definition, [...t.parents].sort(), [...t.domain].sort(), [...t.range].sort()]);
    const am = new Map(a.map((t) => [key(t), t]));
    const bm = new Map(b.map((t) => [key(t), t]));
    return {
      added: b.filter((t) => !am.has(key(t))),
      removed: a.filter((t) => !bm.has(key(t))),
      changed: b.filter((t) => am.has(key(t)) && describe(am.get(key(t))!) !== describe(t)),
    };
  }, [left.data, right.data, leftRevision.data, rightRevision.data]);
  return (
    <div className="build-comparison">
      <p>Compare recorded inputs, settings and final terms. Opening a build does not change your current ontology version.</p>
      <div className="build-compare-selects">
        {(
          [
            ["Baseline build", leftId, setLeftId],
            ["Compared build", rightId, setRightId],
          ] as const
        ).map(([label, value, set]) => (
          <label className="field" key={label}>
            <span>{label}</span>
            <select value={value} onChange={(e) => set(e.target.value)}>
              <option value="">Choose a build</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {title(r)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {(left.isLoading || right.isLoading) && <LoadingState label="Loading recorded builds…" />}
      <InlineError error={left.error ?? right.error ?? leftRevision.error ?? rightRevision.error} />
      {left.data && right.data && (
        <div className="build-compare-table-wrap">
          <table className="data-table build-compare-table">
            <thead>
              <tr>
                <th>Recorded setting</th>
                <th>Baseline</th>
                <th>Compared build</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  "Source documents",
                  left.data.inputs?.documents.length ?? "Not recorded",
                  right.data.inputs?.documents.length ?? "Not recorded",
                ],
                ["Source passages", left.data.inputs?.chunks.length ?? "Not recorded", right.data.inputs?.chunks.length ?? "Not recorded"],
                [
                  "Generation model",
                  `${left.data.run.provider} / ${left.data.run.model}`,
                  `${right.data.run.provider} / ${right.data.run.model}`,
                ],
                [
                  "Embedding model",
                  left.data.run.options?.tokenization?.embedding.profile ?? left.data.run.config?.embedder ?? "Not recorded",
                  right.data.run.options?.tokenization?.embedding.profile ?? right.data.run.config?.embedder ?? "Not recorded",
                ],
                [
                  "Generation chunk budget",
                  left.data.run.options?.tokenization?.generation.maxTokens ?? "Historical sizing",
                  right.data.run.options?.tokenization?.generation.maxTokens ?? "Historical sizing",
                ],
                [
                  "Requirements version",
                  left.data.run.requirementsSnapshot?.version ?? "Not recorded",
                  right.data.run.requirementsSnapshot?.version ?? "Not recorded",
                ],
                ["Starting ontology", left.data.run.baseRevisionId ?? "None", right.data.run.baseRevisionId ?? "None"],
                [
                  "Result",
                  leftRevision.data ? `${leftRevision.data.stats.classes} classes · ${leftRevision.data.status}` : "No result yet",
                  rightRevision.data ? `${rightRevision.data.stats.classes} classes · ${rightRevision.data.status}` : "No result yet",
                ],
              ].map(([label, a, b]) => (
                <tr key={label}>
                  <th>{label}</th>
                  <td>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff ? (
        <>
          <h3>Ontology term changes</h3>
          <p className="field-hint">
            Compares term identifiers, names, definitions, parents, domains and ranges. Logical axiom changes are available in version
            comparison.
          </p>
          <div className="build-diff-groups">
            {(
              [
                ["Added", diff.added],
                ["Removed", diff.removed],
                ["Changed", diff.changed],
              ] as const
            ).map(([name, terms]) => (
              <section key={name}>
                <h4>
                  {terms.length} {name.toLowerCase()}
                </h4>
                {terms.length ? (
                  <ul>
                    {terms.map((t) => (
                      <li key={t.id}>{t.label}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">None</p>
                )}
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="field-hint">Both builds need a saved result before their ontology terms can be compared.</p>
      )}
    </div>
  );
}

export function BuildHistory({
  pid,
  runs,
  selected,
  onOpen,
  onDuplicate,
  onClose,
}: {
  pid: string;
  runs: RunView[];
  selected?: string | null;
  onOpen: (run: RunView) => void;
  onDuplicate: (run: RunView) => void;
  onClose: () => void;
}) {
  const [compare, setCompare] = useState(false);
  return (
    <Modal title={compare ? "Compare builds" : "Build history"} wide onClose={onClose}>
      <div className="build-history-heading">
        <p>
          Build history records what was executed and supports comparisons of inputs, settings and results. Ontology versions are the
          separate record of what was saved.
        </p>
        <button
          className="btn ghost sm"
          type="button"
          disabled={runs.length < 2}
          title={runs.length < 2 ? "Create a second build to compare inputs and results" : undefined}
          onClick={() => setCompare(!compare)}
        >
          {compare ? "Back to history" : "Compare builds"}
        </button>
      </div>
      {runs.length < 2 && <p className="field-hint">Complete another build to compare its inputs and results with this one.</p>}
      {compare ? (
        <BuildComparison pid={pid} runs={runs} initial={selected ?? undefined} />
      ) : !runs.length ? (
        <p className="ee-empty">No builds yet. Prepare your documents and start your first build.</p>
      ) : (
        <div className="build-history-list">
          {runs.map((run) => (
            <article className="build-history-card" key={run.id}>
              <div>
                <div className="ee-section-title">
                  <h3>{title(run)}</h3>
                  <StatusBadge tone={run.status === "failed" ? "alert" : run.status === "ready_for_review" ? "ok" : "info"}>
                    {run.status.replaceAll("_", " ")}
                  </StatusBadge>
                </div>
                <p>
                  {run.documentIds.length} documents · {run.completedSteps} / {run.steps.length} steps · {run.model}
                </p>
                {run.sourceRunId && <small>Based on build {run.sourceRunId.slice(-6)}</small>}
              </div>
              <div className="row-actions">
                <button className="btn ghost sm" type="button" onClick={() => onOpen(run)}>
                  Open results
                </button>
                <button className="btn sm" type="button" onClick={() => onDuplicate(run)}>
                  Duplicate and adjust
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
