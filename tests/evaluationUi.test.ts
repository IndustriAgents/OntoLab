import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { CapturedAnswer } from "../src/features/evaluate/AnswerEvidence";
import { questionRow } from "../src/features/evaluate/evaluationUi";
import { scoreEvaluation } from "../src/lib/evaluation";
import type { Evaluation, EvaluationAttempt, EvaluationCapture, EvaluationJudgment } from "../src/types/evaluation";

const capture = (id: string, arm: "baseline" | "candidate"): EvaluationCapture => ({
  id,
  arm,
  questionId: "q",
  createdAt: "2026-11-03",
  answer: "A **sensor** was found.",
  costUsd: 0,
  sourcesTruncated: false,
  sources: [
    { id: "first", name: "first.txt", available: true, evidence: { quote: "Original extraction.", status: "verified" } },
    { id: "reviewed", name: "reviewed.txt", available: true, evidence: { quote: "Other extraction.", status: "verified" } },
  ],
});
const judgment = (id: string, captureId: string, support: "supported" | "unsupported"): EvaluationJudgment => ({
  id,
  captureId,
  previousId: null,
  grade: "correct",
  support,
  reason: "Source reviewed.",
  sourceId: "reviewed",
  quote: "Exact reviewed passage.",
  start: 7,
  end: 30,
  origin: "human",
  reviewerId: "owner",
  createdAt: "2026-11-03",
});
const attempt: EvaluationAttempt = {
  id: "attempt",
  state: "completed",
  createdAt: "2026-11-03",
  updatedAt: "2026-11-03",
  captures: [capture("a", "baseline"), capture("b", "candidate")],
  lease: null,
  inFlight: null,
};
const item = {
  id: "e",
  projectId: "p",
  ownerId: "owner",
  baseline: { revisionId: "v1" },
  candidate: { revisionId: "v2" },
  questions: [{ id: "q", text: "Which sensors?", expectation: "Name sensors", origin: "manual" }],
  attempts: [attempt],
  judgments: [judgment("j1", "a", "supported"), judgment("j2", "b", "unsupported")],
} as Evaluation;

describe("evaluation review presentation", () => {
  it("opens the report judgment's source and highlights its selected passage instead of the extraction reference", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: 0 } } });
    client.setQueryData(["evaluation-source", "p", "e", "reviewed"], {
      name: "reviewed.txt",
      text: "Before Exact reviewed passage. After Other extraction.",
      pages: [],
    });
    const html = renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client },
        h(
          StaticRouter,
          { location: "/p/p/evaluate" },
          h(CapturedAnswer, { pid: "p", item, capture: attempt.captures[0], review: item.judgments[0] }),
        ),
      ),
    );
    expect(html).toContain('<option value="reviewed" selected=""');
    expect(html).toContain('<mark data-text-start="7">Exact reviewed passage.</mark>');
    expect(html).toContain("<strong>sensor</strong>");
    expect(html).toContain("Reviewed passage");
    client.clear();
  });
  it("keeps source-support regression visible when correctness remains unchanged", () => {
    expect(scoreEvaluation(item, attempt).outcomes[0]).toMatchObject({ outcome: "unchanged", supportOutcome: "regressed" });
    expect(scoreEvaluation({ ...item, judgments: [] }, attempt).outcomes[0]).toMatchObject({
      outcome: "unreviewed",
      supportOutcome: "unreviewed",
    });
  });
  it("keeps an edited competency question independent when its original is added again", () => {
    const source = { id: "cq", text: "Which sensors?", expectation: "Name sensors", origin: "competency" as const };
    const edited = { ...questionRow(source), text: "Which calibrated sensors?" };
    const added = questionRow(source);
    const rows = [edited, added].map((q) => (q.id === edited.id ? { ...q, text: "Which reviewed sensors?" } : q));
    expect(rows.map((q) => q.text)).toEqual(["Which reviewed sensors?", "Which sensors?"]);
    expect(rows.map((q) => q.competencyQuestionId)).toEqual(["cq", "cq"]);
    expect(rows.filter((q) => q.id !== edited.id)).toEqual([added]);
  });
});
