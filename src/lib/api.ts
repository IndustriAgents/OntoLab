import type { TBoxModel } from "../types/tbox";
import type { ABoxResult, ExtractDoc, ClarifyQuestion, Clarification } from "../types/abox";

import { rawRequest, ApiError, CancelledError, NetworkError } from "./http";

export { CancelledError, NetworkError };

export type ProviderId =
  | "openai"
  | "gemini"
  | "claude"
  | "deepseek"
  | "ollama"
  | "mock"
  | "claude-cli"
  | "codex-cli"
  | "agy-cli"
  | "openai-compatible"
  | `openai-compatible:${string}`;

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
  models: string[];
  reasoningEfforts?: Record<string, string[]>;
  contextWindows?: Record<string, number>;
  /** models that cannot be used for structured extraction */
  chatOnlyModels?: string[];
  /** whether the provider can read PDFs as images */
  supportsVision?: boolean;
  kind?: "cli";
  disabledReason?: string;
  authStatus?: "unknown";
  outputLimitControl?: "provider-managed";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

interface RequestOptions {
  signal?: AbortSignal;
}

async function post<T>(path: string, body: unknown, fallback: string, opts: RequestOptions = {}): Promise<T> {
  try {
    const res = await rawRequest("POST", `api/${path}`, { body, signal: opts.signal });
    return (await res.json()) as T;
  } catch (e) {
    // Keep the old contract: server-side failures surface as plain Errors with the server's message.
    if (e instanceof ApiError) throw new Error(e.message || `${fallback} (${e.status})`);
    throw e;
  }
}

export async function fetchProviders(signal?: AbortSignal): Promise<ProviderInfo[]> {
  try {
    const res = await rawRequest("GET", "api/providers", { signal });
    const data = (await res.json()) as { providers: ProviderInfo[] };
    return data.providers;
  } catch (e) {
    if (e instanceof ApiError) throw new Error(`Could not load providers (${e.status})`);
    throw e;
  }
}

/* ───────────────────────── extraction ───────────────────────── */

export interface ExtractResult {
  abox: ABoxResult;
  usage: Usage;
  /** what the server's conformance pass corrected or dropped */
  notes: string[];
}

export function extract(
  body: { tbox: TBoxModel; documents: ExtractDoc[]; provider?: ProviderId; model?: string },
  opts?: RequestOptions,
): Promise<ExtractResult> {
  return post<ExtractResult>("extract", body, "Extraction failed", opts);
}

export interface RefineResult extends ExtractResult {
  questions: ClarifyQuestion[];
}

export function refine(
  body: {
    tbox: TBoxModel;
    documents: ExtractDoc[];
    clarifications: Clarification[];
    /** the previous round's A-Box, so individual ids stay stable */
    previousAbox?: ABoxResult;
    provider?: ProviderId;
    model?: string;
  },
  opts?: RequestOptions,
): Promise<RefineResult> {
  return post<RefineResult>("refine", body, "Refinement failed", opts);
}

export interface EditResult {
  abox: ABoxResult;
  summary: string;
  usage: Usage;
  notes: string[];
}

export function editAbox(
  body: {
    tbox: TBoxModel;
    currentAbox: ABoxResult;
    instruction: string;
    history?: ChatMessage[];
    provider?: ProviderId;
    model?: string;
  },
  opts?: RequestOptions,
): Promise<EditResult> {
  return post<EditResult>("edit", body, "Edit failed", opts);
}

/* ───────────────────────── T-Box ───────────────────────── */

export interface GenerateTboxResult {
  turtle: string;
  usage: Usage;
}

export function generateTbox(
  body: {
    documents: ExtractDoc[];
    provider?: ProviderId;
    model?: string;
    baseIri?: string;
    guidance?: string;
    currentTurtle?: string;
    instruction?: string;
    /** read-only existing ontology context — the model designs a NEW module that extends it */
    baseTurtle?: string;
    /** what the ontology is for (Build with AI page) */
    purpose?: string;
    /** what is in / out of scope (Build with AI page) */
    scope?: string;
    /** questions the finished ontology must be able to answer */
    competencyQuestions?: string[];
    /** standard/reference ontologies (Turtle) — reusable vocabulary to align with */
    standardsOntologies?: { name: string; turtle: string }[];
    /** standards/spec documents — reference reading material, not extraction sources */
    standardsDocuments?: ExtractDoc[];
  },
  opts?: RequestOptions,
): Promise<GenerateTboxResult> {
  return post<GenerateTboxResult>("generate-tbox", body, "T-Box generation failed", opts);
}

export interface SuggestedModule {
  name: string;
  isNew: boolean;
  turtle: string;
  additionsTurtle: string;
  addedClasses: string[];
  addedObjectProps: string[];
  addedDataProps: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
}

export interface SuggestTboxResult {
  summary: string;
  modules: SuggestedModule[];
  updates: string[];
  usage: Usage;
}

export function suggestTbox(
  body: {
    tbox: TBoxModel;
    documents: ExtractDoc[];
    modules?: { name: string; turtle: string }[];
    provider?: ProviderId;
    model?: string;
  },
  opts?: RequestOptions,
): Promise<SuggestTboxResult> {
  return post<SuggestTboxResult>("suggest-tbox", body, "Coverage check failed", opts);
}

/* ───────────────────────── competency questions ───────────────────────── */

export interface CQResult {
  sparql: string;
  explanation: string;
  columns: string[];
  rows: Record<string, string>[];
  /** true when the row cap was hit */
  truncated?: boolean;
  error?: string;
  usage: Usage;
}

export function askCompetencyQuestion(
  body: {
    tbox: TBoxModel;
    abox: ABoxResult;
    question: string;
    baseIri?: string;
    provider?: ProviderId;
    model?: string;
  },
  opts?: RequestOptions,
): Promise<CQResult> {
  return post<CQResult>("cq", body, "Competency question failed", opts);
}

/* ───────────────────────── misc ───────────────────────── */

/** Server-side document parsing (DOCX → plain text). */
export function parseDoc(body: { name: string; base64: string }, opts?: RequestOptions): Promise<{ text: string }> {
  return post<{ text: string }>("parse-doc", body, `Could not parse ${body.name}`, opts);
}

export async function chat(
  body: { provider: ProviderId; model: string; messages: ChatMessage[]; graphContext: string },
  opts?: RequestOptions,
): Promise<string> {
  const data = await post<{ content: string }>("chat", body, "Request failed", opts);
  return data.content;
}
