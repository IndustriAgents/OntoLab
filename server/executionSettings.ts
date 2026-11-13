import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LLM_TIMEOUT_MS, MAX_STEP_ATTEMPTS } from "./config.ts";
import { HttpError } from "./http.ts";
import type { ExecutionSettings } from "../src/types/execution.ts";

const defaults = (): ExecutionSettings => ({ cliConcurrency: 1, timeoutMs: LLM_TIMEOUT_MS, maxStepAttempts: MAX_STEP_ATTEMPTS });
let settings = defaults();
let file: string | undefined;
const listeners = new Set<() => void>();
const scope = new AsyncLocalStorage<ExecutionSettings>();
export const executionSettings = (): ExecutionSettings => ({ ...(scope.getStore() ?? settings) });
export const cliConcurrency = (): number => settings.cliConcurrency;
export function withExecutionSettings<T>(fn: () => T): T {
  return scope.run({ ...settings }, fn);
}
export function onExecutionSettingsChange(listener: () => void): void {
  listeners.add(listener);
}

function validate(input: unknown): ExecutionSettings {
  if (!input || typeof input !== "object") throw new HttpError(400, "Execution settings are required.");
  const value = input as Record<string, unknown>;
  const bounds = { cliConcurrency: [1, 16], timeoutMs: [1000, 3_600_000], maxStepAttempts: [1, 20] } as const;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
      throw new HttpError(400, `${key} must be an integer between ${min} and ${max}.`);
  }
  return {
    cliConcurrency: value.cliConcurrency as number,
    timeoutMs: value.timeoutMs as number,
    maxStepAttempts: value.maxStepAttempts as number,
  };
}
export async function openExecutionSettings(dataDir: string): Promise<void> {
  file = join(dataDir, "execution-settings.json");
  settings = defaults();
  try {
    settings = validate(JSON.parse(await readFile(file, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[execution-settings] Could not load settings:", e);
  }
  listeners.forEach((notify) => notify());
}
// Serialize writes so simultaneous settings saves cannot reorder disk and memory.
let writes: Promise<unknown> = Promise.resolve();
export function saveExecutionSettings(input: unknown): Promise<ExecutionSettings> {
  const next = validate(input);
  const save = writes
    .catch(() => {})
    .then(async () => {
      if (!file) throw new HttpError(503, "Execution settings are unavailable in this server.");
      await mkdir(join(file, ".."), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      settings = next;
      listeners.forEach((notify) => notify());
      return { ...next };
    });
  writes = save;
  return save;
}
