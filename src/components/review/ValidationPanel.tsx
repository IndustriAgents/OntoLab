import type { ValidationIssue } from "../../types/abox";

interface Props {
  issues: ValidationIssue[];
  /** focus the individual an issue is about, shared with the table and the graph */
  onFocus?: (id: string) => void;
  emptyMessage?: string;
}

export function ValidationPanel({ issues, onFocus, emptyMessage }: Props) {
  if (issues.length === 0) {
    return (
      <div className="val-empty">
        <span className="big" aria-hidden="true">
          ✓
        </span>
        <p>
          {emptyMessage ??
            "No conformance issues. Every individual is typed with a T-Box class and uses only declared properties with consistent domains, ranges and datatypes."}
        </p>
      </div>
    );
  }

  // Errors first: they are the ones that make an export ambiguous.
  const ordered = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

  return (
    <div>
      {ordered.map((iss, i) => {
        const focusable = !!(onFocus && iss.id);
        return (
          <div className={"val-row" + (focusable ? " focusable" : "")} key={`${iss.code ?? ""}-${iss.where}-${i}`}>
            <span className={"sev " + iss.severity}>{iss.severity}</span>
            <div className="vmsg">
              {iss.message}
              {focusable ? (
                <button className="where link" onClick={() => onFocus(iss.id!)} title="Show this individual in the table and graph">
                  {iss.where}
                </button>
              ) : (
                <div className="where">{iss.where}</div>
              )}
              {iss.explanation?.length ? (
                <details className="val-explain">
                  <summary>Why ({iss.explanation.length} axiom{iss.explanation.length === 1 ? "" : "s"})</summary>
                  <ol>
                    {iss.explanation.map((line, j) => (
                      <li key={j}>{line}</li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
