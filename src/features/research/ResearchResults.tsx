import { useState } from "react";
import type { ABoxResult } from "../../types/abox";
import { useEvidenceViewer } from "../evidence/useEvidence";

export function saveJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function JsonDetails({ value, label = "Inspect JSON" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="research-json" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label}</summary>
      {open && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}

const short = (s: string) => s.replace(/^https?:\/\/.*[/#]([^/#]+)$/, "$1");
function cell(value: unknown, fullIris = false): string {
  if (value == null) return "—";
  if (typeof value === "string") return fullIris ? value : short(value);
  if (Array.isArray(value)) return value.map((v) => cell(v, fullIris)).join(", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ResultTable({
  rows,
  columns,
  label,
  fullIris = false,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  label: string;
  fullIris?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const index = Math.min(page, pages - 1);
  if (!rows.length) return <p className="muted">No {label.toLowerCase()} recorded.</p>;
  return (
    <div className="research-result-table">
      <div className="table-wrap">
        <table className="data-table">
          <caption>
            {label} · {rows.length}
          </caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col">
                  {c.replace(/([A-Z])/g, " $1")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(index * 20, index * 20 + 20).map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} title={typeof row[c] === "string" ? (row[c] as string) : undefined}>
                    {cell(row[c], fullIris)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="research-pagination">
          <button className="btn ghost sm" disabled={!index} onClick={() => setPage(index - 1)}>
            Previous
          </button>
          <span>
            {index + 1} / {pages}
          </span>
          <button className="btn ghost sm" disabled={index + 1 >= pages} onClick={() => setPage(index + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export function ABoxResults({ abox, pid, runId }: { abox: ABoxResult; pid: string; runId?: string }) {
  const viewer = useEvidenceViewer(pid);
  const [page, setPage] = useState(0);
  const individuals = abox.individuals;
  const pages = Math.max(1, Math.ceil(individuals.length / 15));
  const index = Math.min(page, pages - 1);
  return (
    <div className="research-facts">
      {individuals.slice(index * 15, index * 15 + 15).map((ind) => {
        const facts = [
          { property: "type", value: ind.classUri, evidence: ind.evidence, review: ind.review },
          ...(ind.dataProperties ?? []).map((p) => ({
            property: p.propUri,
            value: `${p.value}${p.datatype ? ` (${short(p.datatype)})` : ""}`,
            evidence: p.evidence,
            review: p.review,
          })),
          ...(ind.objectProperties ?? []).map((p) => ({ property: p.propUri, value: p.targetId, evidence: p.evidence, review: p.review })),
        ];
        return (
          <details key={ind.id} className="research-individual">
            <summary>
              <strong>{ind.label || ind.id}</strong>
              <span>
                {short(ind.classUri)} · {facts.length} assertions
              </span>
            </summary>
            <div className="research-assertions">
              {facts.map((f, i) => (
                <div className="research-assertion" key={i}>
                  <div>
                    <code>{short(f.property)}</code> → <strong>{short(f.value)}</strong>
                    <span className="muted"> · {f.review?.status ?? "review state not recorded"}</span>
                  </div>
                  {f.evidence?.map((ev, j) => (
                    <div className="research-evidence" key={j}>
                      <blockquote>{ev.quote}</blockquote>
                      <small>
                        {ev.status} · {ev.confidence == null ? "not scored" : `support score ${ev.confidence.toFixed(3)}`}
                        {ev.review ? " · review flagged" : ""}
                        {ev.documentId && (
                          <button className="btn ghost sm" type="button" onClick={() => viewer.open({ ...ev, runId: ev.runId ?? runId })}>
                            Inspect evidence
                          </button>
                        )}
                      </small>
                      {ev.claim && <p className="field-hint">Judged claim: {ev.claim}</p>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        );
      })}
      {pages > 1 && (
        <div className="research-pagination">
          <button className="btn ghost sm" disabled={!index} onClick={() => setPage(index - 1)}>
            Previous
          </button>
          <span>
            Individuals {index * 15 + 1}–{Math.min(individuals.length, (index + 1) * 15)} of {individuals.length}
          </span>
          <button className="btn ghost sm" disabled={index + 1 >= pages} onClick={() => setPage(index + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/** Render the saved induction artifacts without assuming every stage has the same schema. */
export function PayloadResults({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== "object") return null;
  return (
    <>
      {Object.entries(payload).map(([key, value]) => {
        if (value == null) return null;
        if (key === "turtle" && typeof value === "string")
          return (
            <div key={key}>
              <h4>Resulting ontology · Turtle</h4>
              <pre className="research-code">{value}</pre>
            </div>
          );
        if (Array.isArray(value)) {
          const rows = value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
          const preferred = [
            "name",
            "term",
            "kind",
            "parents",
            "domain",
            "range",
            "comment",
            "located",
            "quote",
            "reason",
            "message",
            "severity",
            "uri",
            "source",
            "decision",
          ];
          const keys = new Set(rows.flatMap(Object.keys));
          const columns = preferred.filter((c) => keys.has(c)).slice(0, 6);
          if (!columns.length) columns.push(...[...keys].slice(0, 4));
          return rows.length ? (
            <ResultTable key={key} rows={rows} columns={columns} label={key.replace(/([A-Z])/g, " $1")} />
          ) : (
            <p className="muted" key={key}>
              {key}: {value.length ? cell(value) : "none"}
            </p>
          );
        }
        if (typeof value === "object") return <JsonDetails key={key} label={`Inspect ${key}`} value={value} />;
        return (
          <p key={key}>
            <strong>{key}: </strong>
            {cell(value)}
          </p>
        );
      })}
    </>
  );
}
