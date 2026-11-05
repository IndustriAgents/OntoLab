import { beforeEach, expect, it, vi } from "vitest";
const { run, listDocuments, readSources } = vi.hoisted(() => ({ run: vi.fn(), listDocuments: vi.fn(), readSources: vi.fn() }));
vi.mock("../server/graphchat/turn.ts", () => ({ runTurn: run }));
vi.mock("../server/services/sourceRetrieval.ts", async (original) => ({ ...(await original<object>()), savedSources: readSources }));
import { executeGraphAnswer } from "../server/services/graphChat.ts";
import { silentLogger, type ServiceCtx } from "../server/services/context.ts";
import type { GraphBackend } from "../server/graphchat/backend.ts";
import type { Project, RevisionWithContent } from "../src/types/project.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";

const ctx = {
  store: { documents: { list: listDocuments } },
  user: { id: "test" },
  now: () => new Date("2026-11-03"),
  log: silentLogger,
  requestId: "test",
} as unknown as ServiceCtx;
const input = {
  project: { id: "project", settings: {} } as Project,
  graphRevision: { id: "revision", content: { corpus: { sources: [] } } } as unknown as RevisionWithContent,
  backend: { source: "project", label: "saved graph" } as GraphBackend,
  provider: "mock" as const,
  model: "mock-1",
  question: "What is recorded?",
  graphOnly: true,
};
beforeEach(() => {
  run.mockReset();
  listDocuments.mockReset();
  readSources.mockReset();
  listDocuments.mockRejectedValue(new Error("Graph evaluation must not read current documents"));
  readSources.mockRejectedValue(new Error("Graph evaluation must not enable source search"));
});
it("keeps graph-only evaluation independent of current documents and retained-source availability", async () => {
  run.mockResolvedValue({
    text: "Graph answer",
    runs: [],
    tools: [],
    trace: [],
    passages: new Map(),
    model: "mock-1",
    durationMs: 1,
    usage: { input: 1, output: 1 },
  });
  const answer = await executeGraphAnswer(ctx, input, () => {}, new AbortController().signal);
  expect(listDocuments).not.toHaveBeenCalled();
  expect(readSources).not.toHaveBeenCalled();
  expect(run.mock.calls[0][0]).toMatchObject({ searchDocuments: undefined, initialPassages: undefined, sourceNotice: undefined });
  expect(answer.agent?.sourceCoverage).toBeUndefined();
  expect(answer.agent?.completion).toBe("complete");
});
it("propagates model failures to evaluation retries instead of returning a successful capture", async () => {
  run.mockRejectedValue(new Error("Provider unavailable"));
  await expect(executeGraphAnswer(ctx, input, () => {}, new AbortController().signal)).rejects.toThrow("Provider unavailable");
});
it("lets HTTP Ask retain an explicitly failed partial turn with its error event", async () => {
  run.mockImplementation(async ({ emit }) => {
    emit({ type: "text", text: "Already streamed context" });
    throw new Error("Provider unavailable");
  });
  const events: ChatEvent[] = [];
  const answer = await executeGraphAnswer(ctx, { ...input, retainPartial: true }, (e) => events.push(e), new AbortController().signal);
  expect(answer.content).toBe("Already streamed context");
  expect(answer.agent).toMatchObject({ completion: "failed", error: "Provider unavailable" });
  expect(events.at(-1)).toEqual({ type: "error", message: "Provider unavailable" });
});
