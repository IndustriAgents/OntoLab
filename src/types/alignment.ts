import type { AlignmentMapping, RevisionContent } from "./project";

export interface AlignmentEstimate {
  sourceTerms: number;
  processedSourceTerms: number;
  targetTerms: number;
  maxCandidatePairs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Generation only, excluding embedding APIs and retries. Unknown prices stay null. */
  usd: number | null;
  priced: boolean;
  embeddingCostExcluded: boolean;
}

export interface AlignmentRunContext {
  setup: AlignmentSetup;
  content: RevisionContent;
  inputHash: string;
  parentRevisionId: string | null;
  embeddings: "off" | "local" | "provider" | "hash";
  estimate: AlignmentEstimate;
}

/** Saved with the revision, independently of whether matching has run. */
export interface AlignmentSetup {
  sourceModules: string[];
  targetModules: string[];
  matchers: { lexical: boolean; semantic: boolean; structural: boolean };
  verify: boolean;
  provider?: string;
  model?: string;
  /** null explicitly requests every source term; older comparisons used 150. */
  maxSource: number | null;
}

export type AlignmentAction = "accept" | "reject" | "defer" | "reopen" | "edit" | "add" | "undo";

export interface AlignmentReviewInput {
  action: AlignmentAction;
  ids?: string[];
  source?: string;
  target?: string;
  relation?: AlignmentMapping["relation"];
  note?: string;
  expectedHash?: string;
}

export interface AlignmentDecision {
  id: string;
  at: string;
  action: AlignmentAction | "inputs_changed";
  mappingId: string;
  before: AlignmentMapping | null;
  after: AlignmentMapping | null;
  note?: string;
}
