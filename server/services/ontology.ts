// Revision-content helpers: the merged T-Box of a revision (cached — parsing a
// large modular ontology is not free), content hashing and statistics.

import { createHash } from "node:crypto";
import type { TBoxModel } from "../../src/types/tbox.ts";
import type { OntologyRevision, RevisionContent } from "../../src/types/project.ts";
import { parseTBox, mergeTBox } from "../../src/lib/ontology/tboxParser.ts";
import { assertionCount } from "../../src/lib/ontology/aboxMerge.ts";
import { effectiveAbox, withoutReviews, listFacts, type ReviewPolicy } from "../../src/lib/ontology/factReview.ts";
import type { ABoxResult } from "../../src/types/abox.ts";
import type { Project } from "../../src/types/project.ts";
import { HttpError } from "../http.ts";

export function contentHash(content: RevisionContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}

const tboxCache = new Map<string, TBoxModel>();

/** Parse + merge a revision's modules. Throws 422 when no module parses. */
export function tboxOf(content: RevisionContent): TBoxModel {
  const key = createHash("sha256")
    .update(content.modules.map((m) => m.turtle).join("\u0000"))
    .update(content.baseIri ?? "")
    .digest("hex");
  const hit = tboxCache.get(key);
  if (hit) return hit;
  const models: TBoxModel[] = [];
  for (const m of content.modules) {
    try {
      models.push(parseTBox(m.turtle));
    } catch {
      /* invalid modules are reported by ontology validation, not here */
    }
  }
  if (!models.length) throw new HttpError(422, "This revision has no parseable T-Box module. Import or author the ontology first.");
  const merged = mergeTBox(models, content.baseIri || undefined);
  tboxCache.set(key, merged);
  if (tboxCache.size > 50) tboxCache.delete(tboxCache.keys().next().value!);
  return merged;
}

/** Hash of the T-Box half (modules + base IRI): changes only when the schema changes. */
export function tboxHash(content: RevisionContent): string {
  return createHash("sha256")
    .update(JSON.stringify(content.modules.map((m) => [m.name, m.turtle])))
    .update(content.baseIri ?? "")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Hash of the A-Box half: changes only when individuals or their claims change.
 * Taken over the graph without rejected facts and without review metadata, so
 * accepting a candidate is not a new A-Box version but rejecting a fact is.
 */
export function aboxHash(content: RevisionContent): string {
  const abox = content.abox ? withoutReviews(effectiveAbox(content.abox, content.corpus ? "accepted-only" : "exclude-rejected")) : null;
  return createHash("sha256")
    .update(JSON.stringify(abox?.individuals ?? []))
    .digest("hex")
    .slice(0, 16);
}

/** The project's review policy (rejected facts are left out unless it says otherwise). */
export const reviewPolicyOf = (project: Pick<Project, "settings"> | null | undefined): ReviewPolicy =>
  project?.settings.reviewPolicy ?? "exclude-rejected";

/** The A-Box the graph is made of under a review policy. */
export function graphAbox(content: RevisionContent, policy: ReviewPolicy = "exclude-rejected"): ABoxResult {
  return content.abox ? effectiveAbox(content.abox, content.corpus ? "accepted-only" : policy) : { individuals: [] };
}

/** Cache key of a revision's query graph under a policy (the default keeps the plain key). */
export const graphKey = (contentHash: string, policy: ReviewPolicy = "exclude-rejected") =>
  policy === "exclude-rejected" ? `rev:${contentHash}` : `rev:${contentHash}:${policy}`;

export function contentStats(content: RevisionContent): OntologyRevision["stats"] {
  let classes = 0;
  try {
    classes = content.modules.length ? tboxOf(content).classes.length : 0;
  } catch {
    classes = 0;
  }
  return {
    modules: content.modules.length,
    classes,
    individuals: content.abox?.individuals.length ?? 0,
    assertions: assertionCount(content.abox),
    tboxHash: tboxHash(content),
    aboxHash: aboxHash(content),
    ...(content.corpus
      ? {
          acceptedIndividuals: graphAbox(content).individuals.length,
          acceptedAssertions: assertionCount(graphAbox(content)),
          candidateFacts: content.abox ? listFacts(content.abox).filter((f) => f.status === "candidate").length : 0,
        }
      : {}),
  };
}

export function mergedModulesTurtle(content: RevisionContent): string {
  return content.modules.map((m) => `# ── ${m.name} ──\n${m.turtle}`).join("\n\n");
}
