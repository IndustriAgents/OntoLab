import type { AlignmentMapping, RevisionContent } from "../types/project";
import type { AlignmentSetup } from "../types/alignment";
import type { AlignmentRecord } from "../types/transparency";

export const ALIGNMENT_MODULE = "alignment.ttl";
export const alignmentKey = (mapping: Pick<AlignmentMapping, "source" | "target" | "kind">) =>
  JSON.stringify([mapping.source, mapping.target, mapping.kind]);

/** Labels read from source to target; stored broader/narrower describe the target. */
export const ALIGNMENT_RELATIONS: Record<AlignmentMapping["relation"], string> = {
  equivalent: "has the same meaning as",
  broader: "is narrower than",
  narrower: "is broader than",
  related: "is related to",
  candidate: "is similar to",
  unrelated: "is unrelated to",
};

export const ALIGNMENT_STATUSES = { open: "Needs review", accepted: "Accepted", dismissed: "Rejected", deferred: "Deferred" };

export function comparisonIsCurrent(record: AlignmentRecord, content: RevisionContent): boolean {
  return record.modules.every((input) => content.modules.some((m) => m.id === input.id && m.turtle === input.turtle));
}

export function mappingIsCurrent(mapping: AlignmentMapping, content: RevisionContent): boolean {
  if (mapping.stale) return false;
  const records = content.review?.alignmentRuns ?? [];
  const record = mapping.runId ? records.find((r) => r.id === mapping.runId) : records.at(-1);
  return record ? comparisonIsCurrent(record, content) : !mapping.runId;
}

export function alignmentSetup(content: RevisionContent): AlignmentSetup {
  if (content.review?.alignmentSetup) return content.review.alignmentSetup;
  const last = content.review?.alignmentRuns?.at(-1);
  const standards = content.modules.filter((m) => m.name !== ALIGNMENT_MODULE);
  return {
    sourceModules: last?.sourceModules ?? standards.slice(0, 1).map((m) => m.id),
    targetModules: last?.targetModules ?? standards.slice(1).map((m) => m.id),
    matchers: last?.diagnostics.matchers ?? { lexical: true, semantic: true, structural: true },
    verify: !!last?.provider,
    provider: last?.provider ?? undefined,
    model: last?.model ?? undefined,
    maxSource: last ? last.diagnostics.parameters.maxSource : 150,
  };
}

export function mappingStatement(mapping: Pick<AlignmentMapping, "source" | "target" | "relation" | "kind">): string | null {
  const { source, target, relation, kind } = mapping;
  if (relation === "unrelated") return null;
  const predicate =
    relation === "equivalent"
      ? `owl:equivalent${kind === "class" ? "Class" : "Property"}`
      : relation === "candidate"
        ? "skos:closeMatch"
        : relation === "related"
          ? "skos:relatedMatch"
          : `rdfs:sub${kind === "class" ? "Class" : "Property"}Of`;
  return relation === "narrower" ? `<${target}> ${predicate} <${source}> .` : `<${source}> ${predicate} <${target}> .`;
}
