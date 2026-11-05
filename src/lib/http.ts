// Shared API request plumbing: base path, request IDs, and HTTP errors.

const API_BASE = import.meta.env.BASE_URL; // "/ontolab/" in prod, "/" in dev

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isQuota() {
    return this.status === 507;
  }
  get isConflict() {
    return this.status === 409;
  }
}

/** Thrown when the user cancels a request; callers ignore it rather than showing an error. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Distinguishes "the server is unreachable" from "the server said no". */
export class NetworkError extends Error {
  constructor() {
    super("Could not reach the OntoLab server. It may be starting up — try again in a moment.");
    this.name = "NetworkError";
  }
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path.replace(/^\/+/, "")}`;
}

function requestId(): string {
  return (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
}

export interface RequestOptions {
  body?: unknown;
  /** binary upload (sent as application/octet-stream) */
  raw?: Blob | ArrayBuffer;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function rawRequest(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "x-request-id": requestId(), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { method, headers, body, signal: opts.signal, credentials: "same-origin" });
  } catch (e) {
    if (opts.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) throw new CancelledError();
    throw new NetworkError();
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; requestId?: string };
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.requestId ?? res.headers.get("x-request-id") ?? undefined);
  }
  return res;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(method, path, opts);
  return (await res.json()) as T;
}

/** Fetch a file with credentials and hand it to the browser as a download. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await rawRequest("GET", path);
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
