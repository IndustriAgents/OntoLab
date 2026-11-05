import type { Evaluation, EvaluationAttempt, EvaluationReport } from "../types/evaluation";

export function scoreEvaluation(
  item: Evaluation,
  attempt: EvaluationAttempt,
): Omit<EvaluationReport, "id" | "number" | "createdAt" | "createdBy" | "checksum"> {
  const reviews = new Map(item.judgments.map((j) => [j.captureId, j]));
  const empty = () => ({ correct: 0, partial: 0, incorrect: 0, unassessable: 0, unreviewed: 0, errors: 0 });
  const arms = { baseline: empty(), candidate: empty() };
  const judgmentIds: string[] = [];
  for (const capture of attempt.captures) {
    if (capture.error) {
      arms[capture.arm].errors++;
      continue;
    }
    const review = reviews.get(capture.id);
    if (review) {
      arms[capture.arm][review.grade]++;
      judgmentIds.push(review.id);
    } else arms[capture.arm].unreviewed++;
  }
  const values = { correct: 2, partial: 1, incorrect: 0, unassessable: -1 };
  const outcomes: EvaluationReport["outcomes"] = item.questions.map((q) => {
    const captures = (["baseline", "candidate"] as const).map((arm) =>
      attempt.captures.find((c) => c.questionId === q.id && c.arm === arm),
    );
    const grades = captures.map((c) => (c ? reviews.get(c.id)?.grade : undefined));
    const outcome = captures.some((c) => c?.error)
      ? "error"
      : captures.some((c) => !c) || grades.some((g) => !g)
        ? "unreviewed"
        : q.baselineExpectation && q.baselineExpectation !== q.expectation
          ? "changed_expectation"
          : grades.includes("unassessable")
            ? "unassessable"
            : values[grades[1]!] > values[grades[0]!]
              ? "improved"
              : values[grades[1]!] < values[grades[0]!]
                ? "regressed"
                : "unchanged";
    const support = captures.map((c) => (c ? reviews.get(c.id)?.support : undefined));
    const supportOutcome = captures.some((c) => c?.error)
      ? "error"
      : support.some((s) => !s)
        ? "unreviewed"
        : support.includes("unavailable")
          ? "unavailable"
          : support[0] === support[1]
            ? "unchanged"
            : support[1] === "supported"
              ? "improved"
              : "regressed";
    return { questionId: q.id, outcome, supportOutcome };
  });
  return {
    attemptId: attempt.id,
    judgmentIds,
    reviewed: judgmentIds.length,
    assessable: judgmentIds.filter((id) => item.judgments.find((j) => j.id === id)?.grade !== "unassessable").length,
    total: item.questions.length * 2,
    errors: attempt.captures.filter((c) => c.error).length,
    unavailableSources: attempt.captures.filter((c) => !c.error && !c.sources.some((s) => s.available)).length,
    outcomes,
    arms,
    costUsd:
      !attempt.usageUncertain && attempt.captures.length === item.questions.length * 2 && attempt.captures.every((c) => c.costUsd != null)
        ? attempt.captures.reduce((sum, c) => sum + c.costUsd!, 0)
        : null,
  };
}
