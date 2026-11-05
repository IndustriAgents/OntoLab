import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startApp, type TestApp } from "./helpers";
import { defaultGenerationBudget as uiBudget } from "../src/lib/generationLimits";
import { defaultGenerationBudget as serverBudget } from "../server/ml/tokenization";
import type { Project } from "../src/types/project";
import type { ProviderInfo } from "../src/lib/api";

let app: TestApp | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

it.each(["codex-cli", "claude-cli", "agy-cli", "openai", "claude", "gemini", "ollama", "mock"])(
  "uses an editable 100,000-token planning default for %s",
  (provider) => {
    for (const model of ["large", "small", "unknown"]) {
      expect(uiBudget(provider, model).contextTokens).toBe(100000);
      expect(serverBudget(provider, model).contextTokens).toBe(100000);
    }
  },
);

it("keeps reported model capacity separate from the 100,000-token corpus default", async () => {
  app = await startApp();
  vi.stubEnv("CODEX_HOME", app.dataDir);
  vi.stubEnv("LOCAL_CLI_ENABLED", "1");
  vi.stubEnv("ONTOLAB_CODEX_BIN", process.execPath);
  await writeFile(
    join(app.dataDir, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "catalog-large",
          visibility: "list",
          context_window: 500000,
          max_context_window: 872000,
          effective_context_window_percent: 95,
        },
        { slug: "catalog-small", visibility: "list", context_window: 272000, effective_context_window_percent: 95 },
      ],
    }),
  );
  const c = app.as("alice");
  const providers = (await c.json<{ providers: ProviderInfo[] }>("GET", "/api/providers")).body.providers;
  const windows = providers.find((p) => p.id === "codex-cli")!.contextWindows!;
  expect(windows).toEqual({ "catalog-large": 475000, "catalog-small": 258400 });
  for (const model of ["catalog-large", "catalog-small"]) {
    expect(serverBudget("codex-cli", model)).toEqual(uiBudget("codex-cli", model));
  }
  const parent = (
    await c.json<{ project: Project }>("POST", "/api/projects", { name: "Defaults", settings: { models: { embeddings: "hash" } } })
  ).body.project;
  const revision = (
    await c.json<{ revision: { id: string } }>("POST", `/api/projects/${parent.id}/revisions`, {
      source: "import",
      content: { modules: [{ id: "core", name: "schema", turtle: "<http://ex/Pump> a <http://www.w3.org/2002/07/owl#Class>." }] },
    })
  ).body.revision;
  expect((await c.json("POST", `/api/projects/${parent.id}/revisions/${revision.id}/commit`, { acknowledgedWarnings: true })).status).toBe(
    200,
  );
  const created = await c.json<{ corpus: Project }>("POST", `/api/projects/${parent.id}/corpora`, {
    name: "Model defaults",
    ontologyRevisionId: revision.id,
    provider: "codex-cli",
    model: "catalog-large",
  });
  expect(created.status).toBe(201);
  expect(created.body.corpus.settings.corpus?.chunking?.tokens?.generation).toEqual(serverBudget("codex-cli", "catalog-large"));
});
