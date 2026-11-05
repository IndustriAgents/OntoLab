import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenSpans, type TokenCounter } from "./tokenSplitting.ts";
import { byteCounter, generationCounter } from "./tokenization.ts";
import { hashEmbedder, tokenBounded, type Embedder } from "./embeddings.ts";
import { checkGenerationRequest, withGenerationBudget } from "./generationBudget.ts";

const counter: TokenCounter = { id: "test-codepoints", exact: true, count: (t) => Array.from(t).length + 2 };
afterEach(() => vi.unstubAllGlobals());

describe("token-bounded source coverage", () => {
  it("preserves every source character, including trailing multilingual text and emoji", () => {
    const text = "First sentence.\n\n漢字 العربية 😀 café\n".repeat(1000) + "FINAL SENTINEL";
    const spans = tokenSpans(text, counter, 48);
    expect(spans.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
    expect(spans.every((s) => counter.count(text.slice(s.start, s.end)) <= 48)).toBe(true);
    expect(
      spans.every((s) => !/^[\uDC00-\uDFFF]/.test(text.slice(s.start, s.end)) && !/[\uD800-\uDBFF]$/.test(text.slice(s.start, s.end))),
    ).toBe(true);
  });
  it("includes overlap inside the budget and never crosses a hard section boundary", () => {
    const text = "A sentence here. ".repeat(50) + "Next section. ".repeat(50);
    const cut = text.indexOf("Next section.");
    const spans = tokenSpans(text, counter, 64, { overlap: 0.2, cuts: [cut] });
    expect(spans.some((s) => s.overlap > 0)).toBe(true);
    expect(spans.every((s) => s.tokens <= 64 && !(s.start < cut && s.end > cut))).toBe(true);
    let covered = 0;
    for (const s of spans) {
      expect(s.start).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, s.end);
    }
    expect(covered).toBe(text.length);
  });
  it("uses a matching OpenAI encoding and labels fallback counters as estimates", () => {
    expect(generationCounter("openai", "gpt-4o").exact).toBe(true);
    expect(generationCounter("gemini", "gemini-2.5-flash").exact).toBe(false);
    expect(byteCounter.count("😀")).toBe(4);
  });
  it("embeds the complete parent through bounded passages rather than clipping its beginning", async () => {
    const seen: string[] = [];
    const inner: Embedder = {
      id: "test",
      backend: "hash",
      async embed(texts) {
        seen.push(...texts);
        return hashEmbedder.embed(texts);
      },
    };
    const bounded = tokenBounded(
      inner,
      { id: "test", label: "test", backend: "hash", model: "test", inputLimit: 100, tokenizer: "estimate" },
      100,
    );
    const text = "Prefix. ".repeat(1000) + "THE IMPORTANT FINAL FACT";
    const vectors = await bounded.embed([text]);
    expect(vectors).toHaveLength(1);
    expect(seen.join("")).toBe(text);
    expect(seen.every((t) => byteCounter.count(t) <= 100)).toBe(true);
    expect(seen.slice(-2).join("")).toContain("FINAL FACT");
    expect(bounded.id).toContain("full-coverage-v2");
  });
});

describe("full generation request budgets", () => {
  const budget = { provider: "mock", model: "mock-1", maxTokens: 64, contextTokens: 1000, outputTokens: 100, promptReserveTokens: 500 };
  it("counts schemas and instructions, and reserves response space", async () => {
    await expect(
      withGenerationBudget(budget, () =>
        checkGenerationRequest("mock", "mock-1", { messages: ["small"], tools: [{ schema: "X".repeat(500) }] }),
      ),
    ).rejects.toThrow("Full request needs");
    const result = await withGenerationBudget(budget, () => checkGenerationRequest("mock", "mock-1", { messages: ["small"] }));
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].outputTokens).toBe(100);
    expect(result.checks[0].exact).toBe(false);
  });
  it("uses the provider count for the fully assembled Gemini request", async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.generateContentRequest.system_instruction.parts[0].text).toBe("ontology");
      expect(body.generateContentRequest.generationConfig.responseSchema).toEqual({ type: "OBJECT" });
      return Response.json({ totalTokens: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await withGenerationBudget({ ...budget, provider: "gemini", model: "gemini-2.5-flash" }, () =>
      checkGenerationRequest("gemini", "gemini-2.5-flash", {
        system_instruction: { parts: [{ text: "ontology" }] },
        generationConfig: { responseSchema: { type: "OBJECT" } },
      }),
    );
    expect(result.checks[0].providerInputTokens).toBe(200);
    expect(result.checks[0].inputTokens).toBeGreaterThan(200);
    expect(result.checks[0].exact).toBe(false);
  });
  it("fails before generation when token counting fails or the model changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unavailable", { status: 503 })),
    );
    await expect(
      withGenerationBudget({ ...budget, provider: "gemini", model: "gemini-2.5-flash" }, () =>
        checkGenerationRequest("gemini", "gemini-2.5-flash", {}),
      ),
    ).rejects.toThrow("could not count");
    await expect(withGenerationBudget(budget, () => checkGenerationRequest("mock", "other", {}))).rejects.toThrow("model changed");
  });
});
