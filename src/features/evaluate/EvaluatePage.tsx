import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useProject } from "../../app/project";
import { EmptyState, ErrorState, InlineError, LoadingState, PageHead, StatusBadge, fmtDate } from "../../components/ui/ui";
import { api } from "../../lib/projectApi";
import { evaluationApi, evaluationKeys } from "../../lib/evaluationApi";
import { scoreEvaluation } from "../../lib/evaluation";
import { activeEvaluationStates, type Evaluation } from "../../types/evaluation";
import { ComparisonSetup } from "./ComparisonSetup";
import { CapturedAnswer } from "./AnswerEvidence";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { cost, label, reviewFor } from "./evaluationUi";
import "./evaluate.css";

type Tab = "results" | "review" | "reports";
const tabs: Tab[] = ["results", "review", "reports"];
type SetupMode = "new" | "edit" | "copy" | "next";

export default function EvaluatePage() {
  const { pid, project } = useProject();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState<SetupMode | null>(params.get("new") === "1" ? "new" : null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [driverError, setDriverError] = useState<unknown>(null);
  const list = useQuery({
    queryKey: evaluationKeys.list(pid),
    queryFn: () => evaluationApi.list(pid),
    refetchInterval: (query) => (query.state.data?.some((e) => activeEvaluationStates.includes(e.state)) ? 5000 : false),
  });
  const setup = useQuery({ queryKey: evaluationKeys.setup(pid), queryFn: () => evaluationApi.setup(pid) });
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const selectedId = params.get("evaluation") ?? list.data?.[0]?.id ?? "";
  const detail = useQuery({
    queryKey: evaluationKeys.detail(pid, selectedId),
    queryFn: () => evaluationApi.get(pid, selectedId),
    enabled: !!selectedId,
    refetchOnWindowFocus: !params.get("report"),
    refetchInterval: (query) =>
      !params.get("report") && query.state.data && activeEvaluationStates.includes(query.state.data.state) ? 2000 : false,
  });
  const item = detail.data;
  const selectedReport = item?.reports.find((r) => r.id === params.get("report"));
  const attempt = item?.attempts.find((a) => a.id === (selectedReport?.attemptId ?? params.get("attempt"))) ?? item?.attempts.at(-1);
  const tab = params.get("tab") === "runs" ? "reports" : (tabs.find((t) => t === params.get("tab")) ?? "results");

  const currentScore =
    item && attempt
      ? scoreEvaluation(
          selectedReport ? { ...item, judgments: item.judgments.filter((j) => selectedReport.judgmentIds.includes(j.id)) } : item,
          attempt,
        )
      : null;
  const score = selectedReport
    ? {
        ...selectedReport,
        outcomes: selectedReport.outcomes.map((o) => ({
          ...o,
          supportOutcome: o.supportOutcome ?? currentScore?.outcomes.find((current) => current.questionId === o.questionId)?.supportOutcome,
        })),
      }
    : currentScore;
  const latestAttempt = item?.attempts.at(-1);
  const isLive = !selectedReport && attempt?.id === latestAttempt?.id;
  const canReview = !!isLive && !!attempt && ["awaiting_review", "completed"].includes(attempt.state);
  const remaining = score ? Math.max(0, score.total - score.errors - score.reviewed) : 0;
  const latestReport = item?.reports.at(-1);
  const reportUpToDate =
    !!score && latestReport?.attemptId === attempt?.id && latestReport?.judgmentIds.join() === score.judgmentIds.join();
  const retryAvailable =
    !!latestAttempt &&
    (["failed", "cancelled", "interrupted"].includes(latestAttempt.state) ||
      (["awaiting_review", "completed"].includes(latestAttempt.state) && latestAttempt.captures.some((c) => c.error)));
  const filter = params.get("filter") ?? "all";
  const visibleQuestions =
    item?.questions.filter((q) => {
      const outcome = score?.outcomes.find((o) => o.questionId === q.id);
      return (
        filter === "all" ||
        (filter === "regressed"
          ? outcome?.outcome === "regressed" || outcome?.supportOutcome === "regressed"
          : filter === "errors"
            ? outcome?.outcome === "error"
            : outcome?.outcome === "unreviewed" || !outcome)
      );
    }) ?? [];
  const question = visibleQuestions.find((q) => q.id === params.get("question")) ?? visibleQuestions[0];
  const [notice, setNotice] = useState("");
  const navigate = (changes: Record<string, string | null>) =>
    setParams((old) => {
      const next = new URLSearchParams(old);
      for (const [key, value] of Object.entries(changes)) {
        if (value == null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  const save = (value: Evaluation) => {
    qc.setQueryData(evaluationKeys.detail(pid, value.id), value);
    void qc.invalidateQueries({ queryKey: evaluationKeys.list(pid) });
    return value;
  };
  const action = useMutation({
    mutationFn: (fn: () => Promise<Evaluation>) => fn(),
    onSuccess: (value) => {
      save(value);
      setAcknowledged(false);
    },
  });

  // Servers with a worker keep going with the tab closed. On request-driven
  // installs, reopening an explicitly started attempt resumes the same lease.
  const driving = useRef(false);
  const state = item?.state;
  useEffect(() => {
    if (!selectedId || !state || !activeEvaluationStates.includes(state) || !config.data || config.data.features?.worker || driving.current)
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = async () => {
      if (!active || driving.current) return;
      driving.current = true;
      try {
        const value = await evaluationApi.action(pid, selectedId, "advance");
        qc.setQueryData(evaluationKeys.detail(pid, selectedId), value);
        if (active && activeEvaluationStates.includes(value.state))
          timer = setTimeout(() => {
            void advance();
          }, 1000);
      } catch (error) {
        if (active) setDriverError(error);
      } finally {
        driving.current = false;
      }
    };
    void advance();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [pid, selectedId, state, config.data, qc]);

  const run = (retry = false) => {
    if (!item) return;
    setNotice("");
    setDriverError(null);
    action.mutate(() => evaluationApi.action(pid, item.id, retry ? "retry" : "start", { acknowledgedCost: acknowledged }));
    navigate({ report: null, attempt: null, tab: "results", capture: null });
  };
  const saveReport = () => {
    if (!item) return;
    action.mutate(async () => {
      const value = await evaluationApi.action(pid, item.id, "reports");
      setNotice("Reviewed report saved.");
      navigate({ report: value.reports.at(-1)!.id, attempt: null, tab: "results" });
      return value;
    });
  };
  return (
    <div className="page evaluate-page">
      <div className="page-wide">
        <PageHead
          title="Evaluate"
          actions={
            setup.data?.eligible ? (
              <button className="btn" onClick={() => setCreating("new")}>
                New comparison
              </button>
            ) : undefined
          }
        >
          Check how a graph update changes answers. Review the evidence and save a report.
        </PageHead>
        {setup.error || list.error ? (
          <ErrorState
            error={setup.error ?? list.error}
            onRetry={() => {
              void setup.refetch();
              void list.refetch();
            }}
          />
        ) : null}
        {(setup.isLoading || list.isLoading) && <LoadingState label="Loading evaluations…" />}
        {setup.data && !setup.data.eligible && (
          <EmptyState
            title="Saved graph versions required"
            action={
              <Link className="btn ghost" to={`/p/${pid}/graph?tab=history`}>
                Open graph versions
              </Link>
            }
          >
            {setup.data.reason}
          </EmptyState>
        )}
        {creating && setup.data?.eligible && (
          <ComparisonSetup
            key={`${pid}:${creating}:${creating === "new" ? "" : selectedId}`}
            mode={creating}
            seed={creating === "new" ? undefined : item}
            pid={pid}
            setup={setup.data}
            initialBaseline={params.get("baseline")}
            initialCandidate={params.get("candidate")}
            initialQuestion={params.get("questionText")}
            onClose={() => setCreating(null)}
            onCreated={(value) => {
              save(value);
              setCreating(null);
              setNotice("Comparison saved. Start it when you are ready; no model calls have been made.");
              navigate({
                evaluation: value.id,
                tab: "results",
                report: null,
                attempt: null,
                question: null,
                new: null,
                candidate: null,
                baseline: null,
                questionText: null,
                capture: null,
                setup: null,
                filter: null,
              });
            }}
          />
        )}
        {!!list.data?.length && (
          <label className="field evaluation-picker">
            <span>Saved comparison</span>
            <select
              value={selectedId}
              onChange={(e) => {
                setDriverError(null);
                action.reset();
                navigate({ evaluation: e.target.value, report: null, attempt: null, question: null, capture: null, filter: null });
              }}
            >
              {list.data.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title} · v{e.baseline.number} → v{e.candidate.number} · {label(e.state)}
                </option>
              ))}
            </select>
          </label>
        )}
        {detail.error && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
        {selectedId && detail.isLoading && <LoadingState label="Opening saved comparison…" />}
        {!creating && setup.data?.eligible && list.data?.length === 0 && (
          <EmptyState
            title="Check your first graph update"
            action={
              <button className="btn" onClick={() => setCreating("new")}>
                Create a comparison
              </button>
            }
          >
            Choose two saved versions, add questions and expected answers, then compare the current Ask engine on both graphs.
          </EmptyState>
        )}
        {notice && (
          <p role="status" className="evaluation-notice">
            {notice}
          </p>
        )}
        {item && !creating && (
          <>
            <div className="evaluation-context">
              <div>
                <h2>{item.title}</h2>
                <p>
                  Version {item.baseline.number} → Version {item.candidate.number} · {item.questions.length}{" "}
                  {item.questions.length === 1 ? "question" : "questions"} · {item.model}
                </p>
              </div>
              <StatusBadge tone="muted">Exploratory · graph-only</StatusBadge>
            </div>
            <div className="row-actions evaluation-setup-actions">
              <button className="btn ghost" disabled={!setup.data?.eligible} onClick={() => setCreating("next")}>
                Compare with next version
              </button>
              <button
                className="btn ghost"
                disabled={!setup.data?.eligible}
                onClick={() => setCreating(item.state === "draft" ? "edit" : "copy")}
              >
                {item.state === "draft" ? "Edit setup" : "Create edited copy"}
              </button>
            </div>
            <details
              className="evaluation-setup-summary"
              open={params.get("setup") === "1" || params.get("tab") === "questions" ? true : undefined}
            >
              <summary>
                Setup · versions, model and {item.questions.length} {item.questions.length === 1 ? "question" : "questions"}
              </summary>
              <p>
                {item.state === "draft"
                  ? "Setup is editable until the first run."
                  : "This setup is pinned. Create an edited copy to change it."}
              </p>
              <p>
                Baseline v{item.baseline.number}: {item.baseline.summary}
                <br />
                Candidate v{item.candidate.number}: {item.candidate.summary}
                <br />
                Model: {item.provider}/{item.model}
              </p>
              {item.questions.map((q) => (
                <article className="evaluation-question-definition" key={q.id}>
                  <h3>{q.text}</h3>
                  <p>Expected: {q.expectation}</p>
                  {q.baselineExpectation && q.baselineExpectation !== q.expectation && <p>Baseline: {q.baselineExpectation}</p>}
                </article>
              ))}
            </details>
            <div className="evaluation-tabs" role="tablist" aria-label="Evaluation views">
              {tabs.map((t, i) => (
                <button
                  key={t}
                  className="btn ghost"
                  role="tab"
                  id={`evaluation-tab-${t}`}
                  aria-controls={`evaluation-panel-${t}`}
                  aria-selected={tab === t}
                  tabIndex={tab === t ? 0 : -1}
                  onClick={() => navigate({ tab: t })}
                  onKeyDown={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                    navigate({ tab: tabs[next] });
                    document.getElementById(`evaluation-tab-${tabs[next]}`)?.focus();
                  }}
                >
                  {label(t)}
                  {t === "review" && score ? ` (${Math.max(0, score.total - score.errors - score.reviewed)})` : ""}
                </button>
              ))}
            </div>
            <InlineError error={action.error ?? driverError} />
            {driverError && (
              <button
                className="btn ghost"
                onClick={() => {
                  setDriverError(null);
                  action.mutate(() => evaluationApi.action(pid, item.id, "advance"));
                }}
              >
                Continue saved attempt
              </button>
            )}
            {item.state === "draft" && (
              <div className="evaluation-callout">
                <div>
                  <h3>Ready to compare answers</h3>
                  <p>
                    {item.questions.length * 2} answers · up to {item.engine.maxToolRounds + 1} model rounds per answer · cost estimate
                    unavailable
                  </p>

                  {item.provider !== "mock" && (
                    <label className="evaluation-check">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I acknowledge the
                      model usage for this attempt.
                    </label>
                  )}
                </div>
                <button className="btn" disabled={action.isPending || (item.provider !== "mock" && !acknowledged)} onClick={() => run()}>
                  Run comparison
                </button>
              </div>
            )}
            {activeEvaluationStates.includes(item.state) && (
              <div className="evaluation-callout" role="status">
                <div>
                  <strong>
                    {label(item.state)} · {latestAttempt?.captures.length ?? 0} / {item.questions.length * 2} answers saved
                  </strong>
                  <p>
                    {config.data?.features?.worker
                      ? "The server continues this attempt when you leave."
                      : "Keep this tab open to advance answers. Reopening resumes saved progress."}
                  </p>
                </div>
                <button
                  className="btn ghost"
                  disabled={action.isPending || item.state === "cancelling"}
                  onClick={() => action.mutate(() => evaluationApi.action(pid, item.id, "cancel"))}
                >
                  {item.state === "cancelling" ? "Cancellation requested" : "Cancel attempt"}
                </button>
              </div>
            )}
            {selectedReport && (
              <div className="evaluation-callout">
                <div>
                  <strong>Saved report {selectedReport.number}</strong>
                  <p>
                    {fmtDate(selectedReport.createdAt)} · {selectedReport.reviewed} reviewed answers · {selectedReport.assessable}{" "}
                    assessable · {selectedReport.errors} errors
                  </p>
                </div>
                <div className="row-actions">
                  <button
                    className="btn ghost"
                    onClick={() => {
                      void evaluationApi.export(pid, item.id, selectedReport.id).catch(setDriverError);
                    }}
                  >
                    Export report &amp; evidence
                  </button>
                  <button className="btn ghost" onClick={() => navigate({ report: null, attempt: null })}>
                    Return to latest results
                  </button>
                </div>
              </div>
            )}
            {!selectedReport && retryAvailable && (
              <div className="evaluation-callout">
                <div>
                  <h3>Retry failed or unfinished answers</h3>
                  <p>
                    Successful answers and their reviews are kept. Only failed or unfinished answers make new requests. Earlier usage may
                    still be billed.
                  </p>
                  {item.provider !== "mock" && (
                    <label className="evaluation-check">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I acknowledge
                      model usage for the retry.
                    </label>
                  )}
                </div>
                <button
                  className="btn"
                  disabled={action.isPending || (item.provider !== "mock" && !acknowledged)}
                  onClick={() => run(true)}
                >
                  Retry failed or unfinished answers
                </button>
              </div>
            )}
            {!selectedReport && canReview && !retryAvailable && (tab !== "review" || remaining === 0) && (
              <div className="evaluation-callout" role="status">
                <div>
                  <strong>
                    {remaining ? `${remaining} answers ready for review` : reportUpToDate ? "Report saved" : "Review complete"}
                  </strong>
                  <p>
                    {remaining
                      ? "Check each answer and its source evidence."
                      : reportUpToDate
                        ? "Open the saved report or start a comparison with another version."
                        : "Save a report of these answers and judgments."}
                  </p>
                </div>
                {remaining ? (
                  <button className="btn" onClick={() => navigate({ tab: "review", capture: null, question: null })}>
                    Review remaining answers
                  </button>
                ) : reportUpToDate ? (
                  <button className="btn" onClick={() => navigate({ report: latestReport!.id, tab: "results", attempt: null })}>
                    Open saved report
                  </button>
                ) : (
                  <button className="btn" disabled={action.isPending} onClick={saveReport}>
                    Save report
                  </button>
                )}
              </div>
            )}
            {canReview && retryAvailable && !selectedReport && (
              <div className="row-actions">
                {remaining ? (
                  <button className="btn ghost" onClick={() => navigate({ tab: "review", capture: null, question: null })}>
                    Review {remaining} successful answers
                  </button>
                ) : (
                  !reportUpToDate && (
                    <button className="btn ghost" disabled={action.isPending} onClick={saveReport}>
                      Save report with errors
                    </button>
                  )
                )}
              </div>
            )}
            <section id={`evaluation-panel-${tab}`} role="tabpanel" aria-labelledby={`evaluation-tab-${tab}`}>
              {tab === "results" && (
                <>
                  {score && (
                    <div className="evaluation-overview">
                      {score.reviewed === 0 ? (
                        <strong>{score.errors === score.total ? "No successful answers to review" : "Awaiting review"}</strong>
                      ) : (
                        <>
                          <span>{score.outcomes.filter((o) => o.outcome === "improved").length} correctness improvements</span>
                          <span>{score.outcomes.filter((o) => o.outcome === "regressed").length} correctness regressions</span>
                          <span>{score.outcomes.filter((o) => o.supportOutcome === "regressed").length} source-support regressions</span>
                        </>
                      )}
                      <span>
                        {score.reviewed}/{score.total - score.errors} answers reviewed
                      </span>
                      <span>{score.errors} errors</span>
                      <span>Cost: {cost(score.costUsd)}</span>
                    </div>
                  )}
                  <label className="field evaluation-filter">
                    <span>Show questions</span>
                    <select value={filter} onChange={(e) => navigate({ filter: e.target.value, question: null })}>
                      <option value="all">All questions</option>
                      <option value="regressed">Regressions</option>
                      <option value="errors">Errors</option>
                      <option value="unreviewed">Unreviewed</option>
                    </select>
                  </label>
                  {!visibleQuestions.length && <p className="muted">No questions match this filter.</p>}
                  <div className="evaluation-question-list">
                    {visibleQuestions.map((q) => (
                      <button
                        key={q.id}
                        className="evaluation-question"
                        aria-pressed={question?.id === q.id}
                        onClick={() => navigate({ question: q.id })}
                      >
                        <span>{q.text}</span>
                        <span>
                          {score?.outcomes.find((o) => o.questionId === q.id)?.outcome === "unchanged"
                            ? "Reviewed quality unchanged"
                            : label(score?.outcomes.find((o) => o.questionId === q.id)?.outcome ?? "not captured")}
                          {score?.outcomes.find((o) => o.questionId === q.id)?.supportOutcome && (
                            <small>Source support: {label(score.outcomes.find((o) => o.questionId === q.id)!.supportOutcome!)}</small>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                  {question && (
                    <>
                      <div className="evaluation-heading">
                        <h3>{question.text}</h3>
                        {canReview && (
                          <button className="btn ghost" onClick={() => navigate({ tab: "review", question: question.id, capture: null })}>
                            Review these answers
                          </button>
                        )}
                      </div>
                      <div className="evaluation-answers">
                        {(["baseline", "candidate"] as const).map((arm) => {
                          const capture = attempt?.captures.find((c) => c.questionId === question.id && c.arm === arm);
                          return (
                            <article key={arm} className="evaluation-answer">
                              <p className="eyebrow">
                                {arm} · version {item[arm].number}
                              </p>
                              <p className="evaluation-expectation">
                                Expected:{" "}
                                {arm === "baseline" ? (question.baselineExpectation ?? question.expectation) : question.expectation}
                              </p>
                              {capture ? (
                                <CapturedAnswer
                                  pid={pid}
                                  item={item}
                                  capture={capture}
                                  review={reviewFor(item, capture, selectedReport?.judgmentIds)}
                                />
                              ) : (
                                <p className="muted">This answer has not been captured yet.</p>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
              {tab === "review" &&
                (canReview && attempt ? (
                  <ReviewWorkspace
                    key={`${item.id}:${attempt.id}`}
                    pid={pid}
                    item={item}
                    attempt={attempt}
                    questionId={params.get("question")}
                    captureId={params.get("capture")}
                    busy={action.isPending}
                    onSelect={(captureId) => navigate({ capture: captureId, question: null })}
                    onSave={async (body, nextId) => {
                      await action.mutateAsync(async () => {
                        const value = await evaluationApi.review(pid, item.id, body);
                        save(value);
                        setNotice("Review saved. Earlier reports keep their original judgments.");
                        navigate({ capture: nextId, question: null, tab: nextId ? "review" : "reports" });
                        return value;
                      });
                    }}
                  />
                ) : (
                  <EmptyState
                    title={selectedReport ? "This saved report is read-only" : "Capture answers before reviewing"}
                    action={
                      attempt ? (
                        <button
                          className="btn ghost"
                          onClick={() => navigate({ report: null, attempt: null, tab: selectedReport ? "review" : "reports" })}
                        >
                          {selectedReport ? "Review latest results" : "Open history"}
                        </button>
                      ) : undefined
                    }
                  >
                    Each review records correctness and source support separately.
                  </EmptyState>
                ))}
              {tab === "reports" && (
                <>
                  <h3>Saved reports</h3>
                  {!item.reports.length && <p className="muted">No saved reports yet. Review the captured answers, then save a report.</p>}
                  {[...item.reports].reverse().map((r) => (
                    <div key={r.id} className="evaluation-run">
                      <div className="evaluation-heading">
                        <div>
                          <strong>Report {r.number}</strong>
                          <p className="muted">
                            {fmtDate(r.createdAt)} · {r.assessable} assessable answers · {r.errors} errors
                          </p>
                        </div>
                        <div className="row-actions">
                          <button className="btn ghost" onClick={() => navigate({ report: r.id, tab: "results", attempt: null })}>
                            Open report
                          </button>
                          <button
                            className="btn ghost"
                            onClick={() => {
                              void evaluationApi.export(pid, item.id, r.id).catch((error: unknown) => setDriverError(error));
                            }}
                          >
                            Export evidence
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  <details className="evaluation-history">
                    <summary>
                      History · {item.attempts.length} {item.attempts.length === 1 ? "attempt" : "attempts"}
                    </summary>
                    {item.attempts.length === 0 && <p className="muted">No attempts yet. Run the comparison when your inputs are ready.</p>}
                    {[...item.attempts].reverse().map((a) => (
                      <article className="evaluation-run" key={a.id}>
                        <div className="evaluation-heading">
                          <div>
                            <h3>
                              Attempt {a.id.slice(-6)} · {label(a.state)}
                            </h3>
                            <p className="muted">
                              {fmtDate(a.createdAt)} · {a.captures.length}/{item.questions.length * 2} answers saved
                              {a.retryOf ? ` · retry of ${a.retryOf.slice(-6)}` : ""}
                            </p>
                          </div>
                          <button className="btn ghost" onClick={() => navigate({ tab: "results", attempt: a.id, report: null })}>
                            Inspect answers
                          </button>
                        </div>
                        {a.error && (
                          <p role="alert" className="evaluation-error">
                            {a.error}
                          </p>
                        )}
                        {a.inFlight && <p className="muted">Answer request in progress · last heartbeat {fmtDate(a.updatedAt)}</p>}
                      </article>
                    ))}
                    {latestAttempt && ["awaiting_review", "completed"].includes(latestAttempt.state) && (
                      <div className="evaluation-callout">
                        <div>
                          <h3>Capture another attempt</h3>
                          <p>
                            Recapture all {item.questions.length * 2} answers with the same saved inputs and model. Earlier captures,
                            reviews and reports stay available.
                          </p>
                          {item.provider !== "mock" && (
                            <label className="evaluation-check">
                              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I
                              acknowledge model usage for the new attempt.
                            </label>
                          )}
                        </div>
                        <button
                          className="btn ghost"
                          disabled={action.isPending || (item.provider !== "mock" && !acknowledged)}
                          onClick={() => run()}
                        >
                          Run another attempt
                        </button>
                      </div>
                    )}
                  </details>
                </>
              )}
            </section>
            <details className="evaluation-method">
              <summary>How this comparison works</summary>
              <p>
                Saved graph facts only; document search and conversation history are excluded. Expectations guide review and are not sent to
                the answer model. The saved source passage records the reviewer's evidence; locating a quote does not itself establish
                support.
              </p>
              <p>
                Engine: {item.engine.id} · {item.provider}/{item.model} · {item.engine.maxToolRounds} tool rounds maximum. Answer
                correctness and source support are human judgments on this question set. This comparison does not establish accuracy outside
                these examples.
              </p>
              <p>
                Baseline: {item.baseline.reviewPolicy} · candidate: {item.candidate.reviewPolicy}. Saved source memberships may differ
                between graph versions; this checks the graph update as a whole.
              </p>
              <code>
                Baseline {item.baseline.snapshotHash}
                <br />
                Candidate {item.candidate.snapshotHash}
              </code>
              <p className="field-hint">
                Report costs use recorded tokens and configured prices where available. Missing or interrupted usage is not zero.
              </p>
            </details>
          </>
        )}
        {!project?.settings.corpus && (
          <p className="field-hint">For graph-specific evaluation, open a knowledge graph from the project navigation.</p>
        )}
      </div>
    </div>
  );
}
