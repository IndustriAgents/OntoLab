import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerationTokenBudget } from "../../src/types/research.ts";
import { HttpError } from "../http.ts";
import { generationCounter } from "./tokenization.ts";
import { codexContextLimit, isCliProvider } from "../cli/catalog.ts";

export interface RequestTokenCheck {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  method: string;
  exact: boolean;
  providerInputTokens?: number;
  modelContextTokens?: number;
}
const active = new AsyncLocalStorage<{ budget: GenerationTokenBudget; checks: RequestTokenCheck[] }>();
export async function withGenerationBudget<T>(
  budget: GenerationTokenBudget | undefined,
  fn: () => Promise<T>,
): Promise<{ value: T; checks: RequestTokenCheck[] }> {
  if (!budget) return { value: await fn(), checks: [] };
  const state = { budget: { ...budget }, checks: [] as RequestTokenCheck[] };
  return active.run(state, async () => ({ value: await fn(), checks: state.checks }));
}
export function generationOutputTokens(fallback: number): number {
  return active.getStore()?.budget.outputTokens ?? fallback;
}
export function generationContextTokens(): number | undefined {
  return active.getStore()?.budget.contextTokens;
}

/** Validate the fully assembled wire request, including schemas and instructions, before model inference. */
export async function checkGenerationRequest(
  provider: string,
  model: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const state = active.getStore();
  if (!state) return;
  const b = state.budget;
  if (b.provider !== provider || b.model !== model)
    throw new HttpError(409, "Generation model changed. Reconfigure the token budgets for this model before running.");
  let inputTokens: number;
  let method: string;
  let exact = false;
  let providerInputTokens: number | undefined;
  const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  if (provider === "gemini" || provider === "claude") {
    const gemini = provider === "gemini";
    const url = gemini
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`
      : "https://api.anthropic.com/v1/messages/count_tokens";
    const headers: Record<string, string> = gemini
      ? { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" }
      : { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" };
    const { max_tokens: _max, ...claudePayload } = payload;
    const body = gemini ? { generateContentRequest: { model: `models/${model}`, ...payload } } : claudePayload;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch {
      throw new HttpError(503, "Could not validate the full request's token budget. Retry before generation.");
    }
    if (!res.ok) throw new HttpError(503, "The provider could not count the full request's tokens. Check the selected model and retry.");
    const count = (await res.json()) as { totalTokens?: number; input_tokens?: number };
    inputTokens = gemini ? count.totalTokens! : count.input_tokens!;
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new HttpError(503, "The provider returned an invalid token count.");
    method = `${provider} token-counting API`;
    exact = true;
    providerInputTokens = inputTokens;
    // Native response schemas may be omitted from the provider count. Reserve them explicitly.
    const schema = (payload.generationConfig as { responseSchema?: unknown } | undefined)?.responseSchema;
    if (gemini && schema) {
      inputTokens += Buffer.byteLength(JSON.stringify(schema), "utf8");
      method += " + conservative response-schema allowance";
      exact = false;
    }
  } else {
    const counter = generationCounter(provider, model);
    // Serialized payload accounts for messages, tools, JSON schema, and framing. Reserve protocol overhead too.
    inputTokens = counter.count(JSON.stringify(payload)) + 512;
    method = `${counter.id} + 512 protocol tokens (estimate)`;
    if (isCliProvider(provider)) {
      inputTokens += 8192;
      method += " + 8192 native CLI context allowance (estimate; CLI manages output limits)";
    }
  }
  const required = inputTokens + b.outputTokens;
  const limit = provider === "codex-cli" ? codexContextLimit(model) : undefined;
  const check = {
    provider,
    model,
    inputTokens,
    outputTokens: b.outputTokens,
    contextTokens: b.contextTokens,
    method,
    exact,
    ...(providerInputTokens !== undefined ? { providerInputTokens } : {}),
    ...(limit !== undefined ? { modelContextTokens: limit } : {}),
  };
  state.checks.push(check);
  if (required > b.contextTokens)
    throw new HttpError(
      413,
      `Full request needs ${inputTokens.toLocaleString()} input tokens plus ${b.outputTokens.toLocaleString()} reserved output tokens, exceeding the configured ${b.contextTokens.toLocaleString()} context budget. Reduce chunk size or ontology/context, or verify and increase the model's configured limit.`,
    );
  if (limit !== undefined && required > limit)
    throw new HttpError(
      413,
      `Full request needs ${required.toLocaleString()} tokens including reserved output, exceeding the model's reported ${limit.toLocaleString()} context capacity. Reduce chunk size or ontology/context, or select a model with a larger context window.`,
    );
}
