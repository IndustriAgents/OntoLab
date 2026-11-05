import type { GenerationTokenBudget } from "../types/research";

export const DEFAULT_CONTEXT_TOKENS = 100000;

/** Total generated-token allowance, including reasoning on thinking models. */
export function defaultOutputTokens(provider: string): number {
  return provider === "gemini" ? 16384 : provider === "ollama" ? 1024 : 4096;
}

export function geminiThinkingConfig(model: string, outputTokens: number) {
  if (/^gemini-3[.-]/.test(model)) return { thinkingLevel: "low" };
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: Math.min(1024, Math.max(128, Math.floor(outputTokens / 4))) };
  return undefined;
}
/** Shared planning defaults for corpus creation and document preparation. */
export function defaultGenerationBudget(provider: string, model: string): GenerationTokenBudget {
  return {
    provider,
    model,
    maxTokens: provider === "ollama" ? 1000 : 2000,
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    outputTokens: defaultOutputTokens(provider),
    promptReserveTokens: provider === "ollama" ? 2048 : 4096,
  };
}
