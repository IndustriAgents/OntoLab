import type { GenerationTokenBudget } from "../../src/types/research.ts";
import type { ExtractDoc } from "../../src/types/abox.ts";
import { callStructured, type StructuredCall, type Usage } from "../structured.ts";
import { TruncatedOutputError } from "../providers.ts";
import { HttpError } from "../http.ts";
import { generationCounter, byteCounter } from "../ml/tokenization.ts";
import { tokenSpans } from "../ml/tokenSplitting.ts";

const MAX_SOURCE_TOKENS = 12000;
const MAX_SOURCE_CHUNKS = 8;

/** Output demand grows with source size even when the entire topic fits the context window. */
export function topicSourceBudget(budget?: GenerationTokenBudget) {
  const available = budget ? budget.contextTokens - budget.outputTokens - budget.promptReserveTokens : MAX_SOURCE_TOKENS;
  return Math.min(MAX_SOURCE_TOKENS, available, budget ? budget.outputTokens * 2 : MAX_SOURCE_TOKENS);
}

export function topicBatches<T extends { text: string }>(sources: T[], budget?: GenerationTokenBudget): T[][] {
  const limit = topicSourceBudget(budget);
  if (limit < 8)
    throw new HttpError(413, "The generation budget leaves no room for topic text. Increase the context limit or reduce the reserves.");
  const counter = budget ? generationCounter(budget.provider, budget.model) : byteCounter;
  const batches: T[][] = [];
  let batch: T[] = [];
  let used = 0;
  for (const source of sources) {
    const size = counter.count(source.text);
    if (batch.length && (used + size > limit || batch.length >= MAX_SOURCE_CHUNKS)) {
      batches.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(source);
    used += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Preserve every source span; only complete structured responses enter the combined result. */
export async function generateTopic(call: StructuredCall, budget?: GenerationTokenBudget) {
  const counter = budget ? generationCounter(budget.provider, budget.model) : byteCounter;
  const limit = topicSourceBudget(budget);
  if (limit < 8) throw new HttpError(413, "The generation budget leaves no room for topic text.");
  const docs = (call.docs ?? []).flatMap((doc) =>
    counter.count(doc.text) <= limit
      ? [doc]
      : tokenSpans(doc.text, counter, limit).map((span) => ({ ...doc, text: doc.text.slice(span.start, span.end) })),
  );
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const data: Record<string, unknown[]> = {};
  const calls: { sourceChars: number; sources: number; status: "complete" | "truncated" }[] = [];
  const addUsage = (value?: { input_tokens: number; output_tokens: number }) => {
    usage.input_tokens += value?.input_tokens ?? 0;
    usage.output_tokens += value?.output_tokens ?? 0;
  };
  const generate = async (batch: ExtractDoc[], depth = 0): Promise<void> => {
    if (call.signal?.aborted) throw call.signal.reason;
    if (calls.length >= 64) throw new HttpError(413, "Topic generation still exceeds its output budget after splitting. Increase the output reserve before retrying.");
    const record = {
      sourceChars: batch.reduce((n, doc) => n + doc.text.length, 0),
      sources: batch.length,
      status: "complete" as "complete" | "truncated",
    };
    calls.push(record);
    try {
      const result = await callStructured({ ...call, docs: batch });
      addUsage(result.usage);
      for (const [key, value] of Object.entries(result.data)) {
        if (!Array.isArray(value)) throw new HttpError(502, "The topic generation response did not contain the expected result arrays.");
        (data[key] ??= []).push(...value);
      }
    } catch (error) {
      if (!(error instanceof TruncatedOutputError)) throw error;
      record.status = "truncated";
      addUsage(error.usage);
      if (depth >= 6 || call.signal?.aborted) throw error;
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await generate(batch.slice(0, middle), depth + 1);
        await generate(batch.slice(middle), depth + 1);
      } else {
        const doc = batch[0];
        const halfBudget = Math.floor(counter.count(doc.text) / 2);
        if (halfBudget < 128) throw error;
        const spans = tokenSpans(doc.text, counter, halfBudget);
        if (spans.length < 2) throw error;
        for (const span of spans) await generate([{ ...doc, text: doc.text.slice(span.start, span.end) }], depth + 1);
      }
    }
  };
  try {
    for (const batch of topicBatches(docs, budget)) await generate(batch);
  } catch (error) {
    // Include successful subcalls and failed generations if a later subcall cannot recover.
    if (error instanceof Error) Object.assign(error, { usage: { ...usage } });
    throw error;
  }
  return { data, usage, calls };
}
