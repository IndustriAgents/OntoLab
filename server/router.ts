// Minimal method + path-pattern router for the project API. Path parameters
// are matched against a strict id pattern, so a crafted id can never reach a
// repository (or a file path) in the first place.

import type http from "node:http";

const PARAM_RE = "([A-Za-z0-9_-]{1,80})";

export interface Match<C> {
  handler: (c: C) => Promise<unknown>;
  params: Record<string, string>;
  pattern: string;
  opts: RouteOpts;
}

export interface RouteOpts {
  /** provider-backed: rate limited per client and run inside an LLM slot */
  llm?: boolean;
  /** not rate limited even though it may call a provider (bounded elsewhere) */
  unlimited?: boolean;
  /** abort the handler's signal when the client disconnects (default true) */
  abortOnClose?: boolean;
}

interface Route<C> {
  method: string;
  pattern: string;
  re: RegExp;
  keys: string[];
  handler: (c: C) => Promise<unknown>;
  opts: RouteOpts;
}

export class Router<C> {
  private routes: Route<C>[] = [];

  add(method: string, pattern: string, handler: (c: C) => Promise<unknown>, opts: RouteOpts = {}): this {
    const keys: string[] = [];
    const src = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return PARAM_RE;
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern, re: new RegExp(`^${src}$`), keys, handler, opts });
    return this;
  }

  get = (p: string, h: (c: C) => Promise<unknown>, o?: RouteOpts) => this.add("GET", p, h, o);
  post = (p: string, h: (c: C) => Promise<unknown>, o?: RouteOpts) => this.add("POST", p, h, o);
  put = (p: string, h: (c: C) => Promise<unknown>, o?: RouteOpts) => this.add("PUT", p, h, o);
  patch = (p: string, h: (c: C) => Promise<unknown>, o?: RouteOpts) => this.add("PATCH", p, h, o);
  delete = (p: string, h: (c: C) => Promise<unknown>, o?: RouteOpts) => this.add("DELETE", p, h, o);

  /** `null` = no such path; `"method"` = path exists but not for this method. */
  match(method: string, path: string): Match<C> | null | "method" {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      return { handler: r.handler, params, pattern: r.pattern, opts: r.opts };
    }
    return pathMatched ? "method" : null;
  }
}

/** A non-JSON response (file download). */
export class FileResponse {
  constructor(
    readonly body: Buffer | string,
    readonly contentType: string,
    readonly filename?: string,
  ) {}
}

/**
 * A server-sent-event stream. The dispatcher writes the SSE headers, then
 * calls `run`, which emits JSON events until it resolves; an error becomes a
 * final `{ type: "error" }` event.
 */
export class StreamResponse {
  constructor(readonly run: (emit: (event: unknown) => void, signal: AbortSignal) => Promise<void>) {}
}

/** JSON with a non-200 status. */
export class StatusResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export function headerString(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
