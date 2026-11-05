import type { RunStatus } from "../../types/project";
import { StatusBadge, type Tone } from "../../components/ui/ui";

const LABEL: Record<RunStatus, [string, Tone]> = {
  paused: ["Paused", "warn"],
  queued: ["Queued", "info"],
  running: ["Running", "info"],
  awaiting_answers: ["Needs answers", "warn"],
  ready_for_review: ["Finished", "ok"],
  failed: ["Failed", "alert"],
  cancelled: ["Cancelled", "muted"],
};

export function RunStatusBadge({ status, resumable }: { status: RunStatus; resumable?: boolean }) {
  if (resumable) return <StatusBadge tone="warn">Interrupted</StatusBadge>;
  const [label, tone] = LABEL[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
