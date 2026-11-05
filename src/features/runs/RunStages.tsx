import type { RunStepKind, RunView } from "../../types/project";
import { IconCheck } from "../../components/icons";

const LABELS: Record<RunStepKind, string> = {
  terms: "Generate classes",
  merge: "Consolidate classes",
  relations: "Generate relations & attributes",
  axioms: "Add ontology rules",
  reuse: "Find reusable vocabulary",
  pitfalls: "Check ontology quality",
  summary: "Summarize documents",
  chunk: "Extract facts",
  vision: "Read document images",
  qa: "Clarify findings",
  resolve: "Resolve duplicate entities",
  ground: "Link external references",
  verify: "Check source evidence",
  alignment_retrieve: "Find alignment candidates",
  alignment_verify: "Verify mappings",
  finalize: "Prepare review draft",
};

export function RunStages({ run }: { run: RunView }) {
  const isDone = (key: string, index: number) => (run.completedStepKeys ? run.completedStepKeys.includes(key) : index < run.completedSteps);
  const nextKey =
    run.nextStep?.key ?? (run.status !== "ready_for_review" ? run.steps.find((step, index) => !isDone(step.key, index))?.key : undefined);
  const groups = new Map<RunStepKind, { key: string; label: string; done: boolean; current: boolean }[]>();
  run.steps.forEach((step, index) => {
    const items = groups.get(step.kind) ?? [];
    items.push({
      key: step.key,
      label: step.label,
      done: isDone(step.key, index),
      current: nextKey === step.key,
    });
    groups.set(step.kind, items);
  });
  return (
    <section className="card run-stages" aria-labelledby="run-stages-title">
      <div className="card-head">
        <div>
          <h2 id="run-stages-title">Processing stages</h2>
          <p className="muted">Expand a stage to see its individual steps.</p>
        </div>
        <span className="run-count">
          {run.completedSteps} / {run.steps.length} steps
        </span>
      </div>
      <div className="run-stage-list">
        {[...groups].map(([kind, items], index) => {
          const completed = items.filter((step) => step.done).length;
          const done = completed === items.length;
          const current = !done && items.some((step) => step.current);
          return (
            <details className={`run-stage${done ? " is-done" : current ? " is-current" : ""}`} key={kind} open={current}>
              <summary>
                <span className="run-stage-marker" aria-hidden="true">
                  {done ? <IconCheck /> : index + 1}
                </span>
                <strong>{LABELS[kind]}</strong>
                <span className="run-stage-state">
                  {done
                    ? "Complete"
                    : current
                      ? run.status === "failed" || run.status === "cancelled"
                        ? "Stopped here"
                        : run.status === "paused"
                          ? "Paused here"
                          : run.status === "running"
                            ? "In progress"
                            : "Next step"
                      : "Pending"}
                </span>
                <span className="run-count">
                  {completed} / {items.length}
                </span>
              </summary>
              <ol className="step-list">
                {items.map((step) => (
                  <li key={step.key} className={step.done ? "done" : step.current ? "current" : ""}>
                    <span className="step-dot" aria-hidden="true" />
                    <span className="grow">{step.label}</span>
                    <span className="sr-only">{step.done ? "complete" : step.current ? "next" : "pending"}</span>
                  </li>
                ))}
              </ol>
            </details>
          );
        })}
        {!run.steps.length && <p className="muted">No processing steps recorded for this run.</p>}
      </div>
    </section>
  );
}
