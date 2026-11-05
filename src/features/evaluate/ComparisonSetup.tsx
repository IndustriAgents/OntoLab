import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useModelChoice } from "../../app/providers";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { InlineError } from "../../components/ui/ui";
import { evaluationApi, evaluationKeys } from "../../lib/evaluationApi";
import type { ProviderId } from "../../lib/api";
import type { Evaluation, EvaluationQuestion, EvaluationSetup } from "../../types/evaluation";
import { questionRow } from "./evaluationUi";

export function ComparisonSetup({
  pid,
  setup,
  initialBaseline,
  initialCandidate,
  initialQuestion,
  onClose,
  onCreated,
  seed,
  mode = "new",
}: {
  pid: string;
  setup: EvaluationSetup;
  initialBaseline: string | null;
  initialCandidate: string | null;
  initialQuestion: string | null;
  seed?: Evaluation;
  mode?: "new" | "edit" | "copy" | "next";
  onClose: () => void;
  onCreated: (value: Evaluation) => void;
}) {
  const choice = useModelChoice();
  const qc = useQueryClient();
  const [initialVersion] = useState(seed?.version);
  const [selection, setSelection] = useState(seed ? { provider: seed.provider as ProviderId, model: seed.model } : null);
  const provider = selection?.provider ?? choice.provider;
  const model = selection?.model ?? choice.model;
  const selectedProvider = choice.providers.find((p) => p.id === provider);
  const [title, setTitle] = useState(
    seed ? `${seed.title}${mode === "next" ? " · next version" : mode === "copy" ? " · copy" : ""}` : "Graph answer comparison",
  );
  const [baseline, setBaseline] = useState(
    seed
      ? mode === "next"
        ? seed.candidate.revisionId
        : seed.baseline.revisionId
      : (setup.revisions.find((r) => r.id === initialBaseline)?.id ?? setup.revisions[1]?.id ?? ""),
  );
  const [candidate, setCandidate] = useState(
    seed
      ? mode === "next"
        ? (setup.revisions.find((r) => r.number > seed.candidate.number)?.id ?? "")
        : seed.candidate.revisionId
      : (setup.revisions.find((r) => r.id === initialCandidate)?.id ?? setup.revisions[0]?.id ?? ""),
  );
  const [questions, setQuestions] = useState<EvaluationQuestion[]>(() => {
    const initial = seed
      ? seed.questions.map((q) => (mode === "next" ? { ...q, baselineExpectation: q.expectation } : q))
      : initialQuestion
        ? [{ id: "ask", text: initialQuestion, expectation: "", origin: "ask" as const }]
        : setup.questions.length
          ? setup.questions.slice(0, 5)
          : [{ id: "manual", text: "", expectation: "", origin: "manual" as const }];
    return initial.map(questionRow);
  });
  const create = useMutation({
    mutationFn: () => {
      const body = {
        title,
        baselineRevisionId: baseline,
        candidateRevisionId: candidate,
        questions,
        provider,
        model,
        version: initialVersion,
      };
      return mode === "edit" && seed ? evaluationApi.update(pid, seed.id, body) : evaluationApi.create(pid, body);
    },
    onSuccess: onCreated,
    onError: () => {
      if (seed) void qc.invalidateQueries({ queryKey: evaluationKeys.detail(pid, seed.id) });
    },
  });
  const update = (id: string, patch: Partial<EvaluationQuestion>) =>
    setQuestions((old) => old.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  return (
    <form
      className="evaluation-setup"
      aria-label={mode === "edit" ? "Edit graph comparison" : "New graph comparison"}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="evaluation-heading">
        <h2>
          {mode === "edit" ? "Edit comparison setup" : mode === "next" ? "Compare with next version" : "Compare saved graph versions"}
        </h2>
        <button className="btn ghost" type="button" onClick={onClose}>
          Close setup
        </button>
      </div>
      {mode === "next" && (
        <p className="field-hint">
          Questions, expected answers and model are copied. The previous candidate is now the baseline. Update expectations if the correct
          answer changed.
        </p>
      )}
      <label className="field">
        <span>Comparison name</span>
        <input required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="evaluation-answers">
        <label className="field">
          <span>Baseline version</span>
          <select required value={baseline} onChange={(e) => setBaseline(e.target.value)}>
            <option value="">Choose baseline version</option>
            {setup.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                Version {r.number} · {r.summary}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Candidate version</span>
          <select required value={candidate} onChange={(e) => setCandidate(e.target.value)}>
            <option value="">Choose candidate version</option>
            {setup.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                Version {r.number} · {r.summary}
              </option>
            ))}
          </select>
        </label>
      </div>
      {mode === "next" && !setup.revisions.some((r) => r.number > (seed?.candidate.number ?? -1)) && (
        <p>
          No newer saved version yet. <Link to={`/p/${pid}/graph?tab=history`}>Open graph versions</Link> to save an update, or choose
          another comparison pair.
        </p>
      )}
      <ProviderModelSelect
        providers={choice.providers}
        provider={provider}
        model={model}
        models={selectedProvider?.models ?? []}
        onProvider={(id) => setSelection({ provider: id, model: choice.providers.find((p) => p.id === id)?.models[0] ?? "" })}
        onModel={(value) => setSelection({ provider, model: value })}
        structuredOnly
      />
      {choice.error && <p role="alert">{choice.error}</p>}
      {seed && choice.status === "ready" && (!selectedProvider?.enabled || !selectedProvider.models.includes(model)) && (
        <p role="alert">The saved model is unavailable. Choose a model to continue.</p>
      )}
      <div className="evaluation-heading">
        <div>
          <h3>Questions and expected answers</h3>
          <p className="muted">Describe what a correct answer must include. These expectations are only used in review.</p>
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={questions.length >= setup.maxQuestions}
          onClick={() => setQuestions((old) => [...old, { id: crypto.randomUUID(), text: "", expectation: "", origin: "manual" }])}
        >
          Add question
        </button>
      </div>
      {setup.questions.some((q) => !questions.some((selected) => selected.text === q.text)) && (
        <label className="field">
          <span>Add an approved competency question</span>
          <select
            value=""
            disabled={questions.length >= setup.maxQuestions}
            onChange={(e) => {
              const selected = setup.questions.find((q) => q.id === e.target.value);
              if (selected) setQuestions((old) => [...old, questionRow(selected)]);
            }}
          >
            <option value="">Choose a question</option>
            {setup.questions
              .filter((q) => !questions.some((selected) => selected.text === q.text))
              .map((q) => (
                <option key={q.id} value={q.id}>
                  {q.text}
                </option>
              ))}
          </select>
        </label>
      )}
      {questions.map((q, i) => (
        <article className="evaluation-question-definition" key={q.id}>
          <div className="evaluation-heading">
            <strong>Question {i + 1}</strong>
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Remove question ${i + 1}`}
              disabled={questions.length === 1}
              onClick={() => setQuestions((old) => old.filter((item) => item.id !== q.id))}
            >
              Remove
            </button>
          </div>
          <label className="field">
            <span>Question</span>
            <textarea required maxLength={4000} rows={2} value={q.text} onChange={(e) => update(q.id, { text: e.target.value })} />
          </label>
          <label className="field">
            <span>Expected answer or required facts</span>
            <textarea
              required
              minLength={5}
              maxLength={6000}
              rows={3}
              value={q.expectation}
              onChange={(e) => update(q.id, { expectation: e.target.value })}
              placeholder="For example: identify the treatment, test conditions and supporting study."
            />
          </label>
          <details>
            <summary>The correct answer changed between versions</summary>
            <label className="field">
              <span>Baseline expectation, if different</span>
              <textarea
                rows={2}
                maxLength={6000}
                value={q.baselineExpectation ?? ""}
                onChange={(e) => update(q.id, { baselineExpectation: e.target.value })}
              />
            </label>
            <p className="field-hint">
              Different expectations are reported as changed input, not automatically as an improvement or regression.
            </p>
          </details>
        </article>
      ))}
      <p className="field-hint">
        {questions.length * 2} answers. Saving setup makes no model calls. Setup stays editable until the first run.
      </p>
      <InlineError error={create.error} />
      <button
        className="btn"
        disabled={
          create.isPending ||
          !baseline ||
          !candidate ||
          baseline === candidate ||
          !selectedProvider?.enabled ||
          !selectedProvider.models.includes(model)
        }
      >
        {create.isPending ? "Saving comparison…" : mode === "edit" ? "Save setup" : "Create comparison"}
      </button>
    </form>
  );
}
