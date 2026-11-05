import type { AnswerPassage, SourceCoverage } from "./sourceEvidence";
import type { GraphReadContext } from "./connections";
// Graph chat: the Ask-mode agent (ported from kg_chatbot). The model answers by
// calling tools (SPARQL over the project graph or a GraphDB repository, and a
// document-passage search); every query is kept and shown, and an evidence
// graph is rebuilt from the queries the answer cites. Shared by server and UI.

export type Term =
  { type: "uri"; value: string } | { type: "bnode"; value: string } | { type: "literal"; value: string; lang?: string; datatype?: string };

export type Binding = Record<string, Term>;

export type QueryKind = "select" | "construct" | "describe" | "ask" | "cypher" | "unknown";

/** Where Ask-mode questions are answered from. */
export type GraphSource = "project" | "graphdb" | "external";

export interface SparqlRun {
  context?: GraphReadContext;
  /** "Q1", "Q2", … for agent queries; "Q2·e" for the evidence expansion of Q2. */
  id: string;
  purpose: "agent" | "evidence";
  parentId?: string;
  /** the revision ("rev_…") or GraphDB repository the query ran against */
  repositoryId: string;
  kind: QueryKind;
  query: string;
  ok: boolean;
  error?: string;
  vars: string[];
  /** Capped for transport and storage; see rowCount for the full size. */
  rows: Binding[];
  rowCount: number;
  durationMs: number;
}

export interface GNode {
  id: string;
  kind: "resource" | "class" | "literal" | "bnode";
  label: string;
  iri?: string;
  compact?: string;
  type?: string;
  typeIri?: string;
  value?: string;
  datatype?: string;
  lang?: string;
  /** the project individual this node is, when the source is the project graph */
  individualId?: string;
  /** SPARQL variables this node was bound to, e.g. ["machine"]. */
  vars: string[];
  /** Query ids that produced this node. */
  sources: string[];
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  label: string;
  compact: string;
  isType: boolean;
  /** True when the edge stands for a property path (e.g. a/b+), not a single stored triple. */
  path: boolean;
  sources: string[];
}

export interface EvidenceGraph {
  nodes: GNode[];
  edges: GEdge[];
  /** Agent query ids the graph was built from. */
  queryIds: string[];
  prefixes: Record<string, string>;
  truncated: boolean;
  note?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ok?: boolean;
  preview?: string;
  durationMs?: number;
  queryId?: string;
}

export type TraceItem = { kind: "thinking"; text: string } | { kind: "note"; text: string } | { kind: "tool"; id: string };

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Literal-source checks are separate from scientific review or acceptance. */
export interface AnswerSourceIssue {
  kind: "definition" | "notation" | "modality" | "scope";
  fragment: string;
  acronym?: string;
  citations: string[];
  reason: string;
}
export interface AnswerSourceCheck {
  version: string;
  scope: string;
  status: "passed" | "repaired" | "withheld";
  issues: AnswerSourceIssue[];
  remainingIssues?: AnswerSourceIssue[];
  draft?: string;
  repairDraft?: string;
  removedExpansions?: string[];
  error?: string;
}
export interface AnswerSemanticEdit {
  fragment: string;
  replacement: string;
  reason: string;
  sources: { ref: string; quote: string }[];
}
export interface AnswerSemanticCheck {
  version: string;
  scope: string;
  status: "passed" | "repaired" | "withheld";
  edits: AnswerSemanticEdit[];
  /** Original rejected locations, retained when one bounded locator repair was attempted. */
  repairAttempt?: {
    originalEdits: AnswerSemanticEdit[];
    errors: { index: number; field: "fragment" | "sources"; message: string }[];
  };
  draft?: string;
  error?: string;
}

/** Everything behind one Ask answer, kept with the message. */
export interface AgentTrace {
  sourceCheck?: AnswerSourceCheck;
  semanticCheck?: AnswerSemanticCheck;
  completion?: "complete" | "interrupted" | "failed";
  error?: string;
  passages?: AnswerPassage[];
  sourceCoverage?: SourceCoverage;
  revisionId?: string;
  context?: GraphReadContext;
  source: GraphSource;
  /** "Revision 3" or "GraphDB · my-repo" */
  sourceLabel: string;
  /** GraphDB Workbench base URL, for links (GraphDB source only) */
  workbenchUrl?: string;
  runs: SparqlRun[];
  tools: ToolCall[];
  trace: TraceItem[];
  evidence?: EvidenceGraph;
  model: string;
  durationMs: number;
  usage?: AgentUsage;
}

export type ChatEvent =
  | { type: "passage"; passage: AnswerPassage }
  | { type: "source_context"; coverage: SourceCoverage }
  | { type: "status"; text: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  /** End of one model round; when hadTools is true the round's text was a progress note, not the answer. */
  | { type: "round_end"; hadTools: boolean }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; ok: boolean; preview: string; durationMs: number; queryId?: string }
  | { type: "sparql"; run: SparqlRun }
  | { type: "evidence"; graph: EvidenceGraph }
  | { type: "done"; model: string; durationMs: number; usage?: AgentUsage }
  | { type: "error"; message: string }
  /** the stored conversation and answer, once saved (last event of a turn) */
  | { type: "saved"; conversationId: string; messageId: string };

/** The GraphDB connection, as the server reports it. */
export interface GraphDbStatus {
  configured: boolean;
  /** Workbench / REST base URL */
  url?: string;
  reachable?: boolean;
  /** MCP endpoint reachable (chat needs it) */
  mcp?: boolean;
  repositories?: string[];
  error?: string;
}
