import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { FactReview } from "../../types/abox";
import type { EvidenceInspection, EvidenceTab } from "../../types/evidence";
import { evidenceApi } from "../../lib/evidenceApi";
import { quoteMatchLabel, reviewLabel } from "../../lib/evidence";
import { locateQuoteDetailed } from "../../lib/sourceQuote";
import { ErrorState, InlineError, LoadingState, StatusBadge, fmtDate } from "../../components/ui/ui";

function OriginalSource({ pid, data }: { pid: string; data: EvidenceInspection }) {
  const file = useQuery({
    queryKey: ["evidence-original", pid, data.target, data.sourceIndex],
    queryFn: ({ signal }) => evidenceApi.original(pid, { target: data.target, sourceIndex: data.sourceIndex }, signal),
    staleTime: Infinity,
  });
  const [preview, setPreview] = useState<{ url: string; text?: string }>();
  const doc = data.source?.document;
  useEffect(() => {
    if (!file.data) return;
    const url = URL.createObjectURL(file.data);
    let active = true;
    const text = doc?.kind === "text" || doc?.kind === "html" || /xml|^text\//.test(doc?.mediaType ?? "");
    if (text)
      void file.data.text().then((value) => {
        if (active) setPreview({ url, text: value.slice(0, 100000) });
      });
    else setPreview({ url });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file.data, doc?.kind, doc?.mediaType]);
  if (file.error) return <ErrorState title="Original unavailable" error={file.error} onRetry={() => void file.refetch()} />;
  if (!preview) return <LoadingState label="Checking and opening the original…" />;
  return (
    <div className="ei-stack">
      <div className="ei-source-toolbar">
        <StatusBadge tone="ok">Original checksum verified</StatusBadge>
        <a className="btn ghost sm" href={preview.url} download={doc?.name}>
          Download original
        </a>
      </div>
      {preview.text !== undefined ? (
        <>
          <pre className="ei-code">{preview.text}</pre>
          {file.data!.size > 100000 && (
            <p className="field-hint">Original preview is limited to 100,000 characters. Download the file for its complete content.</p>
          )}
        </>
      ) : doc?.kind === "pdf" ? (
        <object
          className="ei-original-preview"
          type="application/pdf"
          data={`${preview.url}#page=${data.source?.reference.page ?? 1}`}
          aria-label="Retained original PDF"
        >
          <a href={preview.url} download={doc.name}>
            Download the retained PDF
          </a>
        </object>
      ) : doc?.kind === "image" ? (
        <img className="ei-original-preview" src={preview.url} alt={doc.name} />
      ) : (
        <p>Download this file to view it in its native application.</p>
      )}
    </div>
  );
}

function OriginalStructure({ pid, data }: { pid: string; data: EvidenceInspection }) {
  const [elementIndex, setElementIndex] = useState(0);
  const structure = useQuery({
    queryKey: ["evidence-structure", pid, data.target, data.sourceIndex, elementIndex],
    queryFn: ({ signal }) => evidenceApi.structure(pid, { target: data.target, sourceIndex: data.sourceIndex, elementIndex }, signal),
    staleTime: Infinity,
    retry: false,
  });
  const value = structure.data;
  const hit = value ? locateQuoteDetailed(data.source?.reference.quote ?? "", value.text) : null;
  return (
    <div className="ei-stack">
      {data.source!.pathCount > data.source!.paths.length && (
        <p className="ei-note">
          Showing the first {data.source!.paths.length} of {data.source!.pathCount} structural locations. Open the original file for the
          remaining elements.
        </p>
      )}
      {data.source!.paths.length > 1 && (
        <label className="field">
          <span>Original element</span>
          <select aria-label="Original element" value={elementIndex} onChange={(e) => setElementIndex(Number(e.target.value))}>
            {data.source!.paths.map((path, i) => (
              <option value={i} key={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
      )}
      {structure.isLoading ? (
        <LoadingState label="Checking the original structural element…" />
      ) : structure.error ? (
        <ErrorState title="Original structure unavailable" error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        value && (
          <>
            <StatusBadge tone="ok">Original XML checksum verified</StatusBadge>
            <p className="ei-note">Mapped original element · {value.path}</p>
            {value.table ? (
              <>
                <div className="ei-table-wrap">
                  <table className="data-table ei-table">
                    <caption>{value.table.caption ?? "Table from the original XML"}</caption>
                    <tbody>
                      {value.table.rows.map((row, i) => (
                        <tr key={i} data-cited={row.highlighted || undefined}>
                          {row.cells.map((cell, j) =>
                            cell.header ? (
                              <th scope="col" key={j} colSpan={cell.colspan} rowSpan={cell.rowspan}>
                                {cell.text}
                              </th>
                            ) : (
                              <td key={j} colSpan={cell.colspan} rowSpan={cell.rowspan}>
                                {cell.text}
                              </td>
                            ),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {value.table.footnotes && <p className="ei-note">{value.table.footnotes}</p>}
                {value.table.truncated && <p className="ei-note">Original table preview truncated at 100 rows or 5,000 cells.</p>}
              </>
            ) : (
              <div className="ei-excerpt">
                {hit ? (
                  <>
                    {value.text.slice(0, hit.start)}
                    <mark>{value.text.slice(hit.start, hit.end)}</mark>
                    {value.text.slice(hit.end)}
                  </>
                ) : (
                  value.text
                )}
              </div>
            )}
            {!hit && !value.table && (
              <p className="ei-note">
                The parsed passage can span several original elements. The recorded structural location is shown here.
              </p>
            )}
            <details>
              <summary>Element XML{value.truncated ? " · truncated" : ""}</summary>
              <pre className="ei-code">{value.xml}</pre>
            </details>
          </>
        )
      )}
    </div>
  );
}

function SourcePane({ pid, data }: { pid: string; data: EvidenceInspection }) {
  const s = data.source;
  const [view, setView] = useState<"text" | "table" | "original" | "structure">(s?.table ? "table" : "text");
  if (!s) return <p className="ei-note">{data.message}</p>;
  const summary = data.sources[data.sourceIndex];
  const excerpt = s.excerpt;
  const hl = excerpt?.highlight;
  const params = new URLSearchParams({ doc: summary.documentId ?? "" });
  if (summary.runId) params.set("run", summary.runId);
  if (s.reference.start !== undefined && s.reference.end !== undefined) {
    params.set("start", String(s.reference.start));
    params.set("end", String(s.reference.end));
  }
  if (s.reference.page) params.set("page", String(s.reference.page));
  return (
    <div className="ei-stack">
      <div>
        <strong>{s.document?.name ?? summary.name}</strong>
        <p className="ei-note">
          {data.target.kind === "reference" && data.target.preview
            ? "Preview · chunk configuration not yet saved"
            : s.snapshot
              ? "Retained run snapshot"
              : "Selected document processing version"}
          {s.document?.parsing ? ` · ${s.document.parsing.version}` : ""}
          {summary.page ? ` · page ${summary.page}` : ""}
        </p>
      </div>
      {s.unavailable && <p className="banner subtle">{s.unavailable}</p>}
      <div className="ei-source-toolbar" role="group" aria-label="Source representation">
        <button className="btn ghost sm" type="button" aria-pressed={view === "text"} onClick={() => setView("text")}>
          Readable text
        </button>
        {s.table && (
          <button className="btn ghost sm" type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Parsed table
          </button>
        )}
        {s.originalAvailable && s.paths.length > 0 && /xml/.test(s.document?.mediaType ?? "") && (
          <button className="btn ghost sm" type="button" aria-pressed={view === "structure"} onClick={() => setView("structure")}>
            Original structure
          </button>
        )}
        {s.originalAvailable && (
          <button className="btn ghost sm" type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>
            Original file
          </button>
        )}
        {summary.documentId && (
          <Link className="btn ghost sm" to={`/p/${pid}/documents?${params}`}>
            Open in Documents ↗
          </Link>
        )}
      </div>
      {s.integrity === "mismatch" && (
        <p className="banner warn" role="alert">
          The parsed text differs from its recorded hash. Review source integrity before trusting its locations.
        </p>
      )}
      {view === "original" ? (
        <OriginalSource pid={pid} data={data} />
      ) : view === "structure" ? (
        <OriginalStructure pid={pid} data={data} />
      ) : view === "table" && s.table ? (
        <>
          <p className="ei-note">
            Parsed table · highlighted rows contain the cited text. Original layout and merged cells are not represented.
          </p>
          <div className="ei-table-wrap">
            <table className="data-table ei-table">
              <caption>{s.section?.join(" › ") || "Table in the parsed source"}</caption>
              <tbody>
                {s.table.rows.map((row, i) => (
                  <tr key={i} data-cited={row.highlighted || undefined}>
                    {row.cells.map((cell, j) =>
                      row.header ? (
                        <th key={j} scope="col">
                          {cell}
                        </th>
                      ) : (
                        <td key={j}>{cell}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.table.truncated && <p className="ei-note">Showing the first 100 rows. Open the complete document for remaining rows.</p>}
        </>
      ) : excerpt ? (
        <>
          {s.section?.length ? <p className="ei-section-path">{s.section.join(" › ")}</p> : null}
          <div className="ei-excerpt" role="document" aria-label="Source passage">
            {excerpt.start > 0 && <p className="ei-note">… earlier text</p>}
            {hl ? (
              <>
                {excerpt.text.slice(0, hl.start)}
                <mark>{excerpt.text.slice(hl.start, hl.end)}</mark>
                {excerpt.text.slice(hl.end)}
              </>
            ) : (
              excerpt.text
            )}
            {excerpt.end < excerpt.total && <p className="ei-note">… more text in the document</p>}
          </div>
          <p className="ei-note">
            Characters {excerpt.start.toLocaleString()}–{excerpt.end.toLocaleString()} · UTF-16 offsets
          </p>
        </>
      ) : (
        <p className="ei-note">No parsed source text is available for this reference.</p>
      )}
      {!hl && s.reference.quote && <blockquote className="evidence-claimed">Quoted text: “{s.reference.quote}”</blockquote>}
      <details className="ei-details">
        <summary>Source integrity and structural locations</summary>
        <dl className="kv-list">
          <dt>Parsed text integrity</dt>
          <dd>
            {s.integrity === "match"
              ? "Matches the recorded SHA-256"
              : s.integrity === "mismatch"
                ? "Mismatch with recorded SHA-256"
                : "No parsed-text hash recorded"}
          </dd>
          <dt>Source structure</dt>
          <dd>
            {s.paths.length
              ? s.paths.map((path) => (
                  <code key={path}>
                    {path}
                    <br />
                  </code>
                ))
              : s.section?.length
                ? "Section recorded in parsed text"
                : "Structural mapping unavailable"}
          </dd>
          <dt>Original SHA-256</dt>
          <dd className="ei-hash">{s.document?.checksum ?? "Not recorded"}</dd>
          <dt>Parsed text SHA-256</dt>
          <dd className="ei-hash">{s.textHash ?? "Not available"}</dd>
          {summary.runId && (
            <>
              <dt>Run</dt>
              <dd className="ei-hash">{summary.runId}</dd>
            </>
          )}
          {summary.chunkId && (
            <>
              <dt>Chunk</dt>
              <dd className="ei-hash">{summary.chunkId}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

interface Props {
  pid: string;
  data?: EvidenceInspection;
  error: unknown;
  loading: boolean;
  retry: () => void;
  tab: EvidenceTab;
  onTab: (tab: EvidenceTab) => void;
  onSource: (index: number) => void;
  onClose: () => void;
  expanded: boolean;
  onExpand: () => void;
  embedded?: boolean;
  review?: FactReview;
  canReview: boolean;
  onReview: (status: "accepted" | "rejected") => void;
  onUndo?: () => void;
  saveLabel?: string;
  reviewError?: string | null;
}
export function EvidenceInspector({
  pid,
  data,
  error,
  loading,
  retry,
  tab,
  onTab,
  onSource,
  onClose,
  expanded,
  onExpand,
  embedded,
  review,
  canReview,
  onReview,
  onUndo,
  saveLabel,
  reviewError,
}: Props) {
  const id = useId();
  const input = useQuery({
    queryKey: ["evidence-input", pid, data?.target, data?.sourceIndex, data?.revision?.contentHash],
    queryFn: ({ signal }) => evidenceApi.inspect(pid, { target: data!.target, sourceIndex: data!.sourceIndex, part: "input" }, signal),
    enabled: !!data && tab === "input",
    staleTime: 30000,
  });
  const [copyError, setCopyError] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    setCopyError(undefined);
  }, [data?.target, data?.sourceIndex]);
  const ref = data?.source?.reference;
  const match = data?.source?.match;
  return (
    <section className="ei-inspection" aria-label="Evidence inspector">
      <header className="ei-head">
        <div className="ei-heading">
          <span className="ei-eyebrow">Inspect evidence</span>
          <div className="ei-head-actions">
            <button
              className="btn ghost sm"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                  setCopied(true);
                  setCopyError(undefined);
                } catch {
                  setCopyError("Copy this page's address to share the selected evidence.");
                }
              }}
            >
              {copied ? "Link copied" : "Copy link"}
            </button>
            <button className="btn ghost sm" type="button" onClick={onExpand} aria-pressed={expanded}>
              {expanded ? "Restore panel" : "Expand reader"}
            </button>
            <button
              className="btn ghost sm"
              type="button"
              onClick={onClose}
              aria-label={embedded ? "Back to answer evidence" : "Close evidence inspector"}
            >
              {embedded ? "Back to answer evidence" : "Close"}
            </button>
          </div>
        </div>
        {data && (
          <>
            <h2>{data.title}</h2>
            <p className="ei-note">
              {data.revision
                ? data.revision.status === "draft"
                  ? "Draft graph · changes are saved to the draft"
                  : `Saved graph version ${data.revision.number ?? ""}`
                : "Source inspection"}
            </p>
            <ul className="ei-checks" aria-label="Independent evidence checks">
              {match && (ref?.quote || match === "vision") && (
                <li>
                  <span>Quote location</span>
                  <StatusBadge tone={match === "exact" || match === "normalized" ? "ok" : "warn"}>{quoteMatchLabel[match]}</StatusBadge>
                </li>
              )}
              {ref && (data.assertion || ref.claim || ref.confidence !== undefined) && (
                <li>
                  <span>Claim support</span>
                  <StatusBadge tone={data.source?.support === "passed" ? "ok" : data.source?.support === "review" ? "warn" : "muted"}>
                    {data.source?.support === "unrecorded"
                      ? "Not checked"
                      : data.source?.support === "review"
                        ? "Needs review"
                        : data.source?.support === "passed"
                          ? "Support check passed"
                          : "Score recorded"}
                  </StatusBadge>
                </li>
              )}
              {data.assertion && (
                <li>
                  <span>Review decision</span>
                  <StatusBadge
                    tone={
                      (review?.status ?? data.assertion.status) === "candidate"
                        ? "warn"
                        : (review?.status ?? data.assertion.status) === "rejected"
                          ? "alert"
                          : "ok"
                    }
                  >
                    {reviewLabel(review ?? data.assertion.review)}
                  </StatusBadge>
                </li>
              )}
            </ul>
            {ref?.confidence !== undefined && (
              <details className="ei-support">
                <summary>Support score {ref.confidence.toFixed(3)}</summary>
                <p>
                  {ref.claim ? `Checked claim: ${ref.claim}` : "Claim wording was not recorded."} This is a model score, not a calibrated
                  probability that the assertion is true.
                </p>
              </details>
            )}
          </>
        )}
        {copyError && (
          <p role="status" className="ei-note">
            {copyError}
          </p>
        )}
      </header>
      {loading ? (
        <LoadingState label="Opening retained evidence…" />
      ) : error ? (
        <ErrorState title="Evidence unavailable" error={error} onRetry={retry} />
      ) : (
        data && (
          <>
            {data.sources.length > 1 && (
              <label className="ei-source-picker">
                Supporting source · {data.sourceIndex + 1} of {data.totalSources}
                <select
                  aria-label={`Supporting source · ${data.sourceIndex + 1} of ${data.totalSources}`}
                  value={data.sourceIndex}
                  onChange={(e) => onSource(Number(e.target.value))}
                >
                  {data.sources.map((s) => (
                    <option key={s.index} value={s.index}>
                      {s.name}
                      {s.page ? ` · page ${s.page}` : ""}
                      {s.runId ? " · retained" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div
              className="tabbar ei-tabs"
              role="tablist"
              tabIndex={-1}
              aria-label="Evidence views"
              onKeyDown={(e) => {
                const tabs: EvidenceTab[] = ["source", "input", "history"];
                const at = tabs.indexOf(tab);
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const next = e.key === "Home" ? 0 : e.key === "End" ? 2 : (at + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                onTab(tabs[next]);
                document.getElementById(`${id}-${tabs[next]}`)?.focus();
              }}
            >
              {(
                [
                  ["source", "Source"],
                  ["input", "Model input"],
                  ["history", "History"],
                ] as const
              ).map(([t, label]) => (
                <button
                  className={`tab${tab === t ? " on" : ""}`}
                  id={`${id}-${t}`}
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  aria-controls={`${id}-content`}
                  onClick={() => onTab(t)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="ei-content" id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
              {tab === "source" &&
                (data.query ? (
                  <div className="ei-stack">
                    <p>{data.message}</p>
                    <pre className="ei-code">{data.query.query}</pre>
                    <p>{data.query.rowCount.toLocaleString()} result rows · showing up to 100 recorded rows</p>
                    <pre className="ei-code">{JSON.stringify(data.query.rows, null, 2)}</pre>
                    {data.query.error && <p className="banner warn">{data.query.error}</p>}
                  </div>
                ) : (
                  <SourcePane key={JSON.stringify([data.target, data.sourceIndex])} pid={pid} data={data} />
                ))}
              {tab === "input" &&
                (input.isLoading ? (
                  <LoadingState label="Loading recorded inputs…" />
                ) : input.error ? (
                  <ErrorState error={input.error} onRetry={() => void input.refetch()} />
                ) : (
                  <div className="ei-stack">
                    {input.data?.inputs?.length ? (
                      input.data.inputs.map((b, i) => (
                        <section key={i} className="ei-input-block">
                          <div className="ei-block-heading">
                            <h3>{b.label}</h3>
                            <StatusBadge tone={b.state === "recorded" ? "info" : "muted"}>
                              {
                                {
                                  recorded: "Recorded",
                                  reconstructed: "Reconstructed from recorded policy",
                                  unavailable: "Not recorded",
                                  reused: "Reused result",
                                }[b.state]
                              }
                            </StatusBadge>
                          </div>
                          {b.note && <p className="ei-note">{b.note}</p>}
                          {b.text !== undefined && <pre className="ei-code">{b.text}</pre>}
                          {b.truncated && <p className="ei-note">Input preview truncated at 24,000 characters.</p>}
                        </section>
                      ))
                    ) : (
                      <p>No model inputs are associated with this target.</p>
                    )}
                  </div>
                ))}
              {tab === "history" && (
                <ol className="ei-history">
                  {data.history.map((h, i) => (
                    <li key={i}>
                      <strong>{h.label}</strong>
                      <span>{h.detail}</span>
                      {h.at && <small>{fmtDate(h.at)}</small>}
                    </li>
                  ))}
                  {!data.history.length && <li>No processing history was recorded for this target.</li>}
                </ol>
              )}
            </div>
            {data.assertion && (
              <footer className="ei-review">
                <p className="ei-note">
                  {canReview
                    ? "Review changes affect your working draft. Save a graph version to publish them."
                    : data.revision?.status === "committed" && !data.revision.current
                      ? "Historical graph versions are read only. Restore the version from graph history before changing its review decisions."
                      : "Open this graph version in Explore to review its assertions."}
                </p>
                <div className="row-actions">
                  {canReview ? (
                    <>
                      <button className="btn sm" type="button" onClick={() => onReview("accepted")}>
                        Accept in draft
                      </button>
                      <button className="btn ghost sm" type="button" onClick={() => onReview("rejected")}>
                        Reject in draft
                      </button>
                      {onUndo && (
                        <button className="btn ghost sm" type="button" onClick={onUndo}>
                          Undo decision
                        </button>
                      )}
                    </>
                  ) : (
                    data.revision && (
                      <Link
                        className="btn ghost sm"
                        to={`/p/${pid}/explore?rev=${data.revision.id}&inspect=${encodeURIComponent(JSON.stringify(data.target))}`}
                      >
                        Open graph version
                      </Link>
                    )
                  )}
                </div>
                {saveLabel && (
                  <p className="ei-note" role="status">
                    {saveLabel}
                  </p>
                )}
                <InlineError error={reviewError} />
              </footer>
            )}
          </>
        )
      )}
    </section>
  );
}
