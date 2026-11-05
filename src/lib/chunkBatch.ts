import type { ProjectDocument } from "../types/project";
import type { ChunkExperiment, ChunkSettings } from "../types/research";
import type { api } from "./projectApi";
import { chunkSettingsKey } from "./research";

export interface ChunkBatchItem {
  document: ProjectDocument;
  phase: "waiting" | "preparing" | "ready" | "saving" | "saved" | "error";
  preview?: ChunkExperiment;
  saved?: ProjectDocument;
  error?: string;
}
type Actions = Pick<typeof api, "previewChunks" | "saveChunkVariant">;
type Progress = (items: ChunkBatchItem[]) => void;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function validChunkSettings(settings: ChunkSettings): boolean {
  const tokens = settings.tokens;
  const generation = tokens?.generation;
  return (
    Number.isInteger(settings.maxChars) &&
    settings.maxChars >= 200 &&
    settings.maxChars <= 60000 &&
    Number.isFinite(settings.overlap) &&
    settings.overlap >= 0 &&
    settings.overlap <= 0.3 &&
    (settings.unit !== "tokens" ||
      (!!tokens &&
        !!tokens.embedding.profile &&
        !!generation?.provider &&
        !!generation.model &&
        Number.isInteger(tokens.embedding.maxTokens) &&
        tokens.embedding.maxTokens >= 8 &&
        Number.isInteger(generation.maxTokens) &&
        generation.maxTokens >= 32 &&
        generation.maxTokens <= 60000 &&
        Number.isInteger(generation.contextTokens) &&
        generation.contextTokens > 0 &&
        Number.isInteger(generation.outputTokens) &&
        generation.outputTokens > 0 &&
        Number.isInteger(generation.promptReserveTokens) &&
        generation.promptReserveTokens >= 0 &&
        generation.maxTokens + generation.outputTokens + generation.promptReserveTokens <= generation.contextTokens))
  );
}

export function hasMatchingChunks(document: ProjectDocument, settings: ChunkSettings): boolean {
  return (
    document.parseState === "parsed" &&
    document.chunkCount > 0 &&
    !!document.preprocessing &&
    document.preprocessing.version === (settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1") &&
    chunkSettingsKey(document.preprocessing.settings) === chunkSettingsKey(settings)
  );
}

/** Continue past individual failures and retain successful previews on retry. */
export async function previewChunkBatch(
  pid: string,
  documents: ProjectDocument[],
  settings: ChunkSettings,
  actions: Actions,
  previous: ChunkBatchItem[] = [],
  onProgress: Progress = () => {},
): Promise<ChunkBatchItem[]> {
  const items: ChunkBatchItem[] = documents.map((document) => {
    const old = previous.find((item) => item.document.id === document.id);
    return old &&
      !old.error &&
      old.preview &&
      old.document.checksum === document.checksum &&
      old.document.parsing?.textHash === document.parsing?.textHash &&
      chunkSettingsKey(old.preview.settings) === chunkSettingsKey(settings)
      ? { ...old, document }
      : { document, phase: "waiting" };
  });
  onProgress([...items]);
  for (let i = 0; i < items.length; i++) {
    if (items[i].preview) continue;
    const document = items[i].document;
    items[i] = { document, phase: "preparing" };
    onProgress([...items]);
    try {
      if (document.parseState !== "parsed" || !document.charCount) throw new Error("This file needs readable parsed text before chunking.");
      const preview = await actions.previewChunks(pid, document.id, settings);
      items[i] = { document, preview, phase: "ready" };
    } catch (error) {
      items[i] = { document, phase: "error", error: message(error) };
    }
    onProgress([...items]);
  }
  return items;
}

/** Save each prepared file independently; retry skips already durable versions. */
export async function saveChunkBatch(
  pid: string,
  prepared: ChunkBatchItem[],
  actions: Actions,
  onProgress: Progress = () => {},
): Promise<ChunkBatchItem[]> {
  const items = [...prepared];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.saved || !item.preview) continue;
    items[i] = { ...item, phase: "saving", error: undefined };
    onProgress([...items]);
    try {
      const saved = await actions.saveChunkVariant(pid, item.document.id, item.preview.settings, item.preview.textHash);
      items[i] = { ...item, saved, phase: "saved", error: undefined };
    } catch (error) {
      items[i] = { ...item, phase: "error", error: message(error) };
    }
    onProgress([...items]);
  }
  return items;
}
