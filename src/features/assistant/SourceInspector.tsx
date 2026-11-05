import { hasCitation } from "../../lib/answerCitations";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../../lib/http";
import type { DocumentText } from "../../types/project";
import type { AnswerPassage, EvidenceSearchResult } from "../../types/sourceEvidence";
import { InlineError, LoadingState } from "../../components/ui/ui";
import { DocumentViewer } from "../documents/DocumentViewer";
import type { Turn } from "./graphChat";

function PassageContext({ pid, revisionId, passage }: { pid: string; revisionId: string; passage: AnswerPassage }) {
  const context = useQuery({
    queryKey: ["passage-context", pid, revisionId, passage.key],
    queryFn: ({ signal }) =>
      request<DocumentText>("GET", `api/projects/${pid}/revisions/${revisionId}/evidence/passages/${passage.key}`, { signal }),
    staleTime: Infinity,
  });
  if (context.isLoading) return <LoadingState label="Opening saved text…" />;
  if (context.error)
    return (
      <>
        <p>The saved excerpt remains below; full source context is unavailable.</p>
        <InlineError error={context.error} />
      </>
    );
  return context.data ? (
    <DocumentViewer
      pid={pid}
      documentId={passage.evidence.documentId!}
      snapshot={context.data}
      highlight={{ start: passage.evidence.start!, end: passage.evidence.end! }}
    />
  ) : null;
}

export function SourceInspector({
  pid,
  conversationId,
  turn,
  focus,
  onUse,
  onOpenDocument,
}: {
  pid: string;
  conversationId?: string;
  turn: Turn;
  focus?: string;
  onUse?: (passage: AnswerPassage) => void;
  onOpenDocument?: (passage: AnswerPassage) => void;
}) {
  const passages = turn.passages ?? [];
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState("unsupported");
  const issue = useMutation({
    mutationFn: (key: string) =>
      request("POST", `api/projects/${pid}/conversations/${conversationId}/messages/${turn.id}/citation-issues`, { body: { key, reason } }),
  });
  const [selected, setSelected] = useState<AnswerPassage>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(turn.question);
  const [submitted, setSubmitted] = useState("");
  const [context, setContext] = useState(false);
  const rid = turn.sourceCoverage?.revisionId;
  const result = useQuery({
    queryKey: ["saved-source-search", pid, rid, submitted],
    queryFn: ({ signal }) =>
      request<EvidenceSearchResult>("POST", `api/projects/${pid}/revisions/${rid}/evidence/search`, { body: { query: submitted }, signal }),
    enabled: !!rid && !!submitted,
  });
  const focused = passages.find((p) => p.ref === focus);
  const passage = selected ?? (searching ? undefined : focused);
  const used = passages.filter((p) => hasCitation(turn.answer, p.ref));
  const coverage = result.data?.coverage ?? turn.sourceCoverage;
  const choose = (p: AnswerPassage) => {
    setSelected(p);
    setContext(false);
  };
  const groups = new Map<string, AnswerPassage[]>();
  for (const p of result.data?.passages ?? []) {
    const key = `${p.evidence.runId}:${p.evidence.documentId}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return (
    <div className="gc-pad source-inspector">
      {focus && !focused && <p role="status">This citation is unavailable in the selected answer.</p>}
      {coverage && (
        <p className="field-hint">
          {coverage.label} · saved parsed text · keyword search
          <br />
          {coverage.available} of {coverage.total} saved documents available{coverage.unavailable.length ? " · Coverage incomplete" : ""}
        </p>
      )}
      {passage ? (
        <section aria-label="Selected source passage">
          <button
            className="btn ghost sm"
            onClick={() => {
              setSelected(undefined);
              setSearching(true);
            }}
          >
            Back to sources
          </button>
          {used.some((p) => p.key === passage.key) && (
            <>
              <p className="small muted">Claim in this answer</p>
              <p>
                {turn.answer
                  .split(/\n\n/)
                  .find((text) => hasCitation(text, passage.ref))
                  ?.replace(/\[(?:C|Q)\d+\]/g, "")}
              </p>
            </>
          )}
          <h3>{passage.title}</h3>
          <p className="small muted">{passage.where}</p>
          <p className="small">
            {used.some((p) => p.key === passage.key) ? "Used in this answer" : "Not used in this answer"} · From source
          </p>
          <blockquote className="source-excerpt">{passage.evidence.quote}</blockquote>
          <p className="field-hint">
            Quote located in saved text. This does not establish that the passage supports every claim in the answer.
          </p>
          <div className="row-actions">
            {rid && (
              <button className="btn sm" onClick={() => setContext((v) => !v)} aria-expanded={context}>
                {context ? "Hide context" : "More context"}
              </button>
            )}
            {rid && onOpenDocument && (
              <button className="btn sm" onClick={() => onOpenDocument(passage)}>
                Inspect saved source
              </button>
            )}
            {!rid && onOpenDocument && (
              <button className="btn ghost sm" onClick={() => onOpenDocument(passage)}>
                Open current source
              </button>
            )}
            {rid && onUse && (
              <button className="btn ghost sm" onClick={() => onUse(passage)}>
                Ask using this passage
              </button>
            )}
          </div>
          {conversationId && used.some((p) => p.key === passage.key) && (
            <div>
              <button className="btn ghost sm" onClick={() => setReport((v) => !v)}>
                Report citation issue
              </button>
              {report && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    issue.mutate(passage.key);
                  }}
                >
                  <label>
                    Issue
                    <select aria-label="Citation issue" value={reason} onChange={(e) => setReason(e.target.value)}>
                      <option value="unsupported">Does not support this claim</option>
                      <option value="location">Wrong source location</option>
                      <option value="context">Missing context</option>
                    </select>
                  </label>
                  <button className="btn sm" disabled={issue.isPending}>
                    Record issue
                  </button>
                </form>
              )}
              {issue.isSuccess && <p role="status">Citation issue recorded.</p>}
              <InlineError error={issue.error} />
            </div>
          )}
          {context && rid && <PassageContext pid={pid} revisionId={rid} passage={passage} />}
        </section>
      ) : (
        <>
          {!searching && (
            <section aria-label="Sources used in this answer">
              <h3>Used in this answer</h3>
              {used.length ? (
                used.map((p) => (
                  <button className="source-hit" key={p.ref} onClick={() => choose(p)}>
                    <strong>{p.title}</strong>
                    <span>{p.where}</span>
                    <span>{p.evidence.quote.slice(0, 180)}…</span>
                  </button>
                ))
              ) : (
                <p>No document passages were cited. Graph results remain available in Details.</p>
              )}
            </section>
          )}
          {rid && (
            <button className="btn ghost sm" onClick={() => setSearching((v) => !v)}>
              {searching ? "Used in this answer" : "Search saved sources"}
            </button>
          )}
          {searching && rid && (
            <section aria-label="Search saved sources">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (query.trim()) {
                    if (submitted === query.trim()) void result.refetch();
                    else setSubmitted(query.trim());
                  }
                }}
              >
                <label>
                  Search saved sources
                  <input aria-label="Search saved sources" value={query} maxLength={2000} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <button className="btn sm" disabled={!query.trim() || result.isFetching}>
                  Search
                </button>
              </form>
              <InlineError error={result.error} />
              {result.isFetching && <LoadingState label="Searching saved sources…" />}
              {result.data && !result.isFetching && (
                <div aria-live="polite">
                  <p className="small">
                    {result.data.passages.length} passages from {groups.size} {groups.size === 1 ? "document" : "documents"} · Not used in
                    this answer
                  </p>
                  {!result.data.passages.length && <p>No matching passages found in these saved sources. Try different words.</p>}
                  {[...groups].map(([key, hits]) => (
                    <section key={key}>
                      <h3>{hits[0].title}</h3>
                      {hits.map((p) => (
                        <button className="source-hit" key={p.key} onClick={() => choose(p)}>
                          <span>{p.where}</span>
                          <span>{p.evidence.quote.slice(0, 220)}…</span>
                        </button>
                      ))}
                    </section>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
      {!rid && (
        <p className="field-hint">
          Saved-source search is available for corpus graph versions. Legacy passages retain their captured excerpts.
        </p>
      )}
    </div>
  );
}
