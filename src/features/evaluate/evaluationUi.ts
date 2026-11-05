import type { Evaluation, EvaluationCapture, EvaluationQuestion } from "../../types/evaluation";
export const label = (value: string) => value.replaceAll("_", " ");
export const gradeLabel = (value: string) =>
  ({ correct: "Correct", partial: "Partially correct", incorrect: "Incorrect", unassessable: "Not assessable" })[value] ?? "Unreviewed";
export const cost = (value: number | null) => (value == null ? "Unavailable" : `Estimated $${value.toFixed(4)}`);
export const reviewFor = (item: Evaluation, capture: EvaluationCapture, ids?: string[]) =>
  item.judgments.filter((j) => j.captureId === capture.id && (!ids || ids.includes(j.id))).at(-1);
export const questionRow = (q: EvaluationQuestion): EvaluationQuestion => ({
  ...q,
  id: crypto.randomUUID(),
  ...(q.origin === "competency" ? { competencyQuestionId: q.competencyQuestionId ?? q.id } : {}),
});
