import type { EvidenceRef } from "./abox";

/** Immutable model-visible excerpt, scoped to one answer. Location is not entailment. */
export interface AnswerPassage {
  ref: string;
  key: string;
  title: string;
  where: string;
  evidence: EvidenceRef;
}
export interface SourceCoverage {
  revisionId: string;
  contentHash: string;
  manifestHash: string;
  label: string;
  profile: string;
  available: number;
  total: number;
  unavailable: string[];
}
export interface EvidenceSearchResult {
  coverage: SourceCoverage;
  passages: AnswerPassage[];
}
