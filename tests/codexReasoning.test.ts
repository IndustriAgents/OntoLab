import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driveRun, startApp, type Client, type TestApp } from "./helpers.ts";
import type { ProjectDocument, RunView } from "../src/types/project.ts";
import * as structured from "../server/structured.ts";
import { mockStructured } from "../server/mockLlm.ts";
import * as cli from "../server/cli/invoke.ts";

let app: TestApp;
let client: Client;
let pid: string;
let document: ProjectDocument;
beforeEach(async () => {
  app = await startApp();
  client = app.as("alice");
  vi.stubEnv("CODEX_HOME", app.dataDir);
  vi.stubEnv("LOCAL_CLI_ENABLED", "1");
  vi.stubEnv("ONTOLAB_CODEX_BIN", "/usr/bin/true");
  await writeFile(
    join(app.dataDir, "models_cache.json"),
    JSON.stringify({
      models: [{ slug: "test-codex", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
    }),
  );
  pid = (
    await client.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Recorded reasoning",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  document = (await client.upload(`/api/projects/${pid}/documents`, "manual.txt", "A Sensor measures pressure in a Device.")).body
    .document as ProjectDocument;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await app.close();
});
const input = () => ({
  kind: "induction",
  mode: "automatic",
  provider: "codex-cli",
  model: "test-codex",
  documentIds: [document.id],
  options: { reasoningEffort: "high" },
});
describe("recorded Codex reasoning effort", () => {
  it("keeps the selected effort in the run and forwards it to every structured generation stage", async () => {
    const calls = vi.spyOn(structured, "callStructured").mockImplementation(mockStructured);
    const created = await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, input());
    expect(created.status).toBe(201);
    expect(created.body.run.options?.reasoningEffort).toBe("high");
    expect((await driveRun(client, pid, created.body.run.id)).status).toBe("ready_for_review");
    expect(calls).toHaveBeenCalled();
    for (const [call] of calls.mock.calls)
      expect(call).toMatchObject({ provider: "codex-cli", model: "test-codex", reasoningEffort: "high" });
  });
  it("rejects unsupported effort before estimation or creating a run", async () => {
    const body = { ...input(), options: { reasoningEffort: "ultra" } };
    expect((await client.json("POST", `/api/projects/${pid}/runs/estimate`, body)).status).toBe(400);
    expect((await client.json("POST", `/api/projects/${pid}/runs`, body)).status).toBe(400);
    expect((await client.json<{ runs: RunView[] }>("GET", `/api/projects/${pid}/runs`)).body.runs).toEqual([]);
  });
  it("forwards assistant effort through every tool round and records the actual model settings", async () => {
    const calls = vi
      .spyOn(cli, "callCli")
      .mockResolvedValueOnce({
        data: { answer: "", calls: [{ name: "get_project_context", arguments: JSON.stringify({ projectId: pid }) }] },
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        data: { answer: "Inspected this project.", calls: [] },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const result = await client.json<{ threadId: string; message: string }>("POST", `/api/projects/${pid}/agent/chat`, {
      message: "Inspect this project",
      provider: "codex-cli",
      model: "test-codex",
      reasoningEffort: "high",
    });
    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Inspected this project.");
    expect(calls).toHaveBeenCalledTimes(2);
    for (const [call] of calls.mock.calls)
      expect(call).toMatchObject({ provider: "codex-cli", model: "test-codex", reasoningEffort: "high" });
    const saved = await client.json<{ messages: { role: string; execution?: Record<string, string> }[] }>(
      "GET",
      `/api/projects/${pid}/agent/conversations/${result.body.threadId}`,
    );
    expect(saved.body.messages.at(-1)?.execution).toEqual({ provider: "codex-cli", model: "test-codex", reasoningEffort: "high" });
  });
  it("rejects unsupported assistant effort before invoking the model", async () => {
    const calls = vi.spyOn(cli, "callCli");
    const result = await client.json("POST", `/api/projects/${pid}/agent/chat`, {
      message: "Inspect this project",
      provider: "codex-cli",
      model: "test-codex",
      reasoningEffort: "ultra",
    });
    expect(result.status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });
  it("lets the model use its default effort without sending an override", async () => {
    const calls = vi.spyOn(cli, "callCli").mockResolvedValue({
      data: { answer: "Inspected this project.", calls: [] },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await client.json("POST", `/api/projects/${pid}/agent/chat`, {
      message: "Inspect this project",
      provider: "codex-cli",
      model: "test-codex",
      reasoningEffort: "default",
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0][0].reasoningEffort).toBeUndefined();
  });
  it("continues the project conversation when a newly created draft becomes selected", async () => {
    const calls = vi.spyOn(cli, "callCli").mockResolvedValue({
      data: { answer: "The selected context is ready.", calls: [] },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const first = await client.json<{ threadId: string }>("POST", `/api/projects/${pid}/agent/chat`, {
      message: "Build an ontology",
      provider: "codex-cli",
      model: "test-codex",
    });
    expect(first.status).toBe(200);
    const draft = await client.json<{ revision: { id: string } }>("POST", `/api/projects/${pid}/revisions`, {
      content: {
        modules: [
          {
            id: "core",
            name: "Equipment",
            turtle: "@prefix owl: <http://www.w3.org/2002/07/owl#> . <https://example.org/Pump> a owl:Class .",
          },
        ],
        abox: null,
        baseIri: "https://example.org/",
      },
      summary: "Assistant draft",
      source: "ontology",
    });
    expect(draft.status).toBe(201);
    const second = await client.json<{ threadId: string }>("POST", `/api/projects/${pid}/agent/chat`, {
      message: "Validate this draft",
      threadId: first.body.threadId,
      revisionId: draft.body.revision.id,
      provider: "codex-cli",
      model: "test-codex",
    });
    expect(second.status).toBe(200);
    expect(second.body.threadId).toBe(first.body.threadId);
    expect(calls.mock.calls.at(-1)?.[0].prompt).toContain("workspace selection changed");
    const saved = await client.json<{ revisionId: string; messages: unknown[] }>(
      "GET",
      `/api/projects/${pid}/agent/conversations/${first.body.threadId}`,
    );
    expect(saved.body.revisionId).toBe(draft.body.revision.id);
    expect(saved.body.messages).toHaveLength(4);
  });
});
