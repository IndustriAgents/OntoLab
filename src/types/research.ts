import type { DocumentChunk, DocumentText, JobCheckpoint, ProjectDocument, RevisionContent, RunView } from "./project";

export type ChunkMethod = "paragraph" | "section" | "fixed";
export interface EmbeddingProfile {
  id: string;
  label: string;
  backend: "local" | "provider" | "hash";
  provider?: string;
  model: string;
  inputLimit: number;
  tokenizer: string;
}
export interface GenerationTokenBudget {
  provider: string;
  model: string;
  maxTokens: number;
  contextTokens: number;
  outputTokens: number;
  promptReserveTokens: number;
}
export interface TokenChunkSettings {
  embedding: { profile: string; maxTokens: number };
  generation: GenerationTokenBudget;
}
export interface TokenMeasurement {
  count: number;
  tokenizer: string;
  exact: boolean;
  note?: string;
}
export interface ChunkSettings {
  unit?: "characters" | "tokens";
  tokens?: TokenChunkSettings;
  method: ChunkMethod;
  maxChars: number;
  overlap: number;
}

export interface PreprocessingRecord {
  version: "chunking-v1" | "chunking-tokens-v1";
  settings: ChunkSettings;
  textHash: string;
  createdAt: string;
  durationMs: number;
}

export interface ChunkExperiment {
  /** Existing saved configuration used to supply this preview. */
  reusedDocumentId?: string;
  settings: ChunkSettings;
  textHash: string;
  chunks: DocumentChunk[];
  metrics: ChunkMetrics;
  tokenization?: {
    embedding: TokenMeasurement;
    generation: TokenMeasurement;
    embeddingPassages: number;
    fullCoverage: boolean;
  };
}

export interface ChunkMetrics {
  count: number;
  minChars: number;
  maxChars: number;
  meanChars: number;
  totalChars: number;
  overlapChars: number;
  overlapPercent: number;
}

export interface TechnicalResult {
  title: string;
  method: string;
  parameters: Record<string, unknown>;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows?: number;
  note?: string;
}

export interface StageTrace {
  technical?: TechnicalResult[];
  durationMs: number;
  /** Recorded execution inputs/diagnostics, not a reconstruction of model reasoning. */
  input?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

export interface ResearchInputs {
  documentTexts?: Record<string, Omit<DocumentText, "chunks">>;
  version: 1;
  recordedAt: string;
  documents: Omit<ProjectDocument, "storagePath" | "ownerId">[];
  chunks: DocumentChunk[];
  requirements: unknown;
  baseRevision?: { id: string; contentHash: string; content: RevisionContent } | null;
}

export interface RunResearch {
  version: 1;
  run: RunView;
  /** Null means this older run predates input snapshots. Never substitute live documents. */
  inputs: ResearchInputs | null;
  checkpoints: JobCheckpoint[];
}
