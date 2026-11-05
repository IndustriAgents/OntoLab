import { useCallback, useEffect, useRef, useState } from "react";
import { CancelledError } from "../lib/api";

export interface CancellableRun {
  running: boolean;
  error: string | null;
  /** Seconds elapsed in the current run — long model calls need visible progress. */
  elapsed: number;
  run: <T>(fn: (signal: AbortSignal) => Promise<T>, onDone?: (result: T) => void) => Promise<T | undefined>;
  cancel: () => void;
  setError: (message: string | null) => void;
}

/**
 * Runs one async operation at a time with cancellation and an elapsed-time
 * counter. Extraction can take minutes; without a cancel path the only escape
 * was a page reload, which used to destroy the whole session.
 */
export function useCancellableRun(): CancellableRun {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(async <T,>(fn: (signal: AbortSignal) => Promise<T>, onDone?: (result: T) => void): Promise<T | undefined> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError(null);
    try {
      const result = await fn(controller.signal);
      if (controller.signal.aborted || !mounted.current) return undefined;
      onDone?.(result);
      return result;
    } catch (e) {
      if (e instanceof CancelledError || controller.signal.aborted || !mounted.current) return undefined;
      setError(e instanceof Error ? e.message : "Something went wrong");
      return undefined;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mounted.current) setRunning(false);
    }
  }, []);

  return { running, error, elapsed, run, cancel, setError };
}
