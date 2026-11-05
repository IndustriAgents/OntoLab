import type { Evaluation, EvaluationSummary } from "../../src/types/evaluation.ts";
import { ConflictError } from "./types.ts";

export function evaluationSummary(value: Evaluation): EvaluationSummary {
  const { id, projectId, title, createdAt, updatedAt, state, provider, model, recordedCostUsd, attempts, questions, reports } = value;
  return {
    id,
    projectId,
    title,
    createdAt,
    updatedAt,
    state,
    provider,
    model,
    recordedCostUsd,
    baseline: { revisionId: value.baseline.revisionId, number: value.baseline.number },
    candidate: { revisionId: value.candidate.revisionId, number: value.candidate.number },
    questionCount: questions.length,
    completedAnswers: attempts.at(-1)?.captures.length ?? 0,
    totalAnswers: questions.length * 2,
    reportCount: reports.length,
  };
}

export function assertEvaluationVersion(value: Evaluation, expected: number | null) {
  if (value.version !== (expected ?? 0) + 1) throw new ConflictError("Invalid evaluation version.");
}
