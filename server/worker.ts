// Background worker (B7): advances runnable runs without an open browser tab.
// It uses the same advanceRun as the browser, so leases and checkpoints keep a
// step exactly-once even when a tab and the worker both push the same run.
//
// Enabled with WORKER=1. Runs can resume from checkpoints after a restart.

import { randomUUID } from "node:crypto";
import type { Store, WorkerAccess } from "./store/types.ts";
import type { Logger, ServiceCtx } from "./services/context.ts";
import { advanceRun } from "./services/runs.ts";
import { advanceEvaluation } from "./services/evaluations.ts";
import { MAX_ACTIVE_STEPS, WORKER_INTERVAL_MS } from "./config.ts";

export interface WorkerHandle {
  stop(): Promise<void>;
  /** one scan-and-advance pass (exposed for tests) */
  tick(): Promise<number>;
}

export function startWorker(
  store: Store,
  log: Logger,
  opts: { intervalMs?: number; now?: () => Date; autoStart?: boolean } = {},
): WorkerHandle | null {
  const found = store.worker;
  if (!found) {
    log.warn("worker.unavailable", {
      reason: "store has no worker access",
    });
    return null;
  }
  const access: WorkerAccess = found;
  const busy = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const now = opts.now ?? (() => new Date());

  /** Drive one run until it waits, needs answers, or finishes. */
  async function drive(ownerId: string, projectId: string, runId: string): Promise<void> {
    const ctx: ServiceCtx = {
      store: access.forOwner(ownerId),
      user: { id: ownerId },
      now,
      log,
      requestId: `wk${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    };
    for (let i = 0; i < 1000 && !stopped; i++) {
      const res = await advanceRun(ctx, projectId, runId);
      if (res.waitMs || !["queued", "running"].includes(res.run.status)) return;
    }
  }

  async function tick(): Promise<number> {
    if (stopped) return 0;
    let runs: { ownerId: string; projectId: string; runId: string }[] = [];
    try {
      runs = await access.activeRuns();
    } catch (e) {
      log.warn("worker.scan_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
      return 0;
    }
    const evaluations = await access.activeEvaluations().catch((error: unknown) => {
      log.warn("worker.evaluation_scan_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return [];
    });
    const todo = [
      ...runs.map((r) => ({ ...r, evaluation: false })),
      ...evaluations.map((r) => ({ ...r, runId: r.evaluationId, evaluation: true })),
    ]
      .filter((r) => !busy.has(r.runId))
      .slice(0, Math.max(0, MAX_ACTIVE_STEPS - busy.size));
    await Promise.all(
      todo.map(async (r) => {
        busy.add(r.runId);
        try {
          if (r.evaluation) {
            const ctx: ServiceCtx = {
              store: access.forOwner(r.ownerId),
              user: { id: r.ownerId },
              now,
              log,
              requestId: `ev${randomUUID().replace(/-/g, "").slice(0, 14)}`,
            };
            await advanceEvaluation(ctx, r.projectId, r.runId);
          } else await drive(r.ownerId, r.projectId, r.runId);
        } catch (e) {
          log.warn("worker.run_failed", {
            projectId: r.projectId,
            runId: r.runId,
            error: e instanceof Error ? e.message.slice(0, 200) : "unknown",
          });
        } finally {
          busy.delete(r.runId);
        }
      }),
    );
    return todo.length;
  }

  const loop = async () => {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setTimeout(loop, opts.intervalMs ?? WORKER_INTERVAL_MS);
  };
  if (opts.autoStart !== false) {
    timer = setTimeout(loop, opts.intervalMs ?? WORKER_INTERVAL_MS);
    timer.unref?.();
    log.info("worker.started", { store: store.kind });
  }

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
