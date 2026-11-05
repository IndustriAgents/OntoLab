import { Parser, Store, Writer } from "n3";
import type { AlignmentMapping, RevisionContent } from "../../src/types/project.ts";
import type { AlignmentSetup, AlignmentDecision } from "../../src/types/alignment.ts";
import { ALIGNMENT_MODULE, alignmentKey, mappingIsCurrent } from "../../src/lib/alignment.ts";
import { HttpError } from "../http.ts";
import { mappingTurtle, type AlignmentResult } from "./alignment.ts";
import { newId } from "./context.ts";

export function parseAlignmentSetup(value: unknown, content: RevisionContent, ready = false): AlignmentSetup {
  if (!value || typeof value !== "object") throw new HttpError(400, "Comparison setup is required.");
  const input = value as Record<string, unknown>;
  const pick = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new HttpError(400, "Choose ontology modules.");
    return [
      ...new Set(
        value.map((id) => {
          const module = content.modules.find((m) => m.id === id || m.name === id);
          if (!module || module.name === ALIGNMENT_MODULE)
            throw new HttpError(400, "Choose existing ontology modules, excluding the alignment bridge.");
          return module.id;
        }),
      ),
    ];
  };
  const sourceModules = pick(input.sourceModules ?? []),
    targetModules = pick(input.targetModules ?? []);
  if (sourceModules.some((id) => targetModules.includes(id))) throw new HttpError(400, "Source and target module groups must be disjoint.");
  if (ready && (!sourceModules.length || !targetModules.length))
    throw new HttpError(400, "Pick at least one source module and one target module.");
  const rawMatchers = input.matchers as Record<string, unknown> | undefined;
  if (
    rawMatchers != null &&
    (typeof rawMatchers !== "object" ||
      ["lexical", "semantic", "structural"].some((key) => rawMatchers[key] !== undefined && typeof rawMatchers[key] !== "boolean"))
  )
    throw new HttpError(400, "Matching methods must be true or false.");
  const matchers = {
    lexical: rawMatchers?.lexical !== false,
    semantic: rawMatchers?.semantic !== false,
    structural: rawMatchers?.structural !== false,
  };
  if (ready && !matchers.lexical && !matchers.semantic) throw new HttpError(400, "Enable name or semantic matching to find candidates.");
  const maxSource = input.maxSource === null ? null : (input.maxSource ?? 150);
  if (maxSource !== null && (typeof maxSource !== "number" || !Number.isInteger(maxSource) || maxSource < 1 || maxSource > 10000))
    throw new HttpError(400, "Source limit must be 1–10,000, or null for every term.");
  const verify = input.verify === true;
  const provider = typeof input.provider === "string" ? input.provider.slice(0, 100) : undefined;
  const model = typeof input.model === "string" ? input.model.slice(0, 200) : undefined;
  if (ready && verify && !provider) throw new HttpError(400, "Choose a provider for relation classification.");
  return { sourceModules, targetModules, matchers, verify, provider, model, maxSource: maxSource as number | null };
}

/** Reconcile managed statements as a set. Preserve unrelated bridge RDF and all source modules. */
export function alignmentBridge(
  content: RevisionContent,
  before: AlignmentMapping[],
  after: AlignmentMapping[],
): RevisionContent["modules"] {
  const previous = before.filter((m) => m.status === "accepted");
  const accepted = after.filter((m) => m.status === "accepted");
  if (mappingTurtle(previous) === mappingTurtle(accepted)) return content.modules;
  const modules = [...content.modules];
  const at = modules.findIndex((m) => m.name === ALIGNMENT_MODULE);
  const store = new Store(at < 0 ? [] : new Parser().parse(modules[at].turtle));
  store.removeQuads(new Parser().parse(mappingTurtle(previous)));
  store.addQuads(new Parser().parse(mappingTurtle(accepted)));
  if (!store.size) return modules.filter((_, i) => i !== at);
  const turtle =
    "# OntoLab alignment — accepted correspondences\n\n" +
    new Writer({ format: "N-Triples" }).quadsToString(store.getQuads(null, null, null, null));
  if (at < 0) modules.push({ id: newId("mod"), name: ALIGNMENT_MODULE, turtle });
  else modules[at] = { ...modules[at], turtle };
  return modules;
}

/** Reconcile a comparison against its frozen input, preserving human decisions. */
export function alignedContent(
  content: RevisionContent,
  setup: AlignmentSetup,
  result: AlignmentResult,
  metadata: { at: string; durationMs: number; inputHash: string },
): RevisionContent {
  const { mappings, candidates, diagnostics, usage } = result;
  const { at, durationMs, inputHash } = metadata;
  const before = content.review?.alignment ?? [];
  const recordId = newId("align");
  const stableIds = new Map(before.map((m) => [alignmentKey(m), m.id]));
  const record = {
    id: recordId,
    createdAt: at,
    durationMs: durationMs,
    inputHash: inputHash,
    sourceModules: setup.sourceModules,
    targetModules: setup.targetModules,
    modules: content.modules.filter((m) => [...setup.sourceModules, ...setup.targetModules].includes(m.id)),
    provider: setup.verify ? (setup.provider ?? null) : null,
    model: setup.verify ? (setup.model ?? null) : null,
    diagnostics,
    candidates: candidates.map((c) => ({ ...c, id: stableIds.get(alignmentKey(c)) ?? c.id, runId: recordId })),
    usage,
    decisions: [],
  };
  const old = new Map(before.map((m) => [alignmentKey(m), m]));
  const events: AlignmentDecision[] = [];
  const alignment = mappings.map((m): AlignmentMapping => {
    const previous = old.get(alignmentKey(m));
    old.delete(alignmentKey(m));
    if (previous && mappingIsCurrent(previous, content) && (previous.humanReviewed || (previous.status && previous.status !== "open")))
      return { ...previous, runId: previous.runId ?? content.review?.alignmentRuns?.at(-1)?.id };
    const next = { ...m, id: previous?.id ?? m.id, runId: record.id };
    if (previous && !mappingIsCurrent(previous, content))
      events.push({ id: newId("ad"), at: at, action: "inputs_changed", mappingId: previous.id, before: previous, after: next });
    return next;
  });
  for (const previous of old.values()) {
    // Retain decisions and manually added alternatives, even if retrieval changes.
    if (!previous.humanReviewed && (!previous.status || previous.status === "open")) continue;
    const current = mappingIsCurrent(previous, content);
    const next: AlignmentMapping = current
      ? { ...previous, runId: previous.runId ?? content.review?.alignmentRuns?.at(-1)?.id }
      : { ...previous, status: "open", stale: true, conflict: undefined };
    alignment.push(next);
    if (!current) events.push({ id: newId("ad"), at: at, action: "inputs_changed", mappingId: previous.id, before: previous, after: next });
  }
  return {
    ...content,
    modules: alignmentBridge(content, before, alignment),
    review: {
      ...content.review,
      alignment,
      alignmentSetup: setup,
      alignmentRuns: [...(content.review?.alignmentRuns ?? []), record],
      alignmentDecisions: [...(content.review?.alignmentDecisions ?? []), ...events],
    },
  };
}
