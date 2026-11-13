import { executionSettings } from "./executionSettings.ts";
// Structured (tool-calling) provider layer. Every provider is asked for a JSON
// object matching a schema, and every response is checked for truncation before
// it is parsed — a model that hit its output cap used to yield a partial
// individuals array (or a raw SyntaxError) that looked like a successful,
// merely smaller, extraction.

import { checkGenerationRequest, generationOutputTokens, generationContextTokens } from "./ml/generationBudget.ts";
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractDoc } from "../src/types/abox.ts";
import type { ProviderId } from "./providers.ts";
import { postJson, parseModelJson, ProviderError, TruncatedOutputError } from "./providers.ts";
import { toGeminiSchema, toStrictSchema, type JsonSchema } from "./schemas.ts";
import { docsToText } from "./prompts.ts";
import { mockStructured } from "./mockLlm.ts";
import { MAX_OUTPUT_TOKENS } from "./config.ts";
import { geminiThinkingConfig } from "../src/lib/generationLimits.ts";
import { isCliProvider } from "./cli/catalog.ts";
import { callCli } from "./cli/invoke.ts";
import { customEndpoint, isCustomProvider } from "./customProviders.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface Parsed {
  data: Record<string, unknown>;
  usage: Usage;
}

export interface StructuredCall {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
  system: string;
  schema: JsonSchema;
  /** documents to attach (Claude gets native blocks, others get tagged text) */
  docs?: ExtractDoc[];
  /** extra user text appended after the documents */
  extra?: string;
  /** first line of the user turn */
  lead: string;
  toolName: string;
  toolDesc: string;
  signal?: AbortSignal;
}

const ZERO: Usage = { input_tokens: 0, output_tokens: 0 };

/**
 * Raised when a provider replies successfully but without the structured call
 * we forced. Models occasionally answer in prose despite a forced tool choice,
 * which is transient, so this is retried once before it reaches the user.
 */
class NoStructuredResultError extends ProviderError {
  constructor(label: string, detail?: string) {
    super(`${label} answered without the structured result${detail ? ` (${detail})` : ""}.`, 502, true);
    this.name = "NoStructuredResultError";
  }
}

async function dispatch(call: StructuredCall): Promise<Parsed> {
  if (isCliProvider(call.provider)) {
    if (call.docs?.some((doc) => doc.asVision && doc.pdfBase64))
      throw new ProviderError("CLI providers use parsed document text. Choose an API provider for PDF vision.", 400, false);
    return callCli({
      provider: call.provider,
      model: call.model,
      reasoningEffort: call.reasoningEffort,
      system: call.system,
      prompt: userText(call),
      schema: call.schema,
      signal: call.signal,
      outputTokens: generationOutputTokens(MAX_OUTPUT_TOKENS),
    });
  }
  if (isCustomProvider(call.provider)) {
    const custom = customEndpoint(call.provider);
    return callOpenAICompatible(call, custom.url, custom.apiKey, custom.label, false, true);
  }
  switch (call.provider) {
    case "claude":
      return callClaude(call);
    case "openai":
      return callOpenAICompatible(call, "https://api.openai.com/v1/chat/completions", process.env.OPENAI_API_KEY!, "OpenAI", true);
    case "deepseek":
      return callOpenAICompatible(call, "https://api.deepseek.com/chat/completions", process.env.DEEPSEEK_API_KEY!, "DeepSeek", false);
    case "gemini":
      return callGemini(call);
    case "ollama":
      return callOllama(call);
    case "mock":
      await checkGenerationRequest(
        call.provider,
        call.model,
        { system: call.system, lead: call.lead, docs: call.docs, extra: call.extra, schema: call.schema },
        call.signal,
      );
      return mockStructured(call);
    default:
      throw new ProviderError(`Unknown provider: ${call.provider}`, 400, false);
  }
}

export async function callStructured(call: StructuredCall): Promise<Parsed> {
  try {
    return await dispatch(call);
  } catch (e) {
    if (!(e instanceof NoStructuredResultError) || call.signal?.aborted) throw e;
    console.warn(`[${call.provider}] no structured result; retrying once`);
    return dispatch(call);
  }
}

/** User text for the non-Claude providers. */
function userText(call: StructuredCall): string {
  const docs = call.docs?.length ? docsToText(call.docs, call.lead) : call.lead;
  return call.extra ? `${docs}\n\n${call.extra}` : docs;
}

/* ───────────────────────── Claude ───────────────────────── */

function claudeContent(call: StructuredCall): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: call.lead }];
  for (const d of call.docs ?? []) {
    if (d.asVision && d.pdfBase64) {
      content.push({ type: "text", text: `\n<document name="${d.name}" type="pdf">` });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.pdfBase64 } });
      content.push({ type: "text", text: "</document>" });
    } else {
      content.push({ type: "text", text: `\n<document name="${d.name}">\n${d.text}\n</document>` });
    }
  }
  if (call.extra) content.push({ type: "text", text: `\n${call.extra}` });
  // Cache through the end of the documents: refine rounds resend the same docs,
  // and without a breakpoint here every round paid full price for them.
  const last = content[content.length - 1];
  if (last && (last.type === "text" || last.type === "document")) {
    content[content.length - 1] = { ...last, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  }
  return content;
}

async function callClaude(call: StructuredCall): Promise<Parsed> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not configured on the server.", 400, false);
  const client = new Anthropic({ apiKey, timeout: executionSettings().timeoutMs, maxRetries: 2 });
  const tool = { name: call.toolName, description: call.toolDesc, input_schema: call.schema as Anthropic.Tool.InputSchema };

  const payload: Anthropic.MessageCreateParamsNonStreaming = {
    model: call.model,
    max_tokens: generationOutputTokens(MAX_OUTPUT_TOKENS),
    system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
    tools: [tool],
    tool_choice: { type: "tool", name: call.toolName },
    messages: [{ role: "user", content: claudeContent(call) }],
  };
  await checkGenerationRequest(call.provider, call.model, payload as unknown as Record<string, unknown>, call.signal);
  let message: Anthropic.Message;
  try {
    message = await client.messages.stream(payload, { signal: call.signal }).finalMessage();
  } catch (e) {
    if (call.signal?.aborted) throw new ProviderError("Request cancelled.", 499, false);
    const status = (e as { status?: number }).status ?? 502;
    console.error(`[Claude] ${status} ${e instanceof Error ? e.message : e}`);
    if (status === 401 || status === 403) throw new ProviderError("Claude rejected the server's API key.", status, false);
    if (status === 429) throw new ProviderError("Claude is rate-limiting this key. Wait a moment and try again.", 429, false);
    throw new ProviderError(`Claude request failed (${status}).`, status, false);
  }

  if (message.stop_reason === "max_tokens") throw new TruncatedOutputError("Claude");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === call.toolName);
  if (!toolUse) throw new NoStructuredResultError("Claude", message.stop_reason ?? undefined);
  return {
    data: toolUse.input as Record<string, unknown>,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? undefined,
    },
  };
}

/* ───────────────────────── OpenAI-compatible ───────────────────────── */

/**
 * `generic` is a user-configured endpoint: the key is optional (local servers),
 * the older max_tokens parameter is used, and a JSON object in the message
 * content is accepted when the server ignores the forced tool call.
 */
async function callOpenAICompatible(
  call: StructuredCall,
  url: string,
  key: string,
  label: string,
  strict: boolean,
  generic = false,
): Promise<Parsed> {
  if (!key && !generic) throw new ProviderError(`${label} is not configured on the server.`, 400, false);
  const parameters = strict ? toStrictSchema(call.schema) : call.schema;
  const payload = {
    model: call.model,
    // Newer OpenAI models reject max_tokens in favour of max_completion_tokens.
    [generic ? "max_tokens" : "max_completion_tokens"]: generationOutputTokens(MAX_OUTPUT_TOKENS),
    temperature: 0,
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: userText(call) },
    ],
    tools: [
      { type: "function", function: { name: call.toolName, description: call.toolDesc, parameters, ...(strict ? { strict: true } : {}) } },
    ],
    tool_choice: { type: "function", function: { name: call.toolName } },
  };
  await checkGenerationRequest(call.provider, call.model, payload, call.signal);
  const data = (await postJson(url, payload, key ? { authorization: `Bearer ${key}` } : {}, { label, signal: call.signal })) as {
    choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { function?: { arguments?: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new TruncatedOutputError(label);
  const args = choice?.message?.tool_calls?.[0]?.function?.arguments || (generic ? jsonObjectText(choice?.message?.content) : undefined);
  if (!args) throw new NoStructuredResultError(label, choice?.finish_reason);
  return {
    data: parseModelJson(args, label),
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  };
}

/** The JSON object in a plain-text reply, with any Markdown fence removed. */
function jsonObjectText(content: string | null | undefined): string | undefined {
  const text = content
    ?.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return text?.startsWith("{") ? text : undefined;
}

/* ───────────────────────── Gemini ───────────────────────── */

async function callGemini(call: StructuredCall): Promise<Parsed> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError("GEMINI_API_KEY is not configured on the server.", 400, false);

  // Gemini uses responseSchema (native structured output) rather than a forced
  // function call: measured over repeated runs on the sample manual, forced
  // function calling returned MALFORMED_FUNCTION_CALL roughly 40% of the time on
  // long A-Boxes, while responseSchema completes reliably.
  //
  // The configured limit includes reasoning. Keep thinking bounded rather than
  // silently exceeding the user's output reserve.
  const outputLimit = generationOutputTokens(MAX_OUTPUT_TOKENS * 3);
  const thinkingConfig = geminiThinkingConfig(call.model, outputLimit);
  const payload = {
    system_instruction: { parts: [{ text: call.system }] },
    contents: [{ role: "user", parts: [{ text: userText(call) }] }],
    generationConfig: {
      maxOutputTokens: outputLimit,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      temperature: /^gemini-3[.-]/.test(call.model) ? 1 : 0,
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(call.schema),
    },
  };
  await checkGenerationRequest(call.provider, call.model, payload, call.signal);
  const data = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(call.model)}:generateContent`,
    payload,
    { "x-goog-api-key": key },
    { label: "Gemini", signal: call.signal },
  )) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };

  const candidate = data.candidates?.[0];
  const usage = {
    input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
  };
  if (candidate?.finishReason === "MAX_TOKENS") throw new TruncatedOutputError("Gemini", usage, outputLimit);
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !(p as { thought?: boolean }).thought)
    .map((p) => p.text ?? "")
    .join("");
  if (!text.trim()) throw new NoStructuredResultError("Gemini", candidate?.finishReason);
  return {
    data: parseModelJson(text, "Gemini"),
    usage,
  };
}

/* ───────────────────────── Ollama ───────────────────────── */

async function callOllama(call: StructuredCall): Promise<Parsed> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) throw new ProviderError("OLLAMA_BASE_URL is not configured on the server.", 400, false);
  const payload = {
    model: call.model,
    stream: false,
    format: call.schema,
    options: {
      temperature: 0,
      num_predict: generationOutputTokens(MAX_OUTPUT_TOKENS),
      ...(generationContextTokens() ? { num_ctx: generationContextTokens() } : {}),
    },
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: userText(call) },
    ],
  };
  await checkGenerationRequest(call.provider, call.model, payload, call.signal);
  const data = (await postJson(`${base}/api/chat`, payload, {}, { label: "Ollama", signal: call.signal })) as {
    message?: { content?: string };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  if (data.done_reason === "length") throw new TruncatedOutputError("Ollama");
  const content = data.message?.content;
  if (!content) throw new NoStructuredResultError("Ollama", data.done_reason);
  return {
    data: parseModelJson(content, "Ollama"),
    usage: { input_tokens: data.prompt_eval_count ?? 0, output_tokens: data.eval_count ?? 0 },
  };
}

export { ZERO as ZERO_USAGE };
