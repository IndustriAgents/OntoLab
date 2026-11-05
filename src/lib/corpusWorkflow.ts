import type { CorpusPlan } from "../types/corpus";

/** Describe the work the actual plan will perform, including explicit reprocessing. */
export function corpusPlanSummary(plan: CorpusPlan): string {
  const process = new Set(plan.processDocumentIds);
  const sources = plan.sources.filter((s) => s.document && process.has(s.document.id));
  const added = sources.filter((s) => !s.previous).length;
  const replaced = sources.filter((s) => s.previous && s.previous.checksum !== s.document?.checksum).length;
  const updated = sources.length - added - replaced;
  const removed = plan.sources.filter((s) => s.status === "removal-pending").length;
  const parts = [
    added ? `${added} new document${added === 1 ? "" : "s"}` : "",
    replaced ? `${replaced} replacement${replaced === 1 ? "" : "s"}` : "",
    updated ? `${updated} document${updated === 1 ? "" : "s"} to reprocess` : "",
    removed ? `${removed} removal${removed === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(" · ")}. ${plan.reused} unchanged document${plan.reused === 1 ? "" : "s"} reused.`
    : "No document changes to process.";
}

export const corpusRunStage = (kind: string | undefined) =>
  kind === "summary" ? "Reading documents" : kind === "chunk" || kind === "vision" ? "Finding facts" : "Checking graph changes";
