import type { OntologyRevision, Project, ProjectDocument, RunOptions } from "../types/project";
import type { RunResearch } from "../types/research";
import { chunkSettingsKey } from "./research";
type Source = Pick<ProjectDocument, "id" | "variantOf" | "preprocessing">;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

function inductionOptions(options: Partial<RunOptions> = {}) {
  return {
    cqGuided: options.cqGuided ?? true,
    inductionAxioms: options.inductionAxioms ?? true,
    repair: options.repair ?? true,
    strictGrounding: options.strictGrounding ?? false,
    reasoningEffort: options.reasoningEffort ?? "default",
    tokenization: options.tokenization,
  };
}

/** Only reuse a completed build when its recorded inputs still match. Missing history is not a match. */
export function isUnchangedInductionBuild(
  previous: RunResearch | undefined,
  next: {
    documents: ProjectDocument[];
    starting: OntologyRevision | null | undefined;
    project: Project | undefined;
    provider: string;
    model: string;
    options: Partial<RunOptions>;
  },
): boolean {
  if (
    !previous?.inputs ||
    previous.run.kind !== "induction" ||
    previous.run.status !== "ready_for_review" ||
    !previous.run.resultRevisionId
  )
    return false;
  const { inputs, run } = previous;
  if (!next.project || next.starting === undefined || inputs.baseRevision === undefined) return false;
  if ((inputs.baseRevision?.contentHash ?? null) !== (next.starting?.contentHash ?? null)) return false;
  if (
    run.provider !== next.provider ||
    run.model !== next.model ||
    stable(inductionOptions(run.options)) !== stable(inductionOptions(next.options))
  )
    return false;
  const documentKey = (document: ResearchDocument) => ({
    id: document.id,
    checksum: document.checksum,
    parser: document.parser,
    parsing: document.parsing,
    charCount: document.charCount,
    chunkCount: document.chunkCount,
    settings: document.preprocessing?.settings,
  });
  const documentsKey = (documents: ResearchDocument[]) => stable(documents.map(documentKey).sort((a, b) => a.id.localeCompare(b.id)));
  if (!next.documents.length || documentsKey(inputs.documents) !== documentsKey(next.documents)) return false;
  return (
    next.options.cqGuided === false ||
    stable(inputs.requirements) ===
      stable({
        purpose: next.project.purpose,
        scope: next.project.scope,
        requirements: next.project.settings.requirements ?? null,
        competencyQuestions: next.project.competencyQuestions,
      })
  );
}

type ResearchDocument = NonNullable<RunResearch["inputs"]>["documents"][number];
/** Exact input membership is different from sharing an original source. */
export function buildSourceRelation(
  document: Pick<ProjectDocument, "id" | "variantOf">,
  previousIds: string[],
  sources: Pick<ProjectDocument, "id" | "variantOf">[],
) {
  if (previousIds.includes(document.id)) return "exact";
  const root = document.variantOf ?? document.id;
  return sources.some((d) => previousIds.includes(d.id) && (d.variantOf ?? d.id) === root) ? "related" : "other";
}
/** A new chunk variant is a reconfiguration of one source, not a new document. */
export function summarizeBuildSources(before: Source[], after: Source[]) {
  const old = new Map(before.map((d) => [d.variantOf ?? d.id, d]));
  const next = new Map(after.map((d) => [d.variantOf ?? d.id, d]));
  let reconfigured = 0;
  let embeddingChanged = 0;
  for (const [id, current] of next) {
    const previous = old.get(id);
    if (!previous) continue;
    const a = previous.preprocessing?.settings;
    const b = current.preprocessing?.settings;
    if (previous.id !== current.id || (a && b ? chunkSettingsKey(a) !== chunkSettingsKey(b) : a !== b)) reconfigured++;
    if (a?.tokens?.embedding.profile && b?.tokens?.embedding.profile && a.tokens.embedding.profile !== b.tokens.embedding.profile)
      embeddingChanged++;
  }
  return {
    added: [...next.keys()].filter((id) => !old.has(id)).length,
    removed: [...old.keys()].filter((id) => !next.has(id)).length,
    reconfigured,
    embeddingChanged,
  };
}
