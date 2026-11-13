/** Workspace execution limits, applied to new requests and extraction steps. */
export interface ExecutionSettings {
  cliConcurrency: number;
  timeoutMs: number;
  maxStepAttempts: number;
}
