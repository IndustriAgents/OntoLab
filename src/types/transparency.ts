import type { AlignmentMapping } from "./project";
import type { OntoModule } from "./validation";

export interface ShaclExecution {
  status: "completed" | "empty-data" | "failed";
  engine: string;
  durationMs: number;
  conforms: boolean | null;
  shapeQuads: number;
  dataQuads: number;
  inferredTypeQuads: number;
  shapesTurtle: string;
  dataTurtle: string;
  error?: string;
  results: {
    focusNode: string;
    path?: string;
    value?: string;
    sourceShape: string;
    constraint: string;
    severity: string;
    messages: string[];
  }[];
}

export interface AlignmentDiagnostics {
  sourceTerms: number;
  processedSourceTerms: number;
  targetTerms: number;
  prefilteredPairs: number;
  retrievedPairs: number;
  verifiedPairs: number;
  returnedMappings: number;
  /** Explicit coverage, including terms outside the configured limit. Absent on legacy records. */
  coverage?: { source: string; state: "not_processed" | "no_candidate" | "model_unrelated" | "proposed"; candidates: number }[];
  embedder: string | null;
  matchers: { lexical: boolean; semantic: boolean; structural: boolean };
  parameters: {
    maxSource: number | null;
    prefilter: number;
    candidate: number;
    anchor: number;
    structuralTiers: number;
    topPerSource: number;
    verificationBatch: number;
  };
}

export interface AlignmentRecord {
  id: string;
  createdAt: string;
  durationMs: number;
  inputHash: string;
  sourceModules: string[];
  targetModules: string[];
  modules: OntoModule[];
  provider: string | null;
  model: string | null;
  diagnostics: AlignmentDiagnostics;
  candidates: AlignmentMapping[];
  usage: { inputTokens: number; outputTokens: number };
  decisions: { at: string; requested: string[]; accepted: string[]; conflicts: AlignmentMapping[]; forced: boolean; turtle: string }[];
}
