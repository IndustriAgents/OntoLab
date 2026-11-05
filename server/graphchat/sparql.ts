// Runs graph-chat queries on a backend and records them as SparqlRuns
// (ported from kg_chatbot). Updates are refused: the assistant is read-only.

import SparqlJs from "sparqljs";
import type { Binding, QueryKind, SparqlRun } from "../../src/types/graphChat.ts";
import type { GraphBackend } from "./backend.ts";
import { termText, type Triple } from "./rdf.ts";

/** Rows kept on a run sent to the browser and stored with the answer. */
export const ROW_TRANSPORT_CAP = 200;
const RESULT_CHAR_CAP = 12_000;
const RESULT_ROW_CAP = 60;

/** A run plus the server-only data needed to build evidence later. */
export interface RunRecord extends SparqlRun {
  parsed?: SparqlJs.SparqlQuery;
  /** every row returned (rows on the DTO are capped) */
  allRows: Binding[];
  /** CONSTRUCT / DESCRIBE output */
  triples?: Triple[];
}

export function analyzeQuery(query: string): { kind: QueryKind; parsed?: SparqlJs.SparqlQuery; isUpdate: boolean } {
  try {
    const parsed = new SparqlJs.Parser({ skipValidation: true } as SparqlJs.ParserOptions).parse(query);
    if (parsed.type === "update") return { kind: "unknown", parsed, isUpdate: true };
    return { kind: parsed.queryType.toLowerCase() as QueryKind, parsed, isUpdate: false };
  } catch {
    // GraphDB accepts some syntax sparqljs doesn't (e.g. vendor functions); fall back to a keyword sniff.
    const body = query.replace(/#[^\n]*/g, " ").replace(/<[^>]*>/g, " ");
    if (/\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY)\b/i.test(body) && !/\bSELECT\b|\bCONSTRUCT\b/i.test(body)) {
      return { kind: "unknown", isUpdate: true };
    }
    const m = body.match(/\b(SELECT|CONSTRUCT|DESCRIBE|ASK)\b/i);
    return { kind: (m?.[1].toLowerCase() as QueryKind) ?? "unknown", isUpdate: false };
  }
}

export async function runSparql(
  backend: GraphBackend,
  query: string,
  id: string,
  purpose: SparqlRun["purpose"] = "agent",
  parentId?: string,
): Promise<RunRecord> {
  const { kind, parsed, isUpdate } =
    backend.queryLanguage === "cypher" ? { kind: "cypher" as const, parsed: undefined, isUpdate: false } : analyzeQuery(query);
  const base = { id, purpose, parentId, repositoryId: backend.repositoryId, kind, query, parsed };
  const fail = (error: string, durationMs = 0): RunRecord => ({
    ...base,
    ok: false,
    error,
    vars: [],
    rows: [],
    allRows: [],
    rowCount: 0,
    durationMs,
  });
  if (isUpdate) return fail("Update queries are not allowed: this assistant is read-only.");
  if (kind !== "unknown" && !backend.kinds.includes(kind)) {
    return fail(
      `${kind.toUpperCase()} queries are not supported on ${backend.label}. Use ${backend.kinds.map((k) => k.toUpperCase()).join(" or ")}.`,
    );
  }
  const t0 = performance.now();
  const res = await backend.query(query);
  const durationMs = Math.round(performance.now() - t0);
  if (!res.ok) return fail(res.error, durationMs);
  return {
    ...base,
    ok: true,
    context: backend.sourceContext,
    vars: res.vars,
    rows: res.rows.slice(0, ROW_TRANSPORT_CAP),
    allRows: res.rows,
    rowCount: res.total,
    triples: res.triples,
    durationMs,
  };
}

/** Strips server-only fields before sending a run to the browser or storing it. */
export function toDto(run: RunRecord): SparqlRun {
  const { parsed: _p, allRows: _a, triples: _t, ...dto } = run;
  return dto;
}

function clip(text: string): string {
  return text.length > RESULT_CHAR_CAP ? `${text.slice(0, RESULT_CHAR_CAP)}\n… (output truncated)` : text;
}

/** What the model reads back from a query: a tab-separated table under the query id. */
export function sparqlResultForLlm(run: RunRecord): string {
  if (!run.ok) return `[${run.id}] Query failed: ${run.error}`;
  if (run.kind === "ask") return `[${run.id}] ASK → ${run.allRows[0]?.result?.value}`;
  const kind = run.kind.toUpperCase();
  const unit = run.triples ? "triple" : "row";
  const shown = run.allRows.slice(0, RESULT_ROW_CAP);
  const table = [run.vars.map((v) => `?${v}`).join("\t"), ...shown.map((r) => run.vars.map((v) => termText(r[v])).join("\t"))];
  const more = run.rowCount - shown.length;
  return clip(
    `[${run.id}] ${kind} returned ${run.rowCount} ${unit}${run.rowCount === 1 ? "" : "s"}.\n${table.join("\n")}` +
      (more > 0 ? `\n… ${more} more ${unit}s not shown (refine the query or aggregate if you need them).` : ""),
  );
}
