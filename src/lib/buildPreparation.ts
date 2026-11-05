import type { ProjectDocument } from "../types/project";
import type { GenerationTokenBudget } from "../types/research";
import type { api } from "./projectApi";

export type GenerationModelChoice = Pick<GenerationTokenBudget, "provider" | "model"> & { reasoningEffort?: string };

export function documentsNeedingModel(documents: ProjectDocument[], choice: GenerationModelChoice): ProjectDocument[] {
  return documents.filter((document) => {
    const settings = document.preprocessing?.settings;
    const saved = settings?.tokens?.generation;
    return settings?.unit === "tokens" && saved && (saved.provider !== choice.provider || saved.model !== choice.model);
  });
}

export function savedGenerationModel(documents: ProjectDocument[]): GenerationModelChoice | undefined {
  const choices = documents.flatMap((document) => {
    const settings = document.preprocessing?.settings;
    return settings?.unit === "tokens" && settings.tokens ? [settings.tokens.generation] : [];
  });
  const first = choices[0];
  if (first && choices.every((choice) => choice.provider === first.provider && choice.model === first.model))
    return { provider: first.provider, model: first.model };
}

/** Preview and save all affected inputs before switching the build to their new configurations. */
export async function prepareChunksForModel(
  pid: string,
  documents: ProjectDocument[],
  choice: GenerationModelChoice,
  actions: Pick<typeof api, "previewChunks" | "saveChunkVariant">,
): Promise<ProjectDocument[]> {
  const affected = new Set(documentsNeedingModel(documents, choice).map((document) => document.id));
  const prepared: ProjectDocument[] = [];
  for (const document of documents) {
    if (!affected.has(document.id)) {
      prepared.push(document);
      continue;
    }
    const previous = document.preprocessing!.settings;
    const settings = {
      ...previous,
      tokens: { ...previous.tokens!, generation: { ...previous.tokens!.generation, provider: choice.provider, model: choice.model } },
    };
    try {
      const preview = await actions.previewChunks(pid, document.id, settings);
      prepared.push(await actions.saveChunkVariant(pid, document.id, preview.settings, preview.textHash));
    } catch (error) {
      throw new Error(`${document.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return prepared;
}
