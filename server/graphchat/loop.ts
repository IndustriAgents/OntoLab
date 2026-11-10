// The graph-chat tool loop, one implementation per provider wire format:
// Anthropic Messages, OpenAI-compatible chat completions (OpenAI, DeepSeek,
// Ollama), Gemini generateContent, and the offline mock. Each round sends the
// whole exchange, runs the tool calls the model makes, and stops when the
// model answers without calling a tool (or the round budget is spent).
//
// Calls go through postJson like every other provider call in OntoLab, so
// timeouts, retries and error messages behave the same.

import type { AgentUsage, ChatEvent } from "../../src/types/graphChat.ts";
import { HttpError } from "../http.ts";
import { postJson, type ChatMessage, type ProviderId } from "../providers.ts";
import type { LlmTool } from "./backend.ts";
import { isCliProvider } from "../cli/catalog.ts";
import { customEndpoint, isCustomProvider } from "../customProviders.ts";
import { runCliLoop } from "./cliLoop.ts";

export interface LoopArgs {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
  system: string;
  /** earlier turns of the conversation, as plain text */
  history: ChatMessage[];
  message: string;
  tools: LlmTool[];
  exec: (callId: string, name: string, input: unknown) => Promise<{ content: string; isError: boolean }>;
  emit: (e: ChatEvent) => void;
  signal: AbortSignal;
  maxRounds: number;
}

export interface LoopResult {
  text: string;
  model: string;
  usage: AgentUsage;
}

const MAX_TOKENS = 8192;
const OLLAMA_BASE = () => (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");

export const graphLoopImplementation = () =>
  [runClaude, runOpenAICompatible, runGemini, runMock, runCliLoop, runTools].map((fn) => fn.toString());

export function runLoop(args: LoopArgs): Promise<LoopResult> {
  if (isCliProvider(args.provider)) return runCliLoop({ ...args, provider: args.provider });
  if (isCustomProvider(args.provider)) {
    const custom = customEndpoint(args.provider);
    return runOpenAICompatible(args, custom.url, custom.apiKey, custom.label, "max_tokens");
  }
  switch (args.provider) {
    case "claude":
      return runClaude(args);
    case "openai":
      return runOpenAICompatible(args, "https://api.openai.com/v1/chat/completions", process.env.OPENAI_API_KEY ?? "", "OpenAI");
    case "deepseek":
      return runOpenAICompatible(args, "https://api.deepseek.com/chat/completions", process.env.DEEPSEEK_API_KEY ?? "", "DeepSeek");
    case "ollama":
      return runOpenAICompatible(args, `${OLLAMA_BASE()}/v1/chat/completions`, "", "Ollama");
    case "gemini":
      return runGemini(args);
    case "mock":
      return runMock(args);
    default:
      throw new HttpError(400, `Unknown provider: ${args.provider as string}`);
  }
}

const runTools = (calls: { id: string; name: string; input: unknown }[], exec: LoopArgs["exec"]) =>
  Promise.all(calls.map(async (c) => ({ id: c.id, name: c.name, ...(await exec(c.id, c.name, c.input)) })));

/* ───────────────────────── Anthropic ───────────────────────── */

type ClaudeBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };

async function runClaude({ model, system, history, message, tools, exec, emit, signal, maxRounds }: LoopArgs): Promise<LoopResult> {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const usage = { input: 0, output: 0, cacheRead: 0 };
  for (let round = 0; ; round++) {
    const last = round >= maxRounds;
    const data = (await postJson(
      "https://api.anthropic.com/v1/messages",
      {
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: apiTools,
        tool_choice: last ? { type: "none" } : { type: "auto" },
        messages,
      },
      { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
      { label: "Claude", signal },
    )) as {
      content?: ClaudeBlock[];
      stop_reason?: string;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    usage.input +=
      (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0) + (data.usage?.cache_creation_input_tokens ?? 0);
    usage.output += data.usage?.output_tokens ?? 0;
    usage.cacheRead += data.usage?.cache_read_input_tokens ?? 0;
    const content = data.content ?? [];
    if (data.stop_reason === "refusal") throw new HttpError(422, "The model declined this request. Try rephrasing the question.");
    for (const b of content) if (b.type === "thinking" && b.thinking) emit({ type: "thinking", text: b.thinking });
    const text = content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("");
    if (text) emit({ type: "text", text });
    const calls = content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content });
    if (!calls.length) {
      emit({ type: "round_end", hadTools: false });
      return { text, model: data.model ?? model, usage };
    }
    if (data.stop_reason === "max_tokens") throw new HttpError(502, "The model's tool call was cut off. Please ask again.");
    emit({ type: "round_end", hadTools: true });
    const results = await runTools(
      calls.map((c) => ({ id: c.id!, name: c.name!, input: c.input })),
      exec,
    );
    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }
}

/* ───────────────────────── OpenAI-compatible ───────────────────────── */

interface OaiMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning_content?: string;
}

async function runOpenAICompatible(
  { model, system, history, message, tools, exec, emit, signal, maxRounds }: LoopArgs,
  url: string,
  key: string,
  label: string,
  tokenParam = label === "OpenAI" ? "max_completion_tokens" : "max_tokens",
): Promise<LoopResult> {
  const messages: OaiMessage[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];
  const apiTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const usage = { input: 0, output: 0 };
  for (let round = 0; ; round++) {
    const last = round >= maxRounds;
    const data = (await postJson(
      url,
      {
        model,
        messages,
        tools: apiTools,
        tool_choice: last ? "none" : "auto",
        [tokenParam]: MAX_TOKENS,
      },
      key ? { authorization: `Bearer ${key}` } : {},
      { label, signal },
    )) as {
      model?: string;
      choices?: { message?: OaiMessage; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage.input += data.usage?.prompt_tokens ?? 0;
    usage.output += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message ?? { role: "assistant", content: "" };
    if (msg.reasoning_content) emit({ type: "thinking", text: msg.reasoning_content });
    const text = msg.content ?? "";
    if (text) emit({ type: "text", text });
    const calls = msg.tool_calls ?? [];
    // reasoning_content must not be sent back (DeepSeek rejects it)
    messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      emit({ type: "round_end", hadTools: false });
      return { text, model: data.model ?? model, usage };
    }
    emit({ type: "round_end", hadTools: true });
    const results = await runTools(
      calls.map((c, i) => {
        let input: unknown;
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = undefined;
        }
        return { id: c.id || `call_${round}_${i}`, name: c.function.name, input };
      }),
      async (id, name, input) =>
        input === undefined ? { content: "Invalid input: arguments were not valid JSON.", isError: true } : exec(id, name, input),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}

/* ───────────────────────── Gemini ───────────────────────── */

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

async function runGemini({ model, system, history, message, tools, exec, emit, signal, maxRounds }: LoopArgs): Promise<LoopResult> {
  const contents: { role: "user" | "model"; parts: GeminiPart[] }[] = [
    ...history.map((m) => ({ role: m.role === "assistant" ? ("model" as const) : ("user" as const), parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: message }] },
  ];
  const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
  const usage = { input: 0, output: 0, cacheRead: 0 };
  for (let round = 0; ; round++) {
    const last = round >= maxRounds;
    // Key goes in a header, never the query string (URLs leak into proxy logs).
    const data = (await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: last ? "NONE" : "AUTO" } },
        generationConfig: { maxOutputTokens: MAX_TOKENS, thinkingConfig: { includeThoughts: true } },
      },
      { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      { label: "Gemini", signal },
    )) as {
      modelVersion?: string;
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };
    usage.input += data.usageMetadata?.promptTokenCount ?? 0;
    usage.output += (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0);
    usage.cacheRead += data.usageMetadata?.cachedContentTokenCount ?? 0;
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    if (!parts.length && cand?.finishReason && cand.finishReason !== "STOP")
      throw new HttpError(502, `Gemini stopped without an answer (${cand.finishReason}).`);
    for (const p of parts) if (p.thought && p.text) emit({ type: "thinking", text: p.text });
    const text = parts.flatMap((p) => (!p.thought && p.text ? [p.text] : [])).join("");
    if (text) emit({ type: "text", text });
    // Parts go back unchanged: Gemini needs its thought signatures on the next request.
    contents.push({ role: "model", parts });
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: p.functionCall!.id ?? `call_${round}_${i}`,
        name: p.functionCall!.name,
        input: p.functionCall!.args ?? {},
        rawId: p.functionCall!.id,
      }));
    if (!calls.length) {
      emit({ type: "round_end", hadTools: false });
      return { text, model: data.modelVersion ?? model, usage };
    }
    emit({ type: "round_end", hadTools: true });
    const results = await runTools(calls, exec);
    contents.push({
      role: "user",
      parts: results.map((r, i) => ({
        functionResponse: {
          ...(calls[i].rawId ? { id: calls[i].rawId } : {}),
          name: r.name,
          response: r.isError ? { error: r.content } : { result: r.content },
        },
      })),
    });
  }
}

/* ───────────────────────── mock ───────────────────────── */

/**
 * Deterministic offline agent: lists labelled individuals with a SPARQL query
 * (and searches the documents), then answers from what came back, citing the
 * query. Exercises the whole path — tools, evidence, citations, storage.
 */
async function runMock({ message, tools, exec, emit }: LoopArgs): Promise<LoopResult> {
  const usage = { input: 0, output: 0 };
  const has = (n: string) => tools.some((t) => t.name === n);
  emit({ type: "thinking", text: "Listing labelled individuals, then answering from the result." });
  const calls: { id: string; name: string; input: unknown }[] = [];
  if (has("sparql_query")) {
    calls.push({
      id: "mock_q",
      name: "sparql_query",
      input: {
        query: `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?label ?type WHERE {
  ?item rdfs:label ?label ;
        a ?type .
  FILTER(isIRI(?type) && !STRSTARTS(STR(?type), "http://www.w3.org/2002/07/owl#"))
} LIMIT 25`,
      },
    });
  }
  if (has("cypher_query"))
    calls.push({
      id: "mock_q",
      name: "cypher_query",
      input: {
        query:
          "MATCH (item) WHERE item.name IS NOT NULL RETURN elementId(item) AS item, item.name AS label, labels(item)[0] AS type LIMIT 25",
      },
    });
  if (has("search_documents")) calls.push({ id: "mock_d", name: "search_documents", input: { query: message } });
  emit({ type: "text", text: "Looking this up in the graph." });
  emit({ type: "round_end", hadTools: true });
  const results = await runTools(calls, exec);
  const q = results.find((r) => r.id === "mock_q");
  const d = results.find((r) => r.id === "mock_d");
  const qid = q?.content.match(/^\[(Q\d+)\]/)?.[1];
  const n = Number(q?.content.match(/returned (\d+) row/)?.[1] ?? 0);
  const labels = (q?.content.split("\n").slice(2, 5) ?? []).map((l) => l.split("\t")[1]?.replace(/^"|"$/g, "")).filter(Boolean);
  const chunk = d && !d.isError && /\[C1\]/.test(d.content) ? " The documents mention it too [C1]." : "";
  const text = qid
    ? n
      ? `The knowledge graph has ${n} labelled individual${n === 1 ? "" : "s"}${labels.length ? `, for example ${labels.join(", ")}` : ""} [${qid}].${chunk}`
      : `The knowledge graph has no labelled individuals yet [${qid}].${chunk}`
    : `I could not query the graph.${chunk}`;
  emit({ type: "text", text });
  emit({ type: "round_end", hadTools: false });
  return { text, model: "mock-1", usage };
}
