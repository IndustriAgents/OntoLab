import { beforeEach, expect, it, vi } from "vitest";
const { call, loop } = vi.hoisted(() => ({ call: vi.fn(), loop: vi.fn() }));
vi.mock("../server/structured.ts", () => ({ callStructured: call }));
vi.mock("../server/graphchat/loop.ts", () => ({ runLoop: loop }));
import { checkAnswerSemantics } from "../server/graphchat/semanticCheck.ts";
import type { GraphBackend } from "../server/graphchat/backend.ts";
const ctx = { provider: "gemini" as const, model: "test" };
const quote = "Scalability and fastness of this approach in real examples needs analysis.";
const sources = new Map([["C1", quote]]);
const draft = "Scalability on large-scale systems remains untested [C1].";
const edit = {
  fragment: "large-scale systems",
  replacement: "real examples",
  reason: "The source does not specify size.",
  sources: [{ ref: "C1", quote }],
};
beforeEach(() => {
  call.mockReset();
  loop.mockReset();
});
it("applies only a supported exact edit, preserves the original, and counts usage", async () => {
  call.mockResolvedValue({ data: { edits: [edit] }, usage: { input_tokens: 10, output_tokens: 5 } });
  const out = await checkAnswerSemantics(draft, "What is limited?", sources, ctx);
  expect(out.text).toBe("Scalability on real examples remains untested [C1].");
  expect(out.semanticCheck).toMatchObject({ status: "repaired", draft, edits: [edit] });
  expect(out.usage).toMatchObject({ input: 10, output: 5 });
});
it("normalizes bracketed source references without weakening quote validation", async () => {
  call.mockResolvedValue({
    data: { edits: [{ ...edit, sources: [{ ref: "[C1]", quote }] }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.semanticCheck.status).toBe("repaired");
  expect(out.semanticCheck.edits[0].sources[0].ref).toBe("C1");
});
it.each([
  [{ ...edit, fragment: "not in the draft" }],
  [{ ...edit, replacement: "Changed [C99]" }],
  [{ ...edit, sources: [{ ref: "C1", quote: "Invented evidence supporting industrial-scale performance." }] }],
  [{ ...edit, sources: [] }],
  [edit, edit],
])("withholds invalid or conflicting edits without leaking the original claim", async (edits) => {
  call.mockResolvedValue({ data: { edits }, usage: { input_tokens: 1, output_tokens: 1 } });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.semanticCheck.status).toBe("withheld");
  expect(out.text).not.toContain("large-scale");
});
it("leaves a draft unchanged when no corrections are proposed, and propagates cancellation", async () => {
  call.mockResolvedValue({ data: { edits: [] }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await checkAnswerSemantics(draft, "Question", sources, ctx)).text).toBe(draft);
  const controller = new AbortController();
  controller.abort();
  call.mockRejectedValue(new Error("cancelled"));
  await expect(checkAnswerSemantics(draft, "Question", sources, { ...ctx, signal: controller.signal })).rejects.toThrow("cancelled");
});
it.each([false, true])("streams only the checked answer, including locator recovery=%s", async (recover) => {
  const { runTurn } = await import("../server/graphchat/turn.ts");
  loop.mockImplementation(async ({ emit }) => {
    emit({ type: "text", text: draft });
    emit({ type: "round_end", hadTools: false });
    return { text: draft, model: "test", usage: { input: 1, output: 1 } };
  });
  call.mockResolvedValueOnce({
    data: { edits: [recover ? { ...edit, fragment: "Large-scale systems" } : edit] },
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  if (recover)
    call.mockResolvedValueOnce({
      data: { repairs: [{ index: 0, fragment: edit.fragment, sources: edit.sources }] },
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  const backend = {
    source: "project",
    label: "saved",
    kinds: ["select"],
    digest: async () => ({ text: "", suggestions: [] }),
    tools: async () => [],
  } as unknown as GraphBackend;
  const emitted: string[] = [];
  const result = await runTurn({
    ...ctx,
    reviewSourceSemantics: true,
    backend,
    signal: new AbortController().signal,
    history: [],
    message: "What is limited?",
    emit: (e) => {
      if (e.type === "text") emitted.push(e.text);
    },
    initialPassages: [
      { where: "p4", chunk: { id: "chunk", projectId: "p", documentId: "d", ordinal: 0, start: 0, end: quote.length, text: quote } },
    ],
  });
  expect(emitted.join("")).toBe("Scalability on real examples remains untested [C1].");
  expect(result.text).toBe(emitted.join(""));
  expect(result.semanticCheck?.draft).toBe(draft);
  expect(result.usage).toMatchObject({ input: recover ? 13 : 11, output: recover ? 7 : 6 });
});

it("ignores a no-op confirmation without withholding the answer or claiming a repair", async () => {
  const noop = { ...edit, fragment: "An excerpt not copied from this draft", replacement: "An excerpt not copied from this draft" };
  call.mockResolvedValue({ data: { edits: [noop] }, usage: { input_tokens: 10, output_tokens: 5 } });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.text).toBe(draft);
  expect(out.semanticCheck).toMatchObject({ status: "passed", edits: [] });
  expect(out.usage).toMatchObject({ input: 10, output: 5 });
});
it("still validates and applies actual edits alongside no-op confirmations", async () => {
  const noop = { ...edit, fragment: "Confirmation only", replacement: "Confirmation only" };
  call.mockResolvedValue({ data: { edits: [noop, edit] }, usage: { input_tokens: 1, output_tokens: 1 } });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.text).toBe("Scalability on real examples remains untested [C1].");
  expect(out.semanticCheck.edits).toEqual([edit]);
  call.mockResolvedValue({
    data: { edits: [noop, { ...edit, fragment: "Wrong draft fragment" }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  expect((await checkAnswerSemantics(draft, "Question", sources, ctx)).semanticCheck.status).toBe("withheld");
});

it("recovers a short source lead-in with a substantive quote while retaining the correction and original failure", async () => {
  const text = "The Reference Model of Control (RCM) interface is transformed [C1].";
  const source =
    "The figure 4 a, shows the transformation of the RCM interface to the interface of the basic function block of the plant model.";
  const original = {
    fragment: "The Reference Model of Control (RCM) interface",
    replacement: "The RCM interface",
    reason: "The expansion is unsupported.",
    sources: [{ ref: "C1", quote: "The figure 4 a," }],
  };
  call.mockResolvedValueOnce({ data: { edits: [original] }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } });
  call.mockResolvedValueOnce({
    data: {
      repairs: [
        { index: 0, fragment: "unrequested change", replacement: "Invented replacement", sources: [{ ref: "[C1]", quote: source }] },
      ],
    },
    usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3 },
  });
  const out = await checkAnswerSemantics(text, "How is the interface transformed?", new Map([["C1", source]]), ctx);
  expect(out.text).toBe("The RCM interface is transformed [C1].");
  expect(out.semanticCheck).toMatchObject({
    status: "repaired",
    repairAttempt: { originalEdits: [original], errors: [{ index: 0, field: "sources" }] },
  });
  expect(out.semanticCheck.edits[0]).toMatchObject({
    fragment: original.fragment,
    replacement: original.replacement,
    sources: [{ ref: "C1", quote: source }],
  });
  expect(out.usage).toEqual({ input: 30, output: 12, cacheRead: 5 });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[1][0].toolName).toBe("repair_semantic_edit_locations");
});

it("requires the model to copy the exact draft capitalization and keeps already valid edits", async () => {
  const text = "| A plant model FB mined from simulation event logs [C1] |\nScalability on large-scale systems [C2].";
  const source = "The derived plant model FB from the event log is connected in a closed-loop with a controller.";
  const first = {
    fragment: "Plant model FB mined from simulation event logs [C1] |",
    replacement: "plant model FB derived from simulation event logs [C1] |",
    reason: "FB is derived through transformations.",
    sources: [{ ref: "C1", quote: source }],
  };
  const second = { ...edit, sources: [{ ref: "C2", quote }] };
  call.mockResolvedValueOnce({ data: { edits: [first, second] }, usage: { input_tokens: 1, output_tokens: 1 } });
  call.mockResolvedValueOnce({
    data: { repairs: [{ index: 0, fragment: "plant model FB mined from simulation event logs [C1] |", sources: [] }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const out = await checkAnswerSemantics(
    text,
    "Compare",
    new Map([
      ["C1", source],
      ["C2", quote],
    ]),
    ctx,
  );
  expect(out.text).toBe("| A plant model FB derived from simulation event logs [C1] |\nScalability on real examples [C2].");
  expect(out.semanticCheck.edits[0].sources).toEqual(first.sources);
  expect(out.semanticCheck.edits[1]).toEqual(second);
});

it.each([
  [],
  [{ index: 9, fragment: edit.fragment, sources: edit.sources }],
  [{ index: 0, fragment: "still missing", sources: edit.sources }],
  [{ index: 0, fragment: edit.fragment, sources: [{ ref: "C99", quote }] }],
])("never drops a correction or accepts unlocated evidence during the single repair attempt", async (repairs) => {
  const invalid = { ...edit, fragment: "Wrong capitalization", sources: [{ ref: "C1", quote: "Too short" }] };
  call.mockResolvedValueOnce({ data: { edits: [invalid] }, usage: { input_tokens: 1, output_tokens: 1 } });
  call.mockResolvedValueOnce({ data: { repairs }, usage: { input_tokens: 1, output_tokens: 1 } });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.semanticCheck.status).toBe("withheld");
  expect(out.semanticCheck.repairAttempt?.originalEdits).toEqual([invalid]);
  expect(out.text).not.toContain("large-scale");
  expect(call).toHaveBeenCalledTimes(2);
});

it("rejects a locator recovery that creates overlapping edits", async () => {
  call.mockResolvedValueOnce({
    data: { edits: [edit, { ...edit, fragment: "Large-scale systems" }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  call.mockResolvedValueOnce({
    data: { repairs: [{ index: 1, fragment: edit.fragment, sources: edit.sources }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.semanticCheck).toMatchObject({ status: "withheld", error: "Semantic edits overlap." });
});

it("propagates cancellation during locator repair", async () => {
  const controller = new AbortController();
  call.mockResolvedValueOnce({ data: { edits: [{ ...edit, fragment: "Missing" }] }, usage: { input_tokens: 1, output_tokens: 1 } });
  call.mockImplementationOnce(() => {
    controller.abort();
    throw new Error("repair cancelled");
  });
  await expect(checkAnswerSemantics(draft, "Question", sources, { ...ctx, signal: controller.signal })).rejects.toThrow("repair cancelled");
});

it("does not let a locator repair redirect a correction to different draft text", async () => {
  call.mockResolvedValueOnce({
    data: { edits: [{ ...edit, fragment: "Large-scale systems" }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  call.mockResolvedValueOnce({
    data: { repairs: [{ index: 0, fragment: draft, sources: edit.sources }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const out = await checkAnswerSemantics(draft, "Question", sources, ctx);
  expect(out.semanticCheck).toMatchObject({ status: "withheld", error: "Semantic location repair changed the correction target text." });
  expect(out.text).not.toContain("large-scale");
});
