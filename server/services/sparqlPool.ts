// SPARQL on a worker thread (B8). Oxigraph's JS API is synchronous: a runaway
// query used to block the whole server until it finished, and every query
// re-loaded the revision's graph. Here one worker thread keeps an LRU of
// loaded stores (one per revision content) and runs queries; a query that
// passes the timeout is cancelled by terminating the worker, which is then
// restarted on the next call. The main thread never blocks.

import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { MAX_SPARQL_ROWS, SPARQL_TIMEOUT_MS } from "../config.ts";
import { assertReadOnlyQuery } from "./sparqlGuard.ts";
import type { SparqlResult } from "../extract.ts";
import type { Binding } from "../../src/types/graphChat.ts";

const LRU_SIZE = Number(process.env.SPARQL_STORES) || 8;

// Plain CommonJS so it runs without the TypeScript loader (tsx, vitest and the
// esbuild bundle alike). It receives the resolved path of oxigraph.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const ox = require(workerData.oxigraph);
const stores = new Map();
const term = (v) => v.termType === "NamedNode" ? { type: "uri", value: v.value }
  : v.termType === "BlankNode" ? { type: "bnode", value: v.value }
  : v.language ? { type: "literal", value: v.value, lang: v.language }
  : { type: "literal", value: v.value, datatype: v.datatype ? v.datatype.value : undefined };
parentPort.on("message", (m) => {
  try {
    if (m.type === "evict") { stores.delete(m.key); return; }
    if (m.type === "load") {
      const s = new ox.Store();
      s.load(m.turtle, { format: "text/turtle" });
      stores.set(m.key, s);
      parentPort.postMessage({ id: m.id, ok: true });
      return;
    }
    const s = stores.get(m.key);
    if (!s) { parentPort.postMessage({ id: m.id, missing: true }); return; }
    const result = s.query(m.sparql);
    if (typeof result === "boolean") {
      const v = String(result);
      parentPort.postMessage({ id: m.id, columns: ["result"], rows: [{ result: m.typed ? { type: "literal", value: v, datatype: "http://www.w3.org/2001/XMLSchema#boolean" } : v }], total: 1 });
      return;
    }
    if (!result.length) { parentPort.postMessage({ id: m.id, columns: [], rows: [], total: 0 }); return; }
    if (typeof result[0].get === "function") {
      // every variable any row binds, in first-seen order (an OPTIONAL may leave the first row short)
      const columns = [];
      for (const b of result.slice(0, 50)) for (const k of b.keys()) if (!columns.includes(k)) columns.push(k);
      const rows = result.slice(0, m.maxRows).map((b) => { const r = {}; for (const c of columns) { const v = b.get(c); if (m.typed) { if (v) r[c] = term(v); } else r[c] = v ? v.value : ""; } return r; });
      parentPort.postMessage({ id: m.id, columns, rows, truncated: result.length > rows.length, total: result.length });
      return;
    }
    const rows = result.slice(0, m.maxRows).map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value }));
    parentPort.postMessage({ id: m.id, columns: ["subject", "predicate", "object"], rows, truncated: result.length > rows.length });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e && e.message ? String(e.message) : "Query failed" });
  }
});
`;

interface Pending {
  worker: Worker;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
/** keys loaded in the worker, least recently used first */
const loaded: string[] = [];
let seq = 0;

function start(): Worker {
  if (worker) return worker;
  const oxigraph = createRequire(import.meta.url).resolve("oxigraph");
  const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { oxigraph } });
  w.unref();
  w.on("message", (m: { id: number }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.resolve(m as Record<string, unknown>);
  });
  // Only this worker's requests fail with it: a replacement may already be serving others.
  const fail = (e: Error) => {
    for (const [id, p] of pending) {
      if (p.worker !== w) continue;
      pending.delete(id);
      p.reject(e);
    }
    if (worker === w) {
      worker = null;
      loaded.length = 0;
    }
  };
  w.on("error", fail);
  w.on("exit", () => fail(new Error("The query worker stopped.")));
  worker = w;
  return w;
}

function send(msg: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // The only way to stop a synchronous query: drop the worker (its cache goes with it).
      void w.terminate();
      if (worker === w) worker = null;
      loaded.length = 0;
      reject(new Error(`The query took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. Add constraints or a smaller LIMIT.`));
    }, timeoutMs);
    pending.set(id, {
      worker: w,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    w.postMessage({ ...msg, id });
  });
}

function touch(key: string) {
  const at = loaded.indexOf(key);
  if (at >= 0) loaded.splice(at, 1);
  loaded.push(key);
  while (loaded.length > LRU_SIZE) {
    const old = loaded.shift()!;
    worker?.postMessage({ type: "evict", key: old });
  }
}

/**
 * Run a read-only query against the graph identified by `key` (e.g. a revision's
 * content hash). `turtle` is only called when that graph is not loaded yet.
 */
export async function querySparql(key: string, turtle: () => string, sparql: string, opts: { timeoutMs?: number; maxRows?: number } = {}): Promise<SparqlResult> {
  assertReadOnlyQuery(sparql);
  const res = await queryRaw(key, turtle, sparql, opts, false);
  return { columns: res.columns as string[], rows: res.rows as Record<string, string>[], ...(res.truncated ? { truncated: true } : {}) };
}

/** As querySparql, but every value is an RDF term (IRI, blank node or literal with its datatype). */
export async function querySparqlTyped(
  key: string,
  turtle: () => string,
  sparql: string,
  opts: { timeoutMs?: number; maxRows?: number } = {},
): Promise<{ columns: string[]; rows: Binding[]; total: number }> {
  assertReadOnlyQuery(sparql);
  const res = await queryRaw(key, turtle, sparql, opts, true);
  return { columns: res.columns as string[], rows: res.rows as Binding[], total: Number(res.total ?? (res.rows as unknown[]).length) };
}

async function queryRaw(key: string, turtle: () => string, sparql: string, opts: { timeoutMs?: number; maxRows?: number }, typed: boolean): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? SPARQL_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!loaded.includes(key)) {
      const res = await send({ type: "load", key, turtle: turtle() }, timeoutMs * 2);
      if (res.error) throw new Error(`Could not load the graph: ${res.error}`);
    }
    touch(key);
    const res = await send({ type: "query", key, sparql, maxRows: opts.maxRows ?? MAX_SPARQL_ROWS, typed }, timeoutMs);
    if (res.missing) {
      loaded.splice(loaded.indexOf(key), 1);
      continue;
    }
    if (res.error) throw new Error(String(res.error));
    return res;
  }
  throw new Error("The graph could not be loaded for querying.");
}

/** For tests and shutdown. */
export async function stopSparqlPool(): Promise<void> {
  const w = worker;
  worker = null;
  loaded.length = 0;
  if (w) await w.terminate();
}
