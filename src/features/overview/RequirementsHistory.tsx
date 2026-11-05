import { useState } from "react";
import type { Requirements, RequirementsVersion } from "../../types/project";

export function RequirementsHistory({
  versions,
  current,
  disabled,
  onRestore,
}: {
  versions: RequirementsVersion[];
  current: Requirements;
  disabled: boolean;
  onRestore: (number: number) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const version = versions.find((v) => v.number === selected) ?? versions.at(-1);
  if (!version) return null;
  const render = (requirements: Requirements) => (
    <>
      <h4>User stories</h4>
      {requirements.stories.length ? (
        <ul>
          {requirements.stories.map((story, i) => (
            <li key={i}>{story}</li>
          ))}
        </ul>
      ) : (
        <p>No user stories.</p>
      )}
      <h4>Questions</h4>
      {requirements.cqs.length ? (
        <ul>
          {requirements.cqs.map((q) => (
            <li key={q.id}>
              {q.text} <small>({q.status})</small>
              {q.sparql && <pre className="ttl-preview">{q.sparql}</pre>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No questions.</p>
      )}
    </>
  );
  return (
    <details className="requirements-history">
      <summary>
        Version history · {versions.length} saved {versions.length === 1 ? "version" : "versions"}
      </summary>
      <label className="field">
        <span>Compare a saved version with current requirements</span>
        <select value={version.number} onChange={(e) => setSelected(Number(e.target.value))}>
          {[...versions].reverse().map((v) => (
            <option key={v.number} value={v.number}>
              Version {v.number} · {new Date(v.createdAt).toLocaleString()}
              {v.restoredFrom ? ` · restored from v${v.restoredFrom}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="requirements-comparison">
        <section aria-label="Saved requirements">
          <h3>Saved v{version.number}</h3>
          {render(version.requirements)}
        </section>
        <section aria-label="Current requirements">
          <h3>Current requirements</h3>
          {render(current)}
        </section>
      </div>
      <p>Restoring creates a new version. Earlier versions and build inputs stay available.</p>
      <button
        className="btn ghost"
        disabled={disabled || version.number === versions.at(-1)?.number}
        onClick={() => onRestore(version.number)}
      >
        Restore v{version.number} as a new version
      </button>
      {disabled && <p className="muted">Save or discard pending edits before restoring a version.</p>}
    </details>
  );
}
