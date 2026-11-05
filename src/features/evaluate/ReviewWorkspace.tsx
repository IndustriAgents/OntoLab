import { useState } from "react";
import { EmptyState } from "../../components/ui/ui";
import type { Evaluation, EvaluationAttempt, EvaluationCapture, EvaluationJudgment, EvaluationQuestion } from "../../types/evaluation";
import { AnswerContent, SourceReader } from "./AnswerEvidence";
import { reviewFor, gradeLabel, label } from "./evaluationUi";
import { reviewDraftKey, useReviewDraft } from "./reviewDraft";

export function ReviewWorkspace({
  pid,
  item,
  attempt,
  questionId,
  captureId,
  busy,
  onSelect,
  onSave,
}: {
  pid: string;
  item: Evaluation;
  attempt: EvaluationAttempt;
  questionId: string | null;
  captureId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onSave: (body: unknown, nextId: string | null) => Promise<void>;
}) {
  const [blind, setBlind] = useState(false);
  const captures = [...attempt.captures].filter((c) => !c.error).sort((a, b) => a.id.localeCompare(b.id));
  const capture =
    captures.find((c) => c.id === captureId) ??
    captures.find((c) => c.questionId === questionId && !reviewFor(item, c)) ??
    captures.find((c) => !reviewFor(item, c)) ??
    captures[0];
  if (!capture) return <EmptyState title="No successful answers to review">Inspect the run errors in Results.</EmptyState>;
  const question = item.questions.find((q) => q.id === capture.questionId)!;
  const previous = reviewFor(item, capture);
  const next = captures.find((c) => c.id !== capture.id && !reviewFor(item, c));
  return (
    <>
      <div className="evaluation-heading">
        <div>
          <h3>Review answers against their evidence</h3>
          <label className="evaluation-check">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            Hide version labels and previous judgments
          </label>
        </div>
        <span>
          {captures.filter((c) => reviewFor(item, c)).length}/{captures.length} reviewed
        </span>
      </div>
      <label className="field">
        <span>Answer to review</span>
        <select disabled={busy} value={capture.id} onChange={(e) => onSelect(e.target.value)}>
          {captures.map((c) => (
            <option key={c.id} value={c.id}>
              {item.questions.find((q) => q.id === c.questionId)?.text} ·{" "}
              {blind ? `answer ${c.id.slice(-4)}` : `${label(c.arm)} · version ${item[c.arm].number}`} ·{" "}
              {reviewFor(item, c) ? "reviewed" : "unreviewed"}
            </option>
          ))}
        </select>
      </label>
      <ReviewEditor
        key={`${capture.id}:${previous?.id ?? "new"}`}
        pid={pid}
        item={item}
        capture={capture}
        previous={previous}
        question={question}
        busy={busy}
        blind={blind}
        onSkip={() => onSelect(captures[(captures.indexOf(capture) + 1) % captures.length].id)}
        onSave={(body) => onSave(body, next?.id ?? null)}
      />
    </>
  );
}

function ReviewEditor({
  pid,
  item,
  capture,
  question,
  previous,
  busy,
  onSkip,
  onSave,
  blind,
}: {
  pid: string;
  item: Evaluation;
  capture: EvaluationCapture;
  question: EvaluationQuestion;
  previous?: EvaluationJudgment;
  busy: boolean;
  onSkip: () => void;
  onSave: (body: unknown) => Promise<void>;
  blind: boolean;
}) {
  const { draft, update, clear, storageError } = useReviewDraft(reviewDraftKey(item.ownerId, pid, item.id, capture.id, previous?.id));
  const { grade, support, sourceId, quote, reason, confirmed } = draft;
  return (
    <form
      className="evaluation-review"
      aria-label="Answer source review"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          captureId: capture.id,
          previousId: previous?.id ?? null,
          grade,
          support,
          sourceId: sourceId || null,
          quote,
          reason,
          confirmedSourceReview: confirmed,
          start: draft.start,
          end: draft.end,
        })
          .then(clear)
          .catch(() => {
            /* The workspace displays the error; retain the draft. */
          });
      }}
    >
      <fieldset disabled={busy} className="evaluation-review-fields">
        <div className="evaluation-review-evidence">
          <h3>{question.text}</h3>
          {!blind && (
            <p className="eyebrow">
              {label(capture.arm)} · version {item[capture.arm].number}
            </p>
          )}
          <p className="evaluation-expectation">
            Expected: {capture.arm === "baseline" ? (question.baselineExpectation ?? question.expectation) : question.expectation}
          </p>
          <AnswerContent pid={pid} item={item} capture={capture} />
          <SourceReader
            pid={pid}
            item={item}
            capture={capture}
            selectedSourceId={sourceId}
            onSource={(id, text, start, end) => update({ sourceId: id, quote: text, start, end })}
          />
        </div>
        <div className="evaluation-review-controls">
          <p className="field-hint" role="status">
            {storageError
              ? "Draft kept while navigating. Browser storage is unavailable; save before reloading."
              : "Unsubmitted draft is saved in this browser tab."}
          </p>
          {previous && (
            <details open={!blind}>
              <summary>Reveal previous judgment</summary>
              <p>
                {gradeLabel(previous.grade)} · {previous.support} · {previous.reason}
              </p>
              <blockquote>{previous.quote}</blockquote>
            </details>
          )}
          <div className="evaluation-answers">
            <label className="field">
              <span>Answer correctness</span>
              <select required value={grade} onChange={(e) => update({ grade: e.target.value })}>
                <option value="">Choose a judgment</option>
                <option value="correct">Correct</option>
                <option value="partial">Partially correct</option>
                <option value="incorrect">Incorrect</option>
                <option value="unassessable">Not assessable</option>
              </select>
            </label>
            <label className="field">
              <span>Source support</span>
              <select required value={support} onChange={(e) => update({ support: e.target.value })}>
                <option value="">Choose source support</option>
                <option value="supported">Supported by the saved source</option>
                <option value="unsupported">Not supported / contradicted</option>
                <option value="unavailable">Source support unavailable</option>
              </select>
            </label>
          </div>
          {support && support !== "unavailable" && (
            <>
              <p className="field-hint">
                Review source: {capture.sources.find((source) => source.id === sourceId)?.name ?? "Choose a passage in the source viewer"}
              </p>
              <label className="field">
                <span>Exact supporting or contradicting passage</span>
                <textarea
                  required
                  minLength={5}
                  maxLength={8000}
                  rows={3}
                  value={quote}
                  onChange={(e) => update({ quote: e.target.value, start: undefined, end: undefined })}
                  placeholder="Copy a unique exact passage from the saved source."
                />
              </label>
            </>
          )}
          <label className="field">
            <span>Reason for the judgment</span>
            <textarea
              required
              minLength={5}
              maxLength={5000}
              rows={3}
              value={reason}
              onChange={(e) => update({ reason: e.target.value })}
            />
          </label>
          <label className="evaluation-check">
            <input required type="checkbox" checked={confirmed} onChange={(e) => update({ confirmed: e.target.checked })} />I inspected the
            expected answer, query results and available source evidence.
          </label>
          <div className="evaluation-heading">
            <button className="btn ghost" type="button" disabled={busy} onClick={onSkip}>
              Skip · leave unchanged
            </button>
            <button
              className="btn"
              disabled={
                busy ||
                !grade ||
                !support ||
                reason.trim().length < 5 ||
                !confirmed ||
                (support !== "unavailable" && (!sourceId || quote.trim().length < 5))
              }
            >
              Save review &amp; next
            </button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
