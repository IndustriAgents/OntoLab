import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateTopic, topicBatches, topicSourceBudget } from "../server/services/inductionCalls.ts";
import { planSteps } from "../server/services/induction.ts";
import { TruncatedOutputError } from "../server/providers.ts";
import type { StructuredCall } from "../server/structured.ts";
import type { GenerationTokenBudget } from "../src/types/research.ts";
import type { DocumentChunk } from "../src/types/project.ts";
import type { ServiceCtx } from "../server/services/context.ts";

const structured = vi.hoisted(() => vi.fn());
vi.mock("../server/structured.ts", () => ({ callStructured: structured }));
const budget: GenerationTokenBudget = {
  provider: "gemini",
  model: "gemini-3.8-flash",
  maxTokens: 2000,
  contextTokens: 131072,
  outputTokens: 4096,
  promptReserveTokens: 4096,
};
const call: StructuredCall = {
  provider: "gemini",
  model: budget.model,
  system: "Classes",
  lead: "List classes",
  schema: {},
  toolName: "emit_classes",
  toolDesc: "Classes",
};
const usage = { input_tokens: 10, output_tokens: 20 };
beforeEach(() => { structured.mockReset(); });

describe("output-aware topic calls", () => {
  it("splits a topic despite a large context window, preserving every source in both stages", async () => {
    const chunks = Array.from({ length: 33 }, (_, ordinal) => ({
      id: `c${ordinal}`,
      documentId: "d",
      projectId: "p",
      ordinal,
      text: "x".repeat(2000),
      start: ordinal * 2000,
      end: (ordinal + 1) * 2000,
      overlap: 0,
    })) as DocumentChunk[];
    const steps = await planSteps({} as ServiceCtx, "p", chunks, null, {
      tokenization: { embedding: { profile: "hash:384", maxTokens: 256 }, generation: budget },
    });
    for (const kind of ["terms", "relations"]) {
      const groups = steps.filter((step) => step.kind === kind);
      expect(groups.length).toBeGreaterThan(2);
      expect(groups.flatMap((step) => step.chunkIds).sort()).toEqual(chunks.map((chunk) => chunk.id).sort());
      for (const group of groups) expect(group.chunkIds!.length * 2000).toBeLessThanOrEqual(topicSourceBudget(budget));
    }
    expect(
      topicBatches(
        Array.from({ length: 33 }, () => ({ text: "x" })),
        budget,
      ).every((batch) => batch.length <= 8),
    ).toBe(true);
  });

  it("splits truncated requests and retains complete results and failed-call usage", async () => {
    structured.mockImplementation(async (request: StructuredCall) => {
      if (request.docs!.length > 1) throw new TruncatedOutputError("Gemini", { input_tokens: 100, output_tokens: 4096 }, 4096);
      return { data: { classes: [{ name: request.docs![0].name }] }, usage };
    });
    const result = await generateTopic(
      {
        ...call,
        docs: [
          { name: "A", text: "First topic" },
          { name: "B", text: "Second topic" },
        ],
      },
      budget,
    );
    expect(result.data.classes).toEqual([{ name: "A" }, { name: "B" }]);
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 4136 });
    expect(result.calls.map((attempt) => attempt.status)).toEqual(["truncated", "complete", "complete"]);
    expect(structured).toHaveBeenCalledTimes(3);
  });

  it("bounds oversized individual chunks without losing whitespace, Unicode or tail text", async () => {
    const text = "Scientists study molecules. 😀\n\n".repeat(500) + "UNIQUE TAIL";
    const sent: string[] = [];
    structured.mockImplementation(async (request: StructuredCall) => {
      sent.push(...request.docs!.map((doc) => doc.text));
      expect(Buffer.byteLength(request.docs!.map((doc) => doc.text).join(""))).toBeLessThanOrEqual(topicSourceBudget(budget));
      return { data: { classes: [] }, usage };
    });
    await generateTopic({ ...call, docs: [{ name: "Long source", text }] }, budget);
    expect(sent.join("")).toBe(text);
    expect(sent.length).toBeGreaterThan(1);
  });

  it("recursively splits a single truncated source and never accepts the partial JSON", async () => {
    const text = "A passage with important facts. ".repeat(40);
    const successful: string[] = [];
    structured.mockImplementation(async (request: StructuredCall) => {
      const part = request.docs![0].text;
      if (part.length > 500) throw new TruncatedOutputError("Gemini", usage);
      successful.push(part);
      return { data: { classes: [{ name: "Complete" }] }, usage };
    });
    const result = await generateTopic({ ...call, docs: [{ name: "Topic", text }] }, budget);
    expect(successful.join("")).toBe(text);
    expect(result.calls.some((attempt) => attempt.status === "truncated")).toBe(true);
    expect(result.data.classes).toHaveLength(successful.length);
  });

  it("stops at an indivisible failing source and accounts for all attempted calls", async () => {
    structured.mockRejectedValue(new TruncatedOutputError("Gemini", usage));
    await expect(
      generateTopic(
        {
          ...call,
          docs: [
            { name: "A", text: "Short A" },
            { name: "B", text: "Short B" },
          ],
        },
        budget,
      ),
    ).rejects.toMatchObject({ usage: { input_tokens: 20, output_tokens: 40 } });
    expect(structured).toHaveBeenCalledTimes(2);
  });
});
