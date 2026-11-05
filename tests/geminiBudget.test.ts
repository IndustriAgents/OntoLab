import { afterEach, describe, expect, it, vi } from "vitest";
import { callStructured } from "../server/structured.ts";
import { withGenerationBudget } from "../server/ml/generationBudget.ts";
import { defaultGenerationBudget } from "../server/ml/tokenization.ts";
import { defaultOutputTokens, geminiThinkingConfig } from "../src/lib/generationLimits.ts";

const call = {
  provider: "gemini" as const,
  model: "gemini-3.8-flash",
  system: "Return JSON",
  lead: "Generate",
  schema: { type: "object", properties: { classes: { type: "array", items: { type: "string" } } } },
  toolName: "classes",
  toolDesc: "Classes",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Gemini generation budgets", () => {
  it("uses a reasoning-aware default in both server and UI policy", () => {
    expect(defaultOutputTokens("gemini")).toBe(16384);
    expect(defaultGenerationBudget("gemini", call.model).outputTokens).toBe(16384);
    expect(geminiThinkingConfig(call.model, 4096)).toEqual({ thinkingLevel: "low" });
    expect(geminiThinkingConfig("gemini-2.5-pro", 4096)).toEqual({ thinkingBudget: 1024 });
  });

  it.each(["STOP", "MAX_TOKENS"])("honors an explicit cap and counts reasoning tokens on %s", async (finishReason) => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        const payload = JSON.parse(options.body as string);
        requests.push(payload);
        return new Response(
          JSON.stringify(
            url.endsWith(":countTokens")
              ? { totalTokens: 100 }
              : {
                  candidates: [
                    {
                      finishReason,
                      content: { parts: [{ thought: true, text: "Internal summary" }, { text: '{"classes":["Complete"]}' }] },
                    },
                  ],
                  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 34 },
                },
          ),
          { status: 200 },
        );
      }),
    );
    const budget = { ...defaultGenerationBudget("gemini", call.model), outputTokens: 4096 };
    const result = withGenerationBudget(budget, () => callStructured(call));
    if (finishReason === "MAX_TOKENS")
      await expect(result).rejects.toMatchObject({
        name: "TruncatedOutputError",
        usage: { input_tokens: 100, output_tokens: 46 },
        outputLimit: 4096,
      });
    else expect((await result).value).toEqual({ data: { classes: ["Complete"] }, usage: { input_tokens: 100, output_tokens: 46 } });
    expect(requests[1].generationConfig).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "low" }, temperature: 1 });
  });
});
