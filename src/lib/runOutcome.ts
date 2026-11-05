import type { OntologyRevision, RunView } from "../types/project";
export type RunOutcome =
  "processing" | "answers" | "failed" | "paused" | "cancelled" | "checking" | "draft" | "saved" | "missing" | "unavailable";
export function runOutcome(
  run: RunView,
  result?: Pick<OntologyRevision, "status">,
  resultState: "loading" | "missing" | "error" | "ready" = "ready",
): RunOutcome {
  if (run.status === "awaiting_answers") return "answers";
  if (run.status === "failed") return "failed";
  if (run.status === "paused") return "paused";
  if (run.status === "cancelled") return "cancelled";
  if (run.status !== "ready_for_review") return "processing";
  if (!run.resultRevisionId || resultState === "missing") return "missing";
  if (resultState === "loading") return "checking";
  if (resultState === "error") return "unavailable";
  return result?.status === "committed" ? "saved" : result?.status === "draft" ? "draft" : "missing";
}
export const outcomeCopy: Record<RunOutcome, { title: string; description: string }> = {
  processing: {
    title: "Processing your documents",
    description: "Follow progress below. Each completed step is saved as processing advances.",
  },
  answers: { title: "Your answers are needed", description: "Answer the questions below, or finish the questions to proceed to review." },
  failed: {
    title: "Processing needs attention",
    description: "Completed steps are saved. Resolve the issue below, then retry unfinished work.",
  },
  paused: {
    title: "Processing is paused",
    description: "No new steps will start. A step already in progress may finish saving. Resume when you’re ready.",
  },
  cancelled: { title: "Processing was cancelled", description: "Completed steps are retained. You can retry unfinished work." },
  checking: { title: "Checking the result", description: "Checking whether this result is still a draft or has been saved as a version." },
  draft: { title: "Your draft is ready to review", description: "Review the results and validate the draft before saving a version." },
  saved: {
    title: "The result is a saved version",
    description: "This result has already been saved. Open that version to inspect it; later versions may also exist.",
  },
  missing: {
    title: "The result is no longer available",
    description:
      "The result may have been discarded or removed, or this earlier activity did not record a result. Its recorded processing details remain available.",
  },
  unavailable: {
    title: "The result could not be checked",
    description: "The result’s current state is unavailable. Try loading it again; this does not change your saved work.",
  },
};
