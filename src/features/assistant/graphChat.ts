import type { AnswerPassage, SourceCoverage } from "../../types/sourceEvidence";
// Client side of graph chat (from kg_chatbot's web/lib): the streamed turn,
// the reducer that folds server events into it, and display helpers.

import { rawRequest } from "../../lib/http";
import type { AgentUsage, ChatEvent, EvidenceGraph, GraphSource, SparqlRun, ToolCall, TraceItem } from "../../types/graphChat";
import type { ConversationMessage } from "../../types/project";

export interface Turn {
  passages?: AnswerPassage[];
  sourceCoverage?: SourceCoverage;
  revisionId?: string;
  id: string;
  question: string;
  answer: string;
  trace: TraceItem[];
  tools: ToolCall[];
  runs: SparqlRun[];
  graph?: EvidenceGraph;
  status: "streaming" | "done" | "error" | "stopped";
  statusText?: string;
  error?: string;
  model?: string;
  durationMs?: number;
  usage?: AgentUsage;
  source?: GraphSource;
  sourceLabel?: string;
  workbenchUrl?: string;
}

export function newTurn(question: string, source: GraphSource, sourceLabel: string): Turn {
  return { id: `live-${Date.now()}`, question, answer: "", trace: [], tools: [], runs: [], status: "streaming", source, sourceLabel };
}

/** A stored answer as a turn, so the evidence window shows it like a live one. */
export function turnFromMessage(question: string, m: ConversationMessage): Turn | null {
  const a = m.agent;
  if (!a) return null;
  return {
    passages: a.passages,
    sourceCoverage: a.sourceCoverage,
    revisionId: a.revisionId,
    id: m.id,
    question,
    answer: m.content,
    trace: a.trace,
    tools: a.tools,
    runs: a.runs,
    graph: a.evidence,
    status: a.completion === "interrupted" ? "stopped" : a.completion === "failed" ? "error" : "done",
    error: a.error,
    model: a.model,
    durationMs: a.durationMs,
    usage: a.usage,
    source: a.source,
    sourceLabel: a.sourceLabel,
    workbenchUrl: a.workbenchUrl,
  };
}

/** Q2 < Q2·e < Q3: evidence expansions sort right after their query. */
const runOrder = (id: string) => Number(id.match(/\d+/)?.[0] ?? 0) * 2 + (id.includes("·") ? 1 : 0);

/** Pure reducer: folds one server event into a turn. */
export function applyEvent(t: Turn, e: ChatEvent): Turn {
  switch (e.type) {
    case "passage":
      return { ...t, passages: [...(t.passages ?? []).filter((p) => p.ref !== e.passage.ref), e.passage] };
    case "source_context":
      return { ...t, sourceCoverage: e.coverage, revisionId: e.coverage.revisionId, sourceLabel: e.coverage.label };
    case "status":
      return { ...t, statusText: e.text };
    case "thinking": {
      const last = t.trace[t.trace.length - 1];
      if (last?.kind === "thinking") return { ...t, trace: [...t.trace.slice(0, -1), { kind: "thinking", text: last.text + e.text }] };
      return e.text.trim() ? { ...t, trace: [...t.trace, { kind: "thinking", text: e.text.trimStart() }] } : t;
    }
    case "text":
      return { ...t, answer: t.answer + e.text, statusText: undefined };
    case "round_end":
      // Text written before a tool call is a progress note, not the answer.
      if (e.hadTools && t.answer.trim()) return { ...t, answer: "", trace: [...t.trace, { kind: "note", text: t.answer.trim() }] };
      return e.hadTools ? { ...t, answer: "" } : t;
    case "tool_call":
      return { ...t, tools: [...t.tools, e.call], trace: [...t.trace, { kind: "tool", id: e.call.id }], statusText: undefined };
    case "tool_result":
      return { ...t, tools: t.tools.map((c) => (c.id === e.id ? { ...c, ok: e.ok, preview: e.preview, durationMs: e.durationMs } : c)) };
    case "sparql":
      return { ...t, runs: [...t.runs.filter((r) => r.id !== e.run.id), e.run].sort((a, b) => runOrder(a.id) - runOrder(b.id)) };
    case "evidence":
      return { ...t, graph: e.graph };
    case "done":
      return { ...t, status: "done", statusText: undefined, model: e.model, durationMs: e.durationMs, usage: e.usage };
    case "error":
      return { ...t, status: "error", statusText: undefined, error: e.message };
    case "saved":
      return t;
  }
}

/** POSTs a question and dispatches the server-sent events as they arrive. */
export async function streamChat(
  pid: string,
  body: {
    question: string;
    conversationId?: string;
    revisionId?: string;
    passageKey?: string;
    provider: string;
    model: string;
    source: GraphSource;
  },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await rawRequest("POST", `api/projects/${encodeURIComponent(pid)}/assistant/chat`, { body, signal });
  if (!res.body) throw new Error("The server sent no stream.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as ChatEvent);
    }
  }
}

/** Query ids cited in the answer text, e.g. [Q3] or [Q3, Q4]. */
export function citedIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\[((?:Q\d+)(?:\s*[,;]\s*Q\d+)*)\]/g)) for (const id of m[1].split(/\s*[,;]\s*/)) ids.add(id);
  return [...ids];
}

/* ───────────────────────── formatting ───────────────────────── */

const COMMON: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dct: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  schema: "http://schema.org/",
};

export type Compactor = (iri: string) => string;

export function makeCompactor(prefixes: Record<string, string> = {}): Compactor {
  const entries = Object.entries({ ...COMMON, ...prefixes }).sort((a, b) => b[1].length - a[1].length);
  return (iri) => {
    for (const [p, ns] of entries) {
      if (iri.startsWith(ns)) {
        const local = iri.slice(ns.length);
        if (/^[\w.-]*$/.test(local)) return `${p}:${local}`;
      }
    }
    return iri;
  };
}

export function formatMs(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

export const workbenchResourceUrl = (base: string, iri: string) => `${base}/resource?uri=${encodeURIComponent(iri)}`;
export const workbenchSparqlUrl = (base: string, query: string) => `${base}/sparql?query=${encodeURIComponent(query)}`;

const TOOL_LABELS: Record<string, string> = {
  sparql_query: "SPARQL query",
  search_documents: "Document search",
  find_individuals: "Find individuals",
  autocomplete_iri_discovery_search: "IRI lookup",
  iri_discovery_search: "IRI search",
  fts_search: "Full-text search",
  ontology_schema: "Ontology schema",
  get_similarity_options: "Similarity options",
  similarity_search: "Similarity search",
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/** One-line form of a query for compact lists. */
export const queryLine = (q: string) => q.replace(/\s+/g, " ").replace(/^.*?(SELECT|CONSTRUCT|DESCRIBE|ASK)/i, "$1");
