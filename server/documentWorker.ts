// Automatic document processing is independent of the optional extraction worker.
import { randomUUID } from "node:crypto";
import type { Store } from "./store/types.ts";
import { processDocument } from "./services/documents.ts";
import type { Logger, ServiceCtx } from "./services/context.ts";

export function startDocumentWorker(store: Store, log: Logger, opts: { autoStart?: boolean; intervalMs?: number; now?: () => Date } = {}) {
  const access = store.worker;
  if (!access?.pendingDocuments) return null;
  let stopped = false;
  let active: Promise<number> | null = null;
  let timer: NodeJS.Timeout | undefined;
  const tick = (): Promise<number> => {
    if (stopped) return Promise.resolve(0);
    if (active) return active;
    active = (async () => {
      let count = 0;
      for (const job of (await access.pendingDocuments!()).slice(0, 8)) {
        if (stopped) break;
        const ctx: ServiceCtx = {
          store: access.forOwner(job.ownerId),
          user: { id: job.ownerId },
          now: opts.now ?? (() => new Date()),
          log,
          requestId: `parse-${randomUUID()}`,
        };
        try {
          if (await processDocument(ctx, job.projectId, job.documentId)) count++;
        } catch (e) {
          log.warn("document.worker_failed", { documentId: job.documentId, error: e instanceof Error ? e.message : "Unknown error" });
        }
      }
      return count;
    })().finally(() => {
      active = null;
    });
    return active;
  };
  const loop = async () => {
    try {
      await tick();
    } catch {
      log.warn("document.queue_unavailable", {});
    }
    if (!stopped) {
      timer = setTimeout(loop, opts.intervalMs ?? 2000);
      timer.unref();
    }
  };
  if (opts.autoStart !== false) {
    timer = setTimeout(loop, 0);
    timer.unref();
  }
  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await active;
    },
  };
}
