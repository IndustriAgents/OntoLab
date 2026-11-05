import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGenerationRequest, withGenerationBudget } from "../server/ml/generationBudget";
import * as catalog from "../server/cli/catalog";
import * as induction from "../server/services/induction";
import { defaultGenerationBudget } from "../src/lib/generationLimits";
import { startApp, type TestApp } from "./helpers";
import { createLocalStore } from "../server/store/local";
import { advanceRun, retryRun } from "../server/services/runs";
import { silentLogger, type ServiceCtx } from "../server/services/context";
import type { ProjectDocument, RunView } from "../src/types/project";

let app: TestApp | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});
const budget = defaultGenerationBudget("codex-cli", "test-model");

describe("user-controlled context budgets", () => {
  it("does not silently increase the configured budget even when the model supports more", async () => {
    vi.spyOn(catalog, "codexContextLimit").mockReturnValue(475000);
    await expect(
      withGenerationBudget(budget, () => checkGenerationRequest("codex-cli", "test-model", { prompt: "x".repeat(100000) })),
    ).rejects.toMatchObject({ status: 413 });
    expect(budget.contextTokens).toBe(100000);
    const custom = { ...budget, contextTokens: 200000 };
    const result = await withGenerationBudget(custom, () =>
      checkGenerationRequest("codex-cli", "test-model", { prompt: "x".repeat(100000) }),
    );
    expect(result.checks[0].contextTokens).toBe(200000);
    expect(custom.contextTokens).toBe(200000);
  });
  it("also enforces known model capacity when a user sets a larger request budget", async () => {
    vi.spyOn(catalog, "codexContextLimit").mockReturnValue(50000);
    await expect(
      withGenerationBudget(budget, () => checkGenerationRequest("codex-cli", "test-model", { prompt: "x".repeat(48000) })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("retains explicit limits and checkpoints when retrying unfinished work", async () => {
    app = await startApp();
    const client = app.as("alice");
    const pid = (
      await client.json<{ project: { id: string } }>("POST", "/api/projects", {
        name: "Recovery",
        settings: { models: { embeddings: "hash", nli: "off" } },
      })
    ).body.project.id;
    const doc = (await client.upload(`/api/projects/${pid}/documents`, "source.txt", "A scientific claim.")).body
      .document as ProjectDocument;
    const run = (
      await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
        kind: "induction",
        documentIds: [doc.id],
        provider: "mock",
        model: "mock-1",
      })
    ).body.run;
    const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
    const options = {
      ...run.options!,
      tokenization: { embedding: { profile: "hash:384", maxTokens: 256 }, generation: { ...budget, contextTokens: 200000 } },
    };
    await store.runs.update(pid, run.id, {
      status: "failed",
      error: "Previous interruption",
      provider: budget.provider,
      model: budget.model,
      options,
    });
    vi.spyOn(catalog, "codexContextLimit").mockReturnValue(475000);
    vi.spyOn(induction, "runStep").mockImplementation(async () => {
      await checkGenerationRequest("codex-cli", "test-model", { prompt: "x".repeat(100000) });
      return { abox: { individuals: [] }, notes: [], usage: { inputTokens: 100000, outputTokens: 5 } };
    });
    const ctx = { store, user: { id: "alice" }, now: () => app!.clock.now, log: silentLogger, requestId: "test" } as ServiceCtx;
    const retried = await retryRun(ctx, pid, run.id);
    expect(retried.documentIds).toEqual(run.documentIds);
    expect(retried.options?.tokenization?.generation.contextTokens).toBe(200000);
    const advanced = (await advanceRun(ctx, pid, run.id)).run;
    expect(advanced.status).toBe("running");
    expect(advanced.completedSteps).toBeGreaterThan(0);
    expect(advanced.options?.tokenization?.generation.contextTokens).toBe(200000);
    expect((await store.runs.checkpoints(pid, run.id))[0].trace?.diagnostics?.tokenRequestChecks).toMatchObject([
      { contextTokens: 200000 },
    ]);
  });
});
