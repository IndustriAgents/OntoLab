import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";
import { createLocalStore } from "../server/store/local.ts";
import { advanceRun, retryRun } from "../server/services/runs.ts";
import { silentLogger, type ServiceCtx } from "../server/services/context.ts";
import type { ProjectDocument, RunView } from "../src/types/project.ts";

let app: TestApp | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await app?.close();
});
describe("failed output recovery", () => {
  it("accounts for a failed generation and raises the retry reserve without replacing the run or its sources", async () => {
    app = await startApp();
    const client = app.as("alice");
    const { project } = (
      await client.json<{ project: { id: string } }>("POST", "/api/projects", {
        name: "Recovery",
        settings: { models: { embeddings: "hash", nli: "lexical" } },
      })
    ).body;
    const doc = (await client.upload(`/api/projects/${project.id}/documents`, "notes.txt", "A scientist tests a hypothesis.")).body
      .document as ProjectDocument;
    const created = (
      await client.json<{ run: RunView }>("POST", `/api/projects/${project.id}/runs`, {
        kind: "induction",
        documentIds: [doc.id],
        provider: "mock",
        model: "mock-1",
      })
    ).body.run;
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    const original = (await store.runs.get(project.id, created.id))!;
    const generation = {
      provider: "gemini",
      model: "gemini-3.8-flash",
      maxTokens: 2000,
      contextTokens: 131072,
      outputTokens: 4096,
      promptReserveTokens: 4096,
    };
    await store.runs.update(project.id, created.id, {
      provider: "gemini",
      model: generation.model,
      options: { ...original.options!, tokenization: { embedding: { profile: "hash:384", maxTokens: 256 }, generation } },
    });
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith(":countTokens")
                ? { totalTokens: 100 }
                : {
                    candidates: [{ finishReason: "MAX_TOKENS" }],
                    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 70 },
                  },
            ),
            { status: 200 },
          ),
      ),
    );
    const ctx = { store, user: { id: "alice" }, now: () => app!.clock.now, log: silentLogger, requestId: "test" } as ServiceCtx;
    const failed = (await advanceRun(ctx, project.id, created.id)).run;
    expect(failed.status).toBe("failed");
    expect(failed.completedSteps).toBe(0);
    expect(failed.usage).toEqual({ inputTokens: 100, outputTokens: 100 });
    const retried = await retryRun(ctx, project.id, created.id);
    expect(retried.id).toBe(created.id);
    expect(retried.documentIds).toEqual([doc.id]);
    expect(retried.options?.tokenization?.generation.outputTokens).toBe(16384);
    expect(retried.notes.join(" ")).toContain("raised Gemini's total output reserve from 4096 to 16384");
    expect(retried.status).toBe("running");
    expect(retried.usage).toEqual(failed.usage);
  });
});
