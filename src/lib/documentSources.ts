import type { ProjectDocument } from "../types/project";
import { CHUNK_METHODS } from "./research";
import type { api } from "./projectApi";

type SourceRecord = Pick<ProjectDocument, "id" | "name" | "variantOf">;

export function sourceDocumentName(document: SourceRecord, documents: SourceRecord[] = []): string {
  if (!document.variantOf) return document.name;
  const original = documents.find((candidate) => candidate.id === document.variantOf);
  if (original) return original.name;
  const extension = /\.[a-z0-9]+$/i.exec(document.name)?.[0] ?? "";
  return document.name.slice(0, document.name.length - extension.length).replace(/ · experiment .+$/, "") + extension;
}

/** A saved preparation belongs under its uploaded source, even when the original entry was removed. */
export function groupSourceDocuments<T extends SourceRecord>(documents: T[]) {
  const families = new Map<string, T[]>();
  for (const document of documents) {
    const id = document.variantOf ?? document.id;
    const family = families.get(id) ?? [];
    family.push(document);
    families.set(id, family);
  }
  return [...families].map(([id, configurations]) => {
    const original = configurations.find((document) => document.id === id);
    const document = original ?? configurations[0];
    return { id, original, document, name: sourceDocumentName(document, documents), configurations };
  });
}

export function selectSourceConfiguration(
  selected: string[],
  documents: ProjectDocument[],
  sourceId: string,
  configurationId: string | null,
) {
  const siblings = new Set(documents.filter((document) => (document.variantOf ?? document.id) === sourceId).map((document) => document.id));
  if (configurationId && !siblings.has(configurationId)) return selected;
  const next = selected.filter((id) => !siblings.has(id));
  return configurationId && siblings.has(configurationId) ? [...next, configurationId] : next;
}

export function chunkConfigurationLabel(document: Pick<ProjectDocument, "chunkCount" | "preprocessing">): string {
  if (!document.chunkCount) return "Chunks not configured";
  const settings = document.preprocessing?.settings;
  if (!settings) return `${document.chunkCount} chunks · Historical settings unavailable`;
  const tokens = settings.unit === "tokens" ? settings.tokens : undefined;
  const method = CHUNK_METHODS[settings.method].name;
  const budget = tokens ? `${tokens.generation.maxTokens.toLocaleString()} tokens` : `${settings.maxChars.toLocaleString()} characters`;
  const providers: Record<string, string> = {
    "codex-cli": "Codex",
    "claude-cli": "Claude Code",
    "agy-cli": "Antigravity",
    gemini: "Gemini",
    openai: "OpenAI",
    claude: "Claude",
    deepseek: "DeepSeek",
    ollama: "Ollama",
    "openai-compatible": "OpenAI-compatible",
    mock: "Mock",
  };
  const model = tokens ? `${providers[tokens.generation.provider] ?? tokens.generation.provider} / ${tokens.generation.model} · ` : "";
  const embedding = tokens?.embedding?.profile ? `Embedding: ${tokens.embedding.profile} · ` : "";
  return `${model}${embedding}${method} · ${budget} · ${Math.round(settings.overlap * 100)}% overlap`;
}

export async function removeSourceDocuments(
  pid: string,
  ids: string[],
  actions: Pick<typeof api, "listRuns" | "removeDocument">,
): Promise<void> {
  const runs = await actions.listRuns(pid);
  if (runs.some((run) => ["queued", "running", "awaiting_answers"].includes(run.status) && run.documentIds.some((id) => ids.includes(id))))
    throw new Error("This document has a configuration used by an active run. Cancel the run before removing it.");
  for (const id of ids) await actions.removeDocument(pid, id);
}
