import type { DocumentChunk, DocumentText } from "../../src/types/project.ts";
import type { ChunkSettings, TokenChunkSettings } from "../../src/types/research.ts";
import { generationCounter, embeddingCounter, embeddingProfile } from "../ml/tokenization.ts";
import { tokenSpans } from "../ml/tokenSplitting.ts";
import { chunkEmbeddingText } from "./vectorIndex.ts";
import { sectionPathAt } from "./chunking.ts";
import { HttpError } from "../http.ts";
import { isCliProvider } from "../cli/catalog.ts";

export function validateTokenSettings(t: TokenChunkSettings): TokenChunkSettings {
  if (!t?.embedding || !t.generation) throw new HttpError(400, "Select embedding and generation models before token chunking.");
  const profile = embeddingProfile(t.embedding.profile);
  if (!Number.isInteger(t.embedding.maxTokens) || t.embedding.maxTokens < 8 || t.embedding.maxTokens > profile.inputLimit)
    throw new HttpError(400, `Embedding passage budget must be 8–${profile.inputLimit} tokens.`);
  const g = t.generation;
  if (
    (!["openai", "claude", "gemini", "deepseek", "ollama", "mock"].includes(g.provider) && !isCliProvider(g.provider)) ||
    typeof g.model !== "string" ||
    !g.model ||
    g.model.length > 160
  )
    throw new HttpError(400, "Choose a generation provider and model.");
  for (const [key, min, max] of [
    ["maxTokens", 32, 60000],
    ["contextTokens", 256, 2_000_000],
    ["outputTokens", 1, 100000],
    ["promptReserveTokens", 0, 1_000_000],
  ] as const) {
    if (!Number.isInteger(g[key]) || g[key] < min || g[key] > max) throw new HttpError(400, `Invalid generation ${key} budget.`);
  }
  if (g.maxTokens + g.outputTokens + g.promptReserveTokens > g.contextTokens)
    throw new HttpError(400, "Chunk + prompt reserve + output reserve exceed the generation context budget.");
  return {
    embedding: { profile: profile.id, maxTokens: t.embedding.maxTokens },
    generation: {
      provider: g.provider,
      model: g.model,
      maxTokens: g.maxTokens,
      contextTokens: g.contextTokens,
      outputTokens: g.outputTokens,
      promptReserveTokens: g.promptReserveTokens,
    },
  };
}

export async function buildTokenChunks(data: Pick<DocumentText, "text" | "pages" | "sections">, settings: ChunkSettings) {
  const budgets = validateTokenSettings(settings.tokens!);
  const generation = generationCounter(budgets.generation.provider, budgets.generation.model);
  const embedding = await embeddingCounter(embeddingProfile(budgets.embedding.profile));
  if (embedding.inputLimit && budgets.embedding.maxTokens > embedding.inputLimit)
    throw new HttpError(400, `This tokenizer supports at most ${embedding.inputLimit} input tokens. Reduce the embedding passage budget.`);
  const spans = tokenSpans(data.text, generation, budgets.generation.maxTokens, {
    method: settings.method,
    overlap: settings.overlap,
    cuts: settings.method === "section" ? data.sections?.map((s) => s.start) : [],
  });
  const chunks = spans.map((span, ordinal) => {
    const text = data.text.slice(span.start, span.end);
    const sectionPath = sectionPathAt(data.sections ?? [], span.start);
    const embeddingText = chunkEmbeddingText({ text, sectionPath });
    const prefixLength = embeddingText.length - text.length;
    const passages = tokenSpans(embeddingText, embedding, budgets.embedding.maxTokens, { method: "paragraph" });
    const page = data.pages.find((p) => span.start >= p.start && span.start < p.end)?.page;
    const pageEnd = data.pages.find((p) => span.end - 1 >= p.start && span.end - 1 < p.end)?.page;
    return {
      ordinal,
      start: span.start,
      end: span.end,
      text,
      overlap: span.overlap,
      page,
      pageEnd,
      sectionPath,
      tokenization: {
        generation: { count: span.tokens, tokenizer: generation.id, exact: generation.exact, note: generation.note },
        embedding: { tokenizer: embedding.id, exact: embedding.exact },
        embeddingPassages: passages.map((p) => ({
          start: span.start + Math.max(0, p.start - prefixLength),
          end: span.start + Math.max(0, p.end - prefixLength),
          tokens: p.tokens,
        })),
      },
    } satisfies Omit<DocumentChunk, "id" | "documentId" | "projectId">;
  });
  return {
    chunks,
    tokenization: {
      generation: {
        count: chunks.reduce((n, c) => n + c.tokenization.generation.count, 0),
        tokenizer: generation.id,
        exact: generation.exact,
        note: generation.note,
      },
      embedding: {
        count: chunks.reduce((n, c) => n + c.tokenization.embeddingPassages.reduce((sum, p) => sum + p.tokens, 0), 0),
        tokenizer: embedding.id,
        exact: embedding.exact,
        note: embedding.note,
      },
      embeddingPassages: chunks.reduce((n, c) => n + c.tokenization.embeddingPassages.length, 0),
      fullCoverage: true,
    },
  };
}
