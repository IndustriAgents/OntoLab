// HTTP plumbing shared by every endpoint: body reading with a hard cap, JSON
// responses, auth, rate limiting, concurrency limiting and structured logging.

import type http from "node:http";
import { API_TOKEN, MAX_BODY_BYTES, MAX_CONCURRENT_LLM, RATE_LIMIT, RATE_WINDOW_MS } from "./config.ts";

/** A request-scoped error whose message and status are safe to show the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function send(res: http.ServerResponse, status: number, body: string | Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": contentType, "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

export function json(res: http.ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), "application/json", headers);
}

/**
 * Read a JSON request body, enforcing the size cap and the content type.
 * Requiring application/json means a cross-origin form post cannot silently
 * trigger a paid extraction (it would need a preflight, which we never allow).
 */
export async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ctype !== "application/json") throw badRequest("Content-Type must be application/json");

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, `Request body too large (${Math.round(declared / 1e6)} MB, limit ${Math.round(MAX_BODY_BYTES / 1e6)} MB)`);
  }

  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, `Request body too large (limit ${Math.round(MAX_BODY_BYTES / 1e6)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

/**
 * Read a binary upload (application/octet-stream). Like readJsonBody, the
 * content type is enforced: it is not CORS-safelisted, so a cross-site page
 * cannot post one without a preflight we never grant.
 */
export async function readRawBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ctype !== "application/octet-stream") throw badRequest("Content-Type must be application/octet-stream");
  const declared = Number(req.headers["content-length"] ?? 0);
  const limitMb = (max / 1e6).toFixed(0);
  if (declared && declared > max) throw new HttpError(413, `File too large (${(declared / 1e6).toFixed(1)} MB, limit ${limitMb} MB)`);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new HttpError(413, `File too large (limit ${limitMb} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ───────────────────────── auth ───────────────────────── */

/**
 * When API_TOKEN is configured, callers must supply it on protected API routes.
 */
export function checkAuth(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) return true;
  const header = req.headers["x-api-token"];
  const supplied = Array.isArray(header) ? header[0] : header;
  if (!supplied) {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return timingSafeEqual(auth, API_TOKEN);
  }
  return timingSafeEqual(supplied, API_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ───────────────────────── rate limiting ───────────────────────── */

const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientKey(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first?.split(",")[0].trim() || req.socket.remoteAddress || "unknown").slice(0, 64);
}

/** Fixed-window limiter. Returns null when allowed, else seconds until reset. */
export function rateLimit(key: string): number | null {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return null;
  }
  if (b.count >= RATE_LIMIT) return Math.ceil((b.resetAt - now) / 1000);
  b.count++;
  return null;
}

/* ───────────────────────── concurrency ───────────────────────── */

let inFlight = 0;
const waiting: (() => void)[] = [];

/** Run `fn` with at most MAX_CONCURRENT_LLM provider calls in flight per instance. */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_LLM) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/* ───────────────────────── logging ───────────────────────── */

export interface CallLog {
  endpoint: string;
  provider?: string;
  model?: string;
  status: number;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  error?: string;
}

/** One structured line per request, so cost and failures can be attributed. */
export function logCall(entry: CallLog): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}
