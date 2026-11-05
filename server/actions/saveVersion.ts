import type { ServiceCtx } from "../services/context.ts";
import { requireProject } from "../services/projects.ts";
import { requireRevision, commitRevision } from "../services/revisions.ts";
import { factQueue } from "../services/review.ts";
import { assertCommittable, validateRevision } from "../services/validation.ts";
import { HttpError } from "../http.ts";

/** All user entry points apply the same review and validation gate. */
export async function saveVersion(
  ctx: ServiceCtx,
  pid: string,
  rid: string,
  opts: { expectedHash?: string; acknowledged?: boolean; acknowledgedWarnings?: boolean } = {},
) {
  const rev = await requireRevision(ctx, pid, rid);
  if (opts.expectedHash && rev.contentHash !== opts.expectedHash)
    throw new HttpError(409, "The draft changed. Review the latest changes before saving a version.");
  const project = await requireProject(ctx, pid);
  if (project.settings.reviewPolicy === "accepted-only" && !opts.acknowledged) {
    const { counts } = await factQueue(ctx, pid, rid, "candidate", 1);
    if (counts.candidate)
      throw new HttpError(
        409,
        `${counts.candidate} facts are still waiting for review and will be left out of the graph. Review them, or confirm the commit.`,
      );
  }
  await assertCommittable(ctx, pid, rid, opts);
  // Atomically check the content that was validated, including edits made while checks ran.
  const revision = await commitRevision(ctx, pid, rid, ctx.store.revisionPreconditions ? rev.contentHash : opts.expectedHash);
  const report = await validateRevision(ctx, pid, rid, project.settings.savedQueries ?? []).catch(() => null);
  return { revision, report };
}
