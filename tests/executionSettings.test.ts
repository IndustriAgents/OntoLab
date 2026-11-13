import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionSettings, openExecutionSettings, saveExecutionSettings, withExecutionSettings } from "../server/executionSettings.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ontolab-execution-"));
  await openExecutionSettings(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("workspace execution settings", () => {
  it("validates limits before changing disk or active settings", async () => {
    const original = executionSettings();
    for (const change of [
      { cliConcurrency: 0 },
      { cliConcurrency: 1.5 },
      { timeoutMs: 3_600_001 },
      { maxStepAttempts: 0 },
      { maxStepAttempts: 21 },
    ]) {
      expect(() => saveExecutionSettings({ ...original, ...change })).toThrow();
    }
    expect(executionSettings()).toEqual(original);
  });
  it("persists settings, reloads them, and keeps active steps on their original timeout", async () => {
    const original = executionSettings();
    const next = { cliConcurrency: 3, timeoutMs: 900000, maxStepAttempts: 5 };
    await withExecutionSettings(async () => {
      await saveExecutionSettings(next);
      expect(executionSettings()).toEqual(original);
    });
    expect(executionSettings()).toEqual(next);
    expect(JSON.parse(await readFile(join(root, "execution-settings.json"), "utf8"))).toEqual(next);
    await openExecutionSettings(root);
    expect(executionSettings()).toEqual(next);
  });
});
