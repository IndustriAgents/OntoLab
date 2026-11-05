import { beforeEach, describe, expect, it, vi } from "vitest";
import { Parser } from "n3";
import { repairModule } from "../server/services/inductionRepair.ts";
import { runStep } from "../server/services/induction.ts";
import { TruncatedOutputError } from "../server/providers.ts";
import type { ServiceCtx } from "../server/services/context.ts";
import type { ExtractionRun, JobCheckpoint, Project } from "../src/types/project.ts";
import { HttpError } from "../server/http.ts";
import { checkGenerationRequest, withGenerationBudget } from "../server/ml/generationBudget.ts";
import type { StructuredCall } from "../server/structured.ts";

const structured = vi.hoisted(() => vi.fn());
vi.mock("../server/structured.ts", () => ({ callStructured: structured }));
const usage = { input_tokens: 100, output_tokens: 20 };
const call = { provider: "mock" as const, model: "mock-1" };
beforeEach(() => {
  structured.mockReset();
});

describe("bounded ontology repair", () => {
  it("applies a small patch without regenerating or losing unrelated statements", async () => {
    const turtle = '<http://ex/A> <http://ex/p> "old" .\n<http://ex/B> <http://ex/p> "untouched" .';
    structured.mockResolvedValue({ data: { remove: [0], add: '<http://ex/A> <http://ex/p> "new" .' }, usage });
    const result = await repairModule(turtle, "Correct A's annotation", call);
    const quads = new Parser().parse(result.turtle);
    expect(quads.map((q) => q.object.value)).toEqual(["untouched", "new"]);
    expect(structured.mock.calls[0][0].toolName).toBe("emit_ontology_patch");
  });

  it("rejects invalid statement numbers and invalid Turtle atomically", async () => {
    const turtle = '<http://ex/A> <http://ex/p> "old" .';
    for (const data of [
      { remove: [100], add: "" },
      { remove: [0], add: "broken turtle !!" },
    ]) {
      structured.mockResolvedValue({ data, usage });
      await expect(repairModule(turtle, "Repair", call)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("preserves references to existing blank nodes when patching a restriction", async () => {
    const turtle = '<http://ex/A> <http://ex/restriction> _:r .\n_:r <http://ex/value> "old" .';
    structured.mockResolvedValue({ data: { remove: [1], add: '_:r <http://ex/value> "new" .' }, usage });
    const result = await repairModule(turtle, "Correct the restriction", call);
    const quads = new Parser().parse(result.turtle);
    expect(quads[0].object.equals(quads[1].subject)).toBe(true);
    expect(quads[1].object.value).toBe("new");
  });

  it.each(["truncated", "context"])(
    "preserves the validated ontology and unresolved findings after a %s repair failure",
    async (failure) => {
      structured.mockRejectedValue(
        failure === "truncated"
          ? new TruncatedOutputError("Gemini")
          : new HttpError(413, "Repair context exceeds the configured token budget."),
      );
      const project = { id: "p", name: "Test", purpose: "", scope: "", competencyQuestions: [], settings: {} } as Project;
      const ctx = { store: { projects: { get: async () => project } } } as unknown as ServiceCtx;
      const run = { projectId: "p", options: { repair: true } } as ExtractionRun;
      const cps = [
        {
          key: "reuse",
          payload: {
            raw: { classes: [{ name: "A" }, { name: "B" }], objectProperties: [{ name: "relates", domain: ["A", "B"], range: ["A"] }] },
          },
        },
      ] as JobCheckpoint[];
      const result = await runStep(ctx, run, { key: "pitfalls", kind: "pitfalls", label: "Repair" }, cps, call, null, null);
      expect(structured).toHaveBeenCalled();
      expect(result.notes.join(" ")).toContain("Automatic repair did not finish");
      expect(result.trace?.diagnostics?.repairMode).toBe("statement-patches");
      expect((result.payload as { pitfalls: unknown[] }).pitfalls.length).toBeGreaterThan(0);
      expect(new Parser().parse((result.payload as { turtle: string }).turtle).length).toBeGreaterThan(0);
    },
  );

  it("repairs a large ontology inside its configured request budget using global statement IDs", async () => {
    const turtle =
      Array.from(
        { length: 250 },
        (_, index) =>
          `<http://ex/Unrelated${index}> a <http://www.w3.org/2002/07/owl#Class>; <http://www.w3.org/2000/01/rdf-schema#comment> "${"detailed annotation ".repeat(80)}" .`,
      ).join("\n") + '\n<http://ex/Target> <http://ex/p> "old" .';
    expect(Buffer.byteLength(turtle)).toBeGreaterThan(131072);
    const contextCall = { provider: "codex-cli" as const, model: "gpt-6.1-terra" };
    structured.mockImplementation(async (request: StructuredCall) => {
      const lead = JSON.parse(request.lead) as { statements: string[] };
      const row = lead.statements.find((statement) => statement.includes('"old"'))!;
      expect(row).toBeDefined();
      const globalIndex = Number(row.split(":", 1)[0]);
      expect(globalIndex).toBe(500);
      expect(lead.statements.length).toBeLessThan(501);
      await checkGenerationRequest(request.provider, request.model, {
        prompt: request.system + "\n" + request.lead,
        schema: request.schema,
        nativeContextAllowance: 8192,
      });
      return { data: { remove: [globalIndex], add: '<http://ex/Target> <http://ex/p> "new" .' }, usage };
    });
    const result = await withGenerationBudget(
      {
        provider: contextCall.provider,
        model: contextCall.model,
        maxTokens: 2000,
        contextTokens: 131072,
        outputTokens: 4096,
        promptReserveTokens: 4096,
      },
      () => repairModule(turtle, "Correct Target's annotation", contextCall, ["http://ex/Target"]),
    );
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].inputTokens + result.checks[0].outputTokens).toBeLessThanOrEqual(131072);
    expect(result.value.scope.inputEstimate).toBeLessThanOrEqual(result.value.scope.inputLimit);
    const quads = new Parser().parse(result.value.turtle);
    expect(quads).toHaveLength(501);
    expect(quads.filter((q) => q.subject.value.startsWith("http://ex/Unrelated"))).toHaveLength(500);
    expect(quads.find((q) => q.subject.value === "http://ex/Target")?.object.value).toBe("new");
  });

  it("rejects deletion of statements outside the supplied neighborhood", async () => {
    const turtle = '<http://ex/A> <http://ex/p> "old" .\n<http://ex/B> <http://ex/p> "unrelated" .';
    structured.mockResolvedValue({ data: { remove: [1], add: "" }, usage });
    await expect(repairModule(turtle, "Correct A", call, ["http://ex/A"])).rejects.toMatchObject({ status: 502 });
    expect(JSON.parse(structured.mock.calls[0][0].lead).statements).toHaveLength(1);
  });

  it("keeps the complete blank-node component when selecting a repair neighborhood", async () => {
    const turtle = '<http://ex/A> <http://ex/restriction> _:r .\n_:r <http://ex/value> "old" .\n<http://ex/B> <http://ex/p> "unrelated" .';
    structured.mockResolvedValue({ data: { remove: [1], add: '_:r <http://ex/value> "new" .' }, usage });
    const result = await repairModule(turtle, "Fix A's restriction", call, ["http://ex/A"]);
    const statements = JSON.parse(structured.mock.calls[0][0].lead).statements as string[];
    expect(statements).toHaveLength(2);
    const quads = new Parser().parse(result.turtle);
    const parent = quads.find((q) => q.subject.value === "http://ex/A")!;
    expect(quads.find((q) => q.subject.equals(parent.object))?.object.value).toBe("new");
    expect(quads.find((q) => q.subject.value === "http://ex/B")?.object.value).toBe("unrelated");
  });
});
