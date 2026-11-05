import { useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { evaluationApi } from "../../lib/evaluationApi";
import { DocumentViewer } from "../documents/DocumentViewer";
import { Markdown } from "../assistant/Markdown";
import type { Evaluation, EvaluationCapture, EvaluationJudgment } from "../../types/evaluation";
import { cost, gradeLabel, label } from "./evaluationUi";

export function AnswerContent({ pid, item, capture }: { pid: string; item: Evaluation; capture: EvaluationCapture }) {
  const traceRef = useRef<HTMLDetailsElement>(null);
  const navigate = useNavigate();
  return (
    <>
      <Markdown
        text={capture.answer}
        onQuery={(id) => {
          const trace = traceRef.current;
          if (!trace) return;
          trace.open = true;
          requestAnimationFrame(() => {
            const query = Array.from(trace.querySelectorAll<HTMLElement>("[data-query-id]")).find(
              (element) => element.dataset.queryId === id,
            );
            query?.focus({ preventScroll: true });
            query?.scrollIntoView({ block: "nearest" });
          });
        }}
        onEntity={(id) =>
          navigate(`/p/${pid}/explore?rev=${encodeURIComponent(item[capture.arm].revisionId)}&sel=${encodeURIComponent(id)}`)
        }
      />
      <AnswerTrace capture={capture} traceRef={traceRef} />
    </>
  );
}

export function CapturedAnswer({
  pid,
  item,
  capture,
  review,
}: {
  pid: string;
  item: Evaluation;
  capture: EvaluationCapture;
  review?: EvaluationJudgment;
}) {
  return (
    <>
      {capture.error ? (
        <p role="alert" className="evaluation-error">
          {capture.error}
        </p>
      ) : (
        <>
          <AnswerContent pid={pid} item={item} capture={capture} />
          <StatusBadge tone={review?.grade === "correct" ? "ok" : review?.grade === "incorrect" ? "warn" : "muted"}>
            {gradeLabel(review?.grade ?? "")}
          </StatusBadge>
          {review && (
            <p className="field-hint">
              Source support: {label(review.support)} · {review.reason}
            </p>
          )}
        </>
      )}
      {capture.error && <AnswerTrace capture={capture} />}
      {review?.quote && (
        <blockquote className="evaluation-reviewed-quote">
          <strong>Reviewed passage</strong>
          <p>{review.quote}</p>
        </blockquote>
      )}
      <SourceReader key={`${capture.id}:${review?.id ?? "new"}`} pid={pid} item={item} capture={capture} review={review} />
    </>
  );
}

function AnswerTrace({ capture, traceRef }: { capture: EvaluationCapture; traceRef?: RefObject<HTMLDetailsElement> }) {
  return (
    <details className="evaluation-trace" ref={traceRef}>
      <summary>Queries, results and model usage</summary>
      {capture.agent?.runs.map((run) => (
        <section key={run.id} data-query-id={run.id} tabIndex={-1}>
          <strong>
            {run.id} · {run.ok ? `${run.rowCount} rows` : "Query failed"}
          </strong>
          <pre>{run.query}</pre>
          {run.error ? <p role="alert">{run.error}</p> : <pre>{JSON.stringify(run.rows, null, 2)}</pre>}
          {run.rowCount > run.rows.length && (
            <p className="field-hint">
              Only {run.rows.length} of {run.rowCount} rows were retained.
            </p>
          )}
        </section>
      ))}
      <p className="field-hint">
        {capture.agent?.model ?? "Model unavailable"} · {capture.agent?.durationMs ?? "—"} ms · {capture.agent?.usage?.input ?? "—"} input
        tokens · {capture.agent?.usage?.output ?? "—"} output tokens · {cost(capture.costUsd)}
      </p>
    </details>
  );
}

export function SourceReader({
  pid,
  item,
  capture,
  onSource,
  review,
  selectedSourceId,
}: {
  pid: string;
  item: Evaluation;
  capture: EvaluationCapture;
  onSource?: (sourceId: string, quote: string, start?: number, end?: number) => void;
  review?: EvaluationJudgment;
  selectedSourceId?: string;
}) {
  const [browsingId, setBrowsingId] = useState(review?.sourceId ?? capture.sources[0]?.id ?? "");
  const sourceId = selectedSourceId || browsingId;
  const source = capture.sources.find((s) => s.id === sourceId);
  const saved = useQuery({
    queryKey: ["evaluation-source", pid, item.id, sourceId],
    queryFn: () => evaluationApi.source(pid, item.id, sourceId),
    enabled: !!source?.available,
    staleTime: Infinity,
  });
  const isReviewedSource = review?.sourceId === sourceId;
  const quote = (isReviewedSource ? review.quote : source?.evidence.quote) ?? "";
  const savedText = saved.data?.text;
  const offset = isReviewedSource ? review.start : source?.evidence.start;
  const first = quote && savedText ? savedText.indexOf(quote) : -1;
  const start =
    savedText && offset != null && savedText.slice(offset, offset + quote.length) === quote
      ? offset
      : savedText && first >= 0 && savedText.lastIndexOf(quote) === first
        ? first
        : -1;
  const highlight = useMemo(() => (quote && start >= 0 ? { start, end: start + quote.length } : undefined), [quote, start]);
  return (
    <section className="evaluation-source" aria-label="Retained source evidence">
      <h4>Retained source evidence</h4>
      {capture.sources.length ? (
        <>
          <label className="field">
            <span>Source reference</span>
            <select
              value={sourceId}
              onChange={(e) => {
                setBrowsingId(e.target.value);
                onSource?.(e.target.value, "");
              }}
            >
              {capture.sources.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {s.name}
                  {s.available ? "" : " · unavailable"}
                </option>
              ))}
            </select>
          </label>
          {saved.isLoading && <LoadingState label="Opening retained source…" />}
          <InlineError error={saved.error} />
          {!source?.available && <p className="muted">{source?.issue ?? "The original source is unavailable."}</p>}
          {saved.data && (
            <>
              <p className="field-hint">
                {isReviewedSource ? "The passage selected for this saved judgment." : "Retained extraction text"}
              </p>
              <DocumentViewer
                key={sourceId}
                pid={pid}
                documentId={source?.evidence.documentId ?? sourceId}
                snapshot={saved.data}
                scrollMode="container"
                highlight={highlight}
                page={source?.evidence.page}
                onSelectPassage={onSource ? (selection) => onSource(sourceId, selection.text, selection.start, selection.end) : undefined}
              />
              {onSource && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    onSource(
                      sourceId,
                      quote && start >= 0 ? quote : "",
                      start >= 0 ? start : undefined,
                      start >= 0 ? start + quote.length : undefined,
                    )
                  }
                >
                  Use highlighted passage
                </button>
              )}
            </>
          )}
          {capture.sourcesTruncated && (
            <p className="field-hint">
              Only the first 30 distinct source references were retained. Review the graph trace for further context.
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          No retained document reference was found for the queried entities. Inspect query results and mark source support unavailable if it
          cannot be assessed.
        </p>
      )}
    </section>
  );
}
