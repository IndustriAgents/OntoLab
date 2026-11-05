import type { AgentTrace } from "./graphChat";
import type { EvidenceRef, ProjectSettings } from "./project";

export type EvaluationArm = "baseline" | "candidate";
export type EvaluationState =
  "draft" | "queued" | "running" | "cancelling" | "awaiting_review" | "completed" | "failed" | "cancelled" | "interrupted";
export type AnswerGrade = "correct" | "partial" | "incorrect" | "unassessable";

export interface EvaluationQuestion {
  id: string;
  text: string;
  expectation: string;
  /** Set only when a source update changes the expected answer. */
  baselineExpectation?: string;
  origin: "competency" | "manual" | "ask";
  competencyQuestionId?: string;
}

export interface EvaluationScope {
  revisionId: string;
  number: number;
  summary: string;
  contentHash: string;
  snapshotHash: string;
  reviewPolicy: NonNullable<ProjectSettings["reviewPolicy"]>;
  sources: { documentId: string; runId: string; checksum: string }[];
}

export interface EvaluationSource {
  id: string;
  name: string;
  evidence: EvidenceRef;
  available: boolean;
  textHash?: string;
  issue?: string;
}

export interface EvaluationCapture {
  id: string;
  questionId: string;
  arm: EvaluationArm;
  createdAt: string;
  answer: string;
  agent?: AgentTrace;
  sources: EvaluationSource[];
  sourcesTruncated: boolean;
  costUsd: number | null;
  error?: string;
}

export interface EvaluationAttempt {
  id: string;
  retryOf?: string;
  state: Exclude<EvaluationState, "draft">;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  captures: EvaluationCapture[];
  lease: { holder: string; expiresAt: string } | null;
  inFlight: { questionId: string; arm: EvaluationArm; startedAt: string } | null;
  error?: string;
  usageUncertain?: boolean;
  /** Known cost of failed captures excluded from a linked retry. */
  priorCostUsd?: number;
}

export interface EvaluationJudgment {
  id: string;
  captureId: string;
  previousId: string | null;
  grade: AnswerGrade;
  support: "supported" | "unsupported" | "unavailable";
  reason: string;
  sourceId: string | null;
  quote: string;
  start?: number;
  end?: number;
  origin: "human";
  reviewerId: string;
  createdAt: string;
}

export interface EvaluationReport {
  id: string;
  number: number;
  attemptId: string;
  createdAt: string;
  createdBy: string;
  judgmentIds: string[];
  reviewed: number;
  assessable: number;
  total: number;
  errors: number;
  unavailableSources: number;
  outcomes: {
    questionId: string;
    supportOutcome?: "improved" | "regressed" | "unchanged" | "unavailable" | "unreviewed" | "error";
    outcome: "improved" | "regressed" | "unchanged" | "changed_expectation" | "unassessable" | "unreviewed" | "error";
  }[];
  arms: Record<
    EvaluationArm,
    { correct: number; partial: number; incorrect: number; unassessable: number; unreviewed: number; errors: number }
  >;
  costUsd: number | null;
  checksum: string;
}

/** One owner-scoped aggregate, updated with compare-and-swap. Inputs, captures,
 * judgments and reports are append-only; later scoring never rewrites history. */
export interface Evaluation {
  id: string;
  projectId: string;
  ownerId: string;
  version: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: EvaluationState;
  baseline: EvaluationScope;
  candidate: EvaluationScope;
  questions: EvaluationQuestion[];
  provider: string;
  model: string;
  engine: { id: "graph-chat-v1"; fingerprint: string; maxToolRounds: number; documentSearch: false };
  inputHash: string;
  recordedCostUsd: number;
  attempts: EvaluationAttempt[];
  judgments: EvaluationJudgment[];
  reports: EvaluationReport[];
}

export type EvaluationSummary = Pick<
  Evaluation,
  "id" | "projectId" | "title" | "createdAt" | "updatedAt" | "state" | "provider" | "model" | "recordedCostUsd"
> & {
  baseline: Pick<EvaluationScope, "revisionId" | "number">;
  candidate: Pick<EvaluationScope, "revisionId" | "number">;
  questionCount: number;
  completedAnswers: number;
  totalAnswers: number;
  reportCount: number;
};

export interface EvaluationSetup {
  revisions: { id: string; number: number; summary: string; contentHash: string }[];
  questions: EvaluationQuestion[];
  eligible: boolean;
  reason?: string;
  maxQuestions: number;
}

export const activeEvaluationStates: EvaluationState[] = ["queued", "running", "cancelling"];
