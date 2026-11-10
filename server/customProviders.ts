// OpenAI-compatible endpoints (LiteLLM, vLLM, LM Studio, Ollama's /v1, hosted
// gateways). One can come from the environment (OPENAI_COMPAT_*); any number
// can be saved from Settings. Saved keys are encrypted at rest and, like every
// other provider key, never reach the client.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HttpError } from "./http.ts";
import { endpoint } from "./connections/http.ts";
import { decryptAuth, encryptAuth } from "./connections/secrets.ts";
import type { ProviderInfo } from "./providers.ts";

export const CUSTOM_PROVIDER = "openai-compatible";
export type CustomProviderId = typeof CUSTOM_PROVIDER | `${typeof CUSTOM_PROVIDER}:${string}`;

export const isCustomProvider = (id: string): id is CustomProviderId => id === CUSTOM_PROVIDER || id.startsWith(`${CUSTOM_PROVIDER}:`);

/** Public view of a saved endpoint. It never carries the key. */
export interface ModelEndpoint {
  id: string;
  providerId: CustomProviderId;
  label: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  updatedAt: string;
}

interface Saved {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** encrypted API key, as stored on disk */
  secret?: string;
  updatedAt: string;
}

interface Resolved {
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

const SECRET_OWNER = "model-endpoints";
const MAX_ENDPOINTS = 20;

let file: string | undefined;
let saved: Saved[] = [];
const keys = new Map<string, string>();

/**
 * Accept the base URL the way people paste it: with or without /v1, with a
 * trailing slash, or as the full chat-completions URL. A bare host gets /v1.
 */
export function normalizeBaseUrl(value: unknown): string {
  const u = new URL(endpoint(typeof value === "string" ? value.trim() : value));
  const path = u.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return u.origin + (path || "/v1");
}

export function parseModels(value: unknown): string[] {
  const items = typeof value === "string" ? value.split(/[\n,]/) : Array.isArray(value) ? value : [];
  if (items.some((m) => typeof m !== "string")) throw new HttpError(400, "Model ids must be text.");
  const models = [...new Set((items as string[]).map((m) => m.trim()).filter(Boolean))];
  // eslint-disable-next-line no-control-regex
  if (models.length > 200 || models.some((m) => m.length > 160 || /[\u0000-\u001f\s]/.test(m)))
    throw new HttpError(400, "Enter up to 200 model ids, each without spaces and at most 160 characters.");
  return models;
}

/* ───────────────────────── registry ───────────────────────── */

function envEndpoint(): (Resolved & { error?: string }) | undefined {
  const raw = process.env.OPENAI_COMPAT_BASE_URL?.trim();
  if (!raw) return undefined;
  const base = {
    label: process.env.OPENAI_COMPAT_LABEL?.trim() || "OpenAI-compatible",
    apiKey: process.env.OPENAI_COMPAT_API_KEY?.trim() ?? "",
    baseUrl: "",
    models: [] as string[],
  };
  try {
    base.baseUrl = normalizeBaseUrl(raw);
    base.models = parseModels(process.env.OPENAI_COMPAT_MODELS ?? "");
  } catch {
    return { ...base, error: "OPENAI_COMPAT_BASE_URL or OPENAI_COMPAT_MODELS is not valid." };
  }
  return base.models.length ? base : { ...base, error: "Set OPENAI_COMPAT_MODELS to the model ids this endpoint serves." };
}

export function customProviderInfos(): ProviderInfo[] {
  const list: ProviderInfo[] = [];
  const env = envEndpoint();
  if (env)
    list.push({
      id: CUSTOM_PROVIDER,
      label: env.label,
      enabled: !env.error,
      models: env.models,
      ...(env.error ? { disabledReason: env.error } : {}),
    });
  for (const e of saved) list.push({ id: `${CUSTOM_PROVIDER}:${e.id}`, label: e.label, enabled: true, models: e.models });
  return list;
}

/** Where and how to call a custom provider. */
export function customEndpoint(id: CustomProviderId): { url: string; apiKey: string; label: string } {
  const env = id === CUSTOM_PROVIDER ? envEndpoint() : undefined;
  const stored = saved.find((e) => `${CUSTOM_PROVIDER}:${e.id}` === id);
  const found: Resolved | undefined = env && !env.error ? env : stored && { ...stored, apiKey: keys.get(stored.id) ?? "" };
  if (!found) throw new HttpError(400, "This model endpoint is no longer configured. Choose another model.");
  return { url: `${found.baseUrl}/chat/completions`, apiKey: found.apiKey, label: found.label };
}

/* ───────────────────────── saved endpoints ───────────────────────── */

const dto = (e: Saved): ModelEndpoint => ({
  id: e.id,
  providerId: `${CUSTOM_PROVIDER}:${e.id}`,
  label: e.label,
  baseUrl: e.baseUrl,
  models: e.models,
  hasKey: !!e.secret,
  updatedAt: e.updatedAt,
});

/** Load saved endpoints. Entry points call this once; without it only the environment endpoint exists. */
export async function openModelEndpoints(dataDir: string): Promise<void> {
  file = join(resolve(dataDir), "model-endpoints.json");
  saved = [];
  keys.clear();
  let records: Saved[];
  try {
    records = (JSON.parse(await readFile(file, "utf8")) as { endpoints: Saved[] }).endpoints;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[model-endpoints] could not read saved endpoints:", e);
    return;
  }
  for (const record of Array.isArray(records) ? records : []) {
    try {
      const auth = await decryptAuth(record.secret, SECRET_OWNER, record.id);
      if (auth.type === "bearer") keys.set(record.id, auth.token);
      saved.push(record);
    } catch {
      // The endpoint stays visible so its key can be entered again.
      console.error(`[model-endpoints] the key for "${record.label}" cannot be decrypted; enter it again in Settings.`);
      saved.push({ ...record, secret: undefined });
    }
  }
}

export function closeModelEndpoints(): void {
  file = undefined;
  saved = [];
  keys.clear();
}

function requireFile(): string {
  if (!file) throw new HttpError(503, "Saved model endpoints are unavailable here. Configure OPENAI_COMPAT_* in the environment.");
  return file;
}

async function persist(): Promise<void> {
  const path = requireFile();
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ endpoints: saved }, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export function listModelEndpoints(): { available: boolean; endpoints: ModelEndpoint[] } {
  return { available: !!file, endpoints: saved.map(dto) };
}

function apiKeyInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, "Enter a valid API key.");
  return value.trim();
}

/** `apiKey` omitted keeps the stored key; an empty string removes it. */
export async function saveModelEndpoint(
  input: { label?: unknown; baseUrl?: unknown; models?: unknown; apiKey?: unknown },
  id?: string,
  now = new Date(),
): Promise<ModelEndpoint> {
  requireFile();
  const old = id ? saved.find((e) => e.id === id) : undefined;
  if (id && !old) throw new HttpError(404, "Model endpoint not found.");
  if (!old && saved.length >= MAX_ENDPOINTS) throw new HttpError(400, `At most ${MAX_ENDPOINTS} model endpoints can be saved.`);
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 80) throw new HttpError(400, "Enter a name of at most 80 characters.");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const models = parseModels(input.models);
  if (!models.length) throw new HttpError(400, "Add at least one model id.");
  const apiKey = apiKeyInput(input.apiKey);
  // A key entered for one server must never be sent to another.
  if (old?.secret && apiKey === undefined && new URL(old.baseUrl).origin !== new URL(baseUrl).origin)
    throw new HttpError(400, "Re-enter the API key when changing the server address.");

  const eid = old?.id ?? randomBytes(6).toString("hex");
  const secret = apiKey === undefined ? old?.secret : await encryptAuth({ type: "bearer", token: apiKey }, SECRET_OWNER, eid);
  const next: Saved = { id: eid, label, baseUrl, models, ...(apiKey === "" || !secret ? {} : { secret }), updatedAt: now.toISOString() };
  saved = old ? saved.map((e) => (e.id === eid ? next : e)) : [...saved, next];
  if (apiKey) keys.set(eid, apiKey);
  else if (apiKey === "") keys.delete(eid);
  await persist();
  return dto(next);
}

export async function deleteModelEndpoint(id: string): Promise<{ removed: true }> {
  requireFile();
  if (!saved.some((e) => e.id === id)) throw new HttpError(404, "Model endpoint not found.");
  saved = saved.filter((e) => e.id !== id);
  keys.delete(id);
  await persist();
  return { removed: true };
}

/** Ask the server which models it serves (GET <base>/models). Doubles as the connection test. */
export async function discoverModels(
  input: { baseUrl?: unknown; apiKey?: unknown; id?: unknown },
  signal?: AbortSignal,
): Promise<{ baseUrl: string; models: string[] }> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const old = typeof input.id === "string" ? saved.find((e) => e.id === input.id) : undefined;
  let apiKey = apiKeyInput(input.apiKey);
  if (!apiKey && old && new URL(old.baseUrl).origin === new URL(baseUrl).origin) apiKey = keys.get(old.id);
  const timeout = AbortSignal.timeout(15_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new HttpError(502, `Could not reach ${baseUrl}. Check the address and that the server is running.`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(422, "The server rejected the API key.");
  if (!res.ok)
    throw new HttpError(502, `${baseUrl}/models returned HTTP ${res.status}. Check the base URL, or enter the model ids by hand.`);
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] } | null;
  const ids = (body?.data ?? body?.models ?? [])
    .map((m: { id?: unknown; name?: unknown }) => m?.id ?? m?.name)
    .filter((m): m is string => typeof m === "string" && !!m.trim() && m.length <= 160 && !/\s/.test(m.trim()));
  if (!ids.length) throw new HttpError(502, "The server did not list any models. Enter the model ids by hand.");
  return { baseUrl, models: [...new Set(ids.map((m) => m.trim()))].sort().slice(0, 200) };
}
