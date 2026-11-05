import type { RunOptions } from "../../types/project";
import "./experiment-options.css";

export function ExperimentOptions({
  kind,
  options,
  onChange,
}: {
  kind: "induction" | "extraction";
  options: Partial<RunOptions>;
  onChange: (o: Partial<RunOptions>) => void;
}) {
  const set = (patch: Partial<RunOptions>) => onChange({ ...options, ...patch });
  return (
    <details className="experiment-options">
      <summary>Advanced settings · research parameters</summary>
      <p className="field-hint">
        These settings are saved with each activity. Change one factor at a time when comparing results; inspect recorded steps in
        Processing details.
      </p>
      {kind === "extraction" ? (
        <div className="form-grid">
          <label className="field">
            <span>Cached extraction results</span>
            <select
              value={options.reuseCache === false ? "fresh" : "reuse"}
              onChange={(e) => set({ reuseCache: e.target.value === "reuse" })}
            >
              <option value="reuse">Reuse when available</option>
              <option value="fresh">Recompute with fresh measurements</option>
            </select>
            <span className="field-hint">
              Recomputing makes new model calls. Existing cached runs have no newly calculated similarity scores.
            </span>
          </label>
          <label className="field">
            <span>Prompt representation</span>
            <select
              value={options.promptStyle ?? ""}
              onChange={(e) => set({ promptStyle: (e.target.value || undefined) as RunOptions["promptStyle"] })}
            >
              <option value="">Server default</option>
              <option value="code">Code-style ontology</option>
              <option value="tree">Tree-style ontology</option>
            </select>
          </label>
          <label className="field">
            <span>Schema retrieval</span>
            <select
              value={options.schemaRetrieval ?? "auto"}
              onChange={(e) => set({ schemaRetrieval: e.target.value as RunOptions["schemaRetrieval"] })}
            >
              <option value="auto">Auto · large ontologies</option>
              <option value="off">Off · entire ontology</option>
              <option value="force">Always retrieve</option>
            </select>
          </label>
          <label className="field">
            <span>Schema top-k · terms</span>
            <input
              type="number"
              min={1}
              max={500}
              placeholder="Server default"
              value={options.schemaTopK ?? ""}
              disabled={options.schemaRetrieval === "off"}
              onChange={(e) =>
                set({
                  schemaTopK:
                    Number.isInteger(e.target.valueAsNumber) && e.target.valueAsNumber >= 1
                      ? Math.min(500, e.target.valueAsNumber)
                      : undefined,
                })
              }
            />
          </label>
          <label className="field">
            <span>Fact review policy</span>
            <select
              value={options.evidenceGate ?? "auto-accept"}
              onChange={(e) => set({ evidenceGate: e.target.value as RunOptions["evidenceGate"] })}
            >
              <option value="auto-accept">Accept when evidence and checks pass</option>
              <option value="flag">Keep all new facts as candidates</option>
              <option value="off">Disable automatic fact review</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="check-list">
          {(
            [
              ["cqGuided", "Guide induction with purpose and competency questions", true],
              ["inductionAxioms", "Propose logical axioms", true],
              ["repair", "Repair ontology pitfalls and inconsistencies", true],
              ["strictGrounding", "Drop unsupported terms instead of flagging them", false],
            ] as const
          ).map(([key, label, fallback]) => (
            <label className="check" key={key}>
              <input type="checkbox" checked={options[key] ?? fallback} onChange={(e) => set({ [key]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}
      <p className="field-hint">
        Embedding and NLI backends are set in the project settings. Use Documents & chunking in Research to create input variants before
        starting the run.
      </p>
    </details>
  );
}
