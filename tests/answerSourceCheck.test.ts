import { beforeEach, expect, it, vi } from "vitest";
const { structured, loop } = vi.hoisted(() => ({ structured: vi.fn(), loop: vi.fn() }));
vi.mock("../server/structured.ts", () => ({ callStructured: structured }));
vi.mock("../server/graphchat/loop.ts", () => ({ runLoop: loop }));
import { answerSourceIssues, checkAnswerSources, temporalFormulas } from "../server/graphchat/sourceCheck.ts";
import { runTurn } from "../server/graphchat/turn.ts";
import type { GraphBackend } from "../server/graphchat/backend.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
const sources = new Map([
  ["C1", "The reachability graph generated using PIPE tool takes Petri net as input. A Finite State Machine(FSM) is transformed."],
  ["C2", "The specification G ! ( controller.HOME = TRUE & controller.END = TRUE ) is true."],
]);
const bad =
  "PIPE (Platform Independent Petri Net Editor) generates a graph [C1].\n\nThe property is `AG !(controller.HOME = TRUE & controller.END = TRUE)` [C2].";
const good = "PIPE generates a graph [C1].\n\nThe printed property is `G !(controller.HOME = TRUE & controller.END = TRUE)` [C2].";
const ctx = { provider: "gemini" as const, model: "gemini-3.8-flash", signal: new AbortController().signal };
const capacitySources = new Map([
  ["C1", "This FB is capable of testing over 75 standard functions by providing specific events for testing each function."],
]);
it("preserves capability from a graph literal even when the paragraph also cites document passages", () => {
  const evidence = new Map([
    ["Q2", "Capable of testing over 75 standard functions."],
    ["C1", "The test suite targets portability."],
  ]);
  expect(answerSourceIssues("Over 75 functions tested via StandardFunctionTest [Q2, C1].", evidence).map((i) => i.kind)).toEqual(["scope"]);
});
it.each([
  "Standard functions (over 75 functions tested via StandardFunctionTest FB) [C1].",
  "The suite tested over 75 standard functions [C1].",
  "| Method | Can test functions [C1] | over 75 functions tested [C1] |",
])("detects capability overstated as measured test coverage: %s", (draft) => {
  expect(answerSourceIssues(draft, capacitySources).some((x) => x.kind === "scope")).toBe(true);
});
it.each([
  "The block is capable of testing over 75 functions [C1].",
  "The block can test over 75 standard functions [C1].",
  "It is not established that over 75 functions were tested [C1].",
  "The paper reports 12 functions tested [C1].",
])("does not confuse capability, negation or another count with the flagged claim: %s", (draft) => {
  expect(answerSourceIssues(draft, capacitySources)).toEqual([]);
});
it("allows independently cited observed coverage and preserves a repaired capability claim", async () => {
  const draft = "Over 75 functions were tested [C1, C2].";
  expect(answerSourceIssues(draft, new Map([...capacitySources, ["C2", "We tested over 75 functions in this experiment."]]))).toEqual([]);
  structured.mockResolvedValue({
    data: { answer: "The FB is capable of testing over 75 functions [C1]." },
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  const result = await checkAnswerSources(draft.replace(", C2", ""), "What was tested?", capacitySources, ctx);
  expect(result.sourceCheck.status).toBe("repaired");
  expect(result.sourceCheck.draft).toContain("were tested");
});
it("does not let a graph claim override source capability and withholds a failed repair", async () => {
  const evidence = new Map([
    ["C1", "This block can test 17 functions."],
    ["Q1", "17 functions were tested."],
  ]);
  const draft = "17 functions were tested [C1, Q1].";
  expect(answerSourceIssues(draft, evidence)).toHaveLength(1);
  structured.mockResolvedValue({ data: { answer: draft }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await checkAnswerSources(draft, "What was tested?", evidence, ctx)).sourceCheck.status).toBe("withheld");
});
beforeEach(() => {
  structured.mockReset();
  loop.mockReset();
});
it("detects unsupported definitions and altered operators against their cited source", () => {
  expect(answerSourceIssues(bad, sources).map((i) => i.kind)).toEqual(["definition", "notation"]);
  expect(answerSourceIssues(good, sources)).toEqual([]);
  expect(answerSourceIssues(good.replace("G !", "A G !"), sources)[0]?.kind).toBe("notation");
  expect(answerSourceIssues("Finite State Machine (FSM) [C1]", sources)).toEqual([]);
  expect(answerSourceIssues("Platform Independent Petri Net Editor (PIPE) [C1]", sources)[0]?.kind).toBe("definition");
  expect(answerSourceIssues("FSM (Finite State Machine) [C2]", sources)[0]?.kind).toBe("definition");
  expect(answerSourceIssues("G !(controller.HOME = TRUE & controller.END = FALSE) [C2]", sources)[0]?.kind).toBe("notation");
  expect(answerSourceIssues("PIPE (Platform Independent Petri Net Editor)", sources)[0]?.kind).toBe("definition");
});
it("checks explicit expansion prose and leaves numeric function arguments alone", () => {
  expect(answerSourceIssues("PIPE stands for Platform Independent Petri Net Editor [C1]", sources)[0]?.kind).toBe("definition");
  expect(answerSourceIssues("FSM is short for Finite State Machine [C1]", sources)).toEqual([]);
  expect(answerSourceIssues("MUX(int1,time1,time2,time3) [C1]", sources)).toEqual([]);
});
it("preserves an explicitly recommended action without making every source action optional", async () => {
  const evidence = new Map([
    ["C1", "Provide initial markings. It is better to remove the Start and End states prior to reachability analysis."],
  ]);
  const draft = "The Petri net, with Start and End states removed and initial markings supplied, is analyzed [C1].";
  expect(answerSourceIssues(draft, evidence).map((i) => i.kind)).toEqual(["modality"]);
  expect(answerSourceIssues("Initial markings are supplied [C1].", evidence)).toEqual([]);
  const corrected = "Initial markings are supplied; removing Start and End states is recommended [C1].";
  expect(answerSourceIssues(corrected, evidence)).toEqual([]);
  structured.mockResolvedValue({ data: { answer: corrected }, usage: { input_tokens: 10, output_tokens: 5 } });
  const result = await checkAnswerSources(draft, "Explain the workflow", evidence, ctx);
  expect(result.text).toBe(corrected);
  expect(result.sourceCheck.status).toBe("repaired");
});
it("withholds a repair that still turns a recommendation into a requirement", async () => {
  const evidence = new Map([["C1", "It is better to remove the Start and End states prior to reachability analysis."]]);
  const draft = "Start and End states must be removed [C1].";
  structured.mockResolvedValue({ data: { answer: draft }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await checkAnswerSources(draft, "Explain", evidence, ctx)).sourceCheck.status).toBe("withheld");
});
it("allows source-supported AG without assuming G equivalence, including nested formulas", () => {
  const evidence = new Map([["C3", "AG (ready -> AF (done))"]]);
  expect(temporalFormulas(evidence.get("C3")!)).toEqual(["AG (ready -> AF (done))", "AF (done)"]);
  expect(answerSourceIssues("`AG(ready -> AF(done))` [C3]", evidence)).toEqual([]);
  expect(answerSourceIssues("`G(ready -> AF(done))` [C3]", evidence)[0]?.kind).toBe("notation");
  expect(
    answerSourceIssues(
      "`AG !(controller.HOME = TRUE & controller.END = TRUE)` [C2, Q1]",
      new Map([...sources, ["Q1", "AG !(controller.HOME = TRUE & controller.END = TRUE)"]]),
    )[0]?.kind,
  ).toBe("notation");
});
it("makes one repair, preserves the draft audit, and accounts for usage", async () => {
  structured.mockResolvedValue({ data: { answer: good }, usage: { input_tokens: 12, output_tokens: 8 } });
  const result = await checkAnswerSources(bad, "Compare the tools", sources, ctx);
  expect(result.text).toBe(good);
  expect(result.sourceCheck).toMatchObject({ status: "repaired", draft: bad, remainingIssues: [] });
  expect(result.usage).toMatchObject({ input: 12, output: 8 });
  expect(structured).toHaveBeenCalledTimes(1);
  await checkAnswerSources(good, "Compare the tools", sources, ctx);
  expect(structured).toHaveBeenCalledTimes(1);
});
it.each([bad, good.replaceAll("C2", "C99"), ""])("withholds an unsafe or unusable repair without retrying: %s", async (answer) => {
  structured.mockResolvedValue({ data: { answer }, usage: { input_tokens: 1, output_tokens: 1 } });
  const result = await checkAnswerSources(bad, "Compare", sources, ctx);
  expect(result.sourceCheck.status).toBe("withheld");
  expect(result.text).not.toContain("AG");
  expect(result.text).not.toContain("Platform Independent");
  expect(structured).toHaveBeenCalledTimes(1);
});
it("withholds on provider failure but propagates cancellation", async () => {
  structured.mockRejectedValue(new Error("provider failed"));
  expect((await checkAnswerSources(bad, "Compare", sources, ctx)).sourceCheck.status).toBe("withheld");
  const aborted = new AbortController();
  aborted.abort();
  await expect(checkAnswerSources(bad, "Compare", sources, { ...ctx, signal: aborted.signal })).rejects.toThrow();
});
it("never emits the unsupported draft as answer text and returns exactly the checked stream", async () => {
  loop.mockImplementation(async ({ emit }) => {
    emit({ type: "text", text: bad });
    emit({ type: "round_end", hadTools: false });
    return { text: bad, model: ctx.model, usage: { input: 2, output: 3 } };
  });
  structured.mockResolvedValue({ data: { answer: good }, usage: { input_tokens: 12, output_tokens: 8 } });
  const backend = {
    source: "project",
    label: "Test",
    kinds: ["select"],
    digest: async () => ({ text: "", suggestions: [] }),
    tools: async () => [],
  } as unknown as GraphBackend;
  const events: ChatEvent[] = [];
  const result = await runTurn({
    ...ctx,
    backend,
    history: [],
    message: "Compare",
    emit: (e) => events.push(e),
    initialPassages: [...sources].map(([ref, text]) => ({
      where: ref,
      chunk: { id: ref, projectId: "p", documentId: "d", ordinal: 0, start: 0, end: text.length, text },
    })),
  });
  expect(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  ).toBe(good);
  expect(result.text).toBe(good);
  expect(result.sourceCheck?.draft).toBe(bad);
  expect(result.usage).toMatchObject({ input: 14, output: 11 });
});

it("drops a still-unsupported expansion while retaining the acronym and the useful answer", async () => {
  const original = "Schneider Electric EcoStruxure Automation Expert (EAE) v21.2 was tested [C1].";
  structured.mockResolvedValue({
    data: { answer: "Schneider Electric EcoStruxure (**EAE**) v21.2 was tested [C1]." },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await checkAnswerSources(original, "Which versions?", new Map([["C1", "4DIAC V2.0.1 AND EAE V21.2"]]), ctx);
  expect(result.text).toBe("EAE v21.2 was tested [C1].");
  expect(result.sourceCheck.status).toBe("repaired");
  expect(result.sourceCheck.removedExpansions).toEqual(["Schneider Electric EcoStruxure (EAE)"]);
  expect(structured).toHaveBeenCalledTimes(1);
});

it("checks version-qualified product expansions and preserves versions in acronym fallback", async () => {
  const evidence = new Map([["C1", "Tested Schinder Electric EcoStruxure (EAE), version V21.2."]]);
  const text = "Schneider Electric EcoStruxure (EAE v21.2) was tested [C1].";
  expect(answerSourceIssues(text, evidence)[0]).toMatchObject({ kind: "definition", acronym: "EAE" });
  structured.mockResolvedValue({ data: { answer: text }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await checkAnswerSources(text, "Which version?", evidence, ctx)).text).toBe("EAE v21.2 was tested [C1].");
});
it("flags the specific unsupported real-examples to large-scale substitution, without rejecting explicit negation or source support", () => {
  const evidence = new Map([["C1", "Scalability and speed in real examples need analysis."]]);
  expect(answerSourceIssues("The limitation addresses scalability on large-scale systems.", evidence)[0]?.kind).toBe("scope");
  expect(answerSourceIssues("This does not establish scalability on large-scale systems.", evidence)).toEqual([]);
  expect(answerSourceIssues("The limitation addresses scalability on real examples [C1].", evidence)).toEqual([]);
  evidence.set("C2", "The real examples are large-scale systems.");
  expect(answerSourceIssues("Scalability on large-scale systems [C1, C2].", evidence)).toEqual([]);
});

it("does not turn a qualitative speed claim into empirical proof", () => {
  const evidence = new Map([
    ["C1", "The proposed method is fast for small examples but scalability and fastness in real examples needs analysis."],
  ]);
  expect(answerSourceIssues("The method proved fast for small examples [C1].", evidence)[0]?.kind).toBe("scope");
  expect(answerSourceIssues("The authors describe the method as fast for small examples [C1].", evidence)).toEqual([]);
});
