import { EventEmitter } from "node:events";
export const workspaceEvents = new EventEmitter();
workspaceEvents.setMaxListeners(100);
import { createHash } from "node:crypto";
import type { ServiceCtx } from "../services/context.ts";
import { HttpError } from "../http.ts";

const locks = new Map<string, Promise<void>>();
/** One workspace runtime owns local writes; each operation is serialized within it. */
export async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export async function readState<T>(ctx: ServiceCtx, path: string): Promise<T | null> {
  const bytes = await ctx.store.blobs.get(path);
  return bytes ? (JSON.parse(bytes.toString("utf8")) as T) : null;
}
export async function writeState(ctx: ServiceCtx, path: string, value: unknown): Promise<void> {
  await ctx.store.blobs.put(path, Buffer.from(JSON.stringify(value)), "application/json");
}
export function stale(message = "The inputs changed. Inspect the current workspace and prepare a new plan."): never {
  throw new HttpError(409, message);
}
