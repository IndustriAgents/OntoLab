// Model prices for cost estimates and budgets (B9). Prices change; this table
// is an approximation by model family, and PRICING_JSON overrides it per model
// ({"model-id": {"input": usdPerMillionTokens, "output": usdPerMillionTokens}}).
// Every figure the UI shows from here is labelled an estimate.

import { PRICING_JSON } from "../config.ts";

export interface Price {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
}

/** First match wins; patterns are tested against "<provider>/<model>". */
const FAMILY_PRICES: [RegExp, Price][] = [
  [/^(mock|ollama)\//, { input: 0, output: 0 }],
  [/claude-.*opus/, { input: 5, output: 25 }],
  [/claude-.*sonnet/, { input: 3, output: 15 }],
  [/claude-.*haiku/, { input: 1, output: 5 }],
  [/gpt-4\.1-nano/, { input: 0.1, output: 0.4 }],
  [/gpt-4\.1-mini/, { input: 0.4, output: 1.6 }],
  [/gpt-4\.1/, { input: 2, output: 8 }],
  [/gpt-4o-mini/, { input: 0.15, output: 0.6 }],
  [/gpt-4o/, { input: 2.5, output: 10 }],
  [/gemini-.*flash-lite/, { input: 0.1, output: 0.4 }],
  [/gemini-2\.5-flash/, { input: 0.3, output: 2.5 }],
  [/gemini-.*flash/, { input: 0.5, output: 3 }],
  [/gemini-2\.5-pro/, { input: 1.25, output: 10 }],
  [/gemini-.*pro/, { input: 2, output: 12 }],
  [/deepseek-/, { input: 0.27, output: 1.1 }],
];

let overrides: Record<string, Price> | null = null;
function parsedOverrides(): Record<string, Price> {
  if (overrides) return overrides;
  overrides = {};
  if (PRICING_JSON) {
    try {
      const raw = JSON.parse(PRICING_JSON) as Record<string, Partial<Price>>;
      for (const [k, v] of Object.entries(raw))
        if (typeof v?.input === "number" && typeof v?.output === "number") overrides[k] = { input: v.input, output: v.output };
    } catch {
      console.warn("[pricing] PRICING_JSON is not valid JSON; using the built-in table");
    }
  }
  return overrides;
}

/** The price of a model, or null when it is unknown (the estimate then reports tokens only). */
export function priceOf(provider: string, model: string): Price | null {
  const o = parsedOverrides();
  if (o[model]) return o[model];
  if (o[`${provider}/${model}`]) return o[`${provider}/${model}`];
  // CLI account usage is not an API invoice. Never apply API family prices to subscriptions.
  if (provider.endsWith("-cli")) return null;
  const key = `${provider}/${model}`;
  return FAMILY_PRICES.find(([re]) => re.test(key))?.[1] ?? null;
}

export function costUsd(provider: string, model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const p = priceOf(provider, model);
  if (!p) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1e6;
}

/** Characters → tokens, the usual ~4 characters per token for English prose. */
export const tokensOf = (chars: number) => Math.ceil(chars / 4);

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
