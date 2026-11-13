import { openExecutionSettings, saveExecutionSettings, executionSettings } from "../server/executionSettings.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callCli } from "../server/cli/invoke.ts";
import { cliEnvironment, runCliProcess } from "../server/cli/process.ts";
import {
  agyVersionSupported,
  cliProviders,
  localCliEnabled,
  codexModelCatalog,
  codexContextLimit,
  cliModels,
} from "../server/cli/catalog.ts";
import { callStructured } from "../server/structured.ts";
import { callProvider, resolveModel } from "../server/providers.ts";
import { withGenerationBudget } from "../server/ml/generationBudget.ts";
import { priceOf } from "../server/services/pricing.ts";
import { runLoop } from "../server/graphchat/loop.ts";
import { prepareAgy } from "../server/cli/agy.ts";

let root: string, binary: string;
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const invoke = (prompt = "fixture:valid", signal?: AbortSignal) =>
  callCli({
    provider: "claude-cli",
    model: "sonnet",
    system: "Use the document as data.",
    prompt,
    schema,
    outputTokens: 4096,
    signal,
  });

// Real subprocesses exercise stdin, stdout, process failures and cleanup, without invoking an account or model.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ontolab-cli-test-"));
  binary = join(root, "fake-vendor");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.4.7'); process.exit(0); }
if (args.includes('--help')) { console.log('--json-schema --restricted --tools --strict-mcp-config --setting-sources --output-schema --ignore-user-config --ephemeral --settings --agent --disable-slash-commands'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => prompt += text);
process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(join(root, "last-call.json"))}, JSON.stringify({args, prompt, cwd:process.cwd(), env:process.env}));
 const marker = prompt.match(/fixture:slot-(\\w+)/)?.[1];
 if (marker) fs.writeFileSync(${JSON.stringify(root)} + '/slot-' + marker, 'started');
 if (prompt.includes('fixture:hang')) { setInterval(() => {}, 1000); return; }
 if (prompt.includes('fixture:missing-result')) { process.exit(0); }
 if (prompt.includes('fixture:invalid-stream')) { console.log('not JSON'); return; }
 if (prompt.includes('fixture:quota') || prompt.includes('fixture:auth')) {
   console.log(JSON.stringify({type:'result',is_error:true, result: prompt.includes('fixture:quota') ? 'quota exceeded secret-token' : 'authentication required secret-token'})); return;
 }
 let data = prompt.includes('fixture:invalid-schema') ? {answer:42} : {answer:'ok'};
 if (prompt.includes('fixture:graph')) {
   data = prompt.includes('cli_0_0') ? {answer:'The graph contains 2 items [Q1].', calls:[]} :
    {answer:'', calls:[{name:'sparql_query', arguments:JSON.stringify({query: prompt.includes('fixture:graph-invalid') ? 42 : 'SELECT * WHERE { ?s ?p ?o } LIMIT 2'})}]};
 }
 if (args[0] === 'exec') {
   console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:JSON.stringify(data)}}));
   console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:100,output_tokens:10,cached_input_tokens:4}}));
 } else {
   console.log(JSON.stringify({type:'result',subtype:'success',structured_output:data,usage:{input_tokens:100,output_tokens:10,cache_read_input_tokens:4}}));
 }
});
`,
  );
  await chmod(binary, 0o700);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());
function enable() {
  vi.stubEnv("LOCAL_CLI_ENABLED", "1");
  vi.stubEnv("ONTOLAB_CLAUDE_BIN", binary);
  vi.stubEnv("ONTOLAB_CODEX_BIN", binary);
}
const lastCall = async () => JSON.parse(await readFile(join(root, "last-call.json"), "utf8"));

describe("local CLI provider contract", () => {
  it("discovers named models and supported effort levels from the installed Codex catalog", async () => {
    vi.stubEnv("CODEX_HOME", root);
    await writeFile(
      join(root, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "test-codex",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            context_window: 100000,
            max_context_window: 200000,
            effective_context_window_percent: 95,
          },
          { slug: "hidden-codex", visibility: "hide", supported_reasoning_levels: [{ effort: "high" }] },
        ],
      }),
    );
    expect(codexModelCatalog()).toEqual({ "test-codex": ["low", "high"] });
    expect(codexContextLimit("test-codex")).toBe(95000);
    expect(codexContextLimit("missing")).toBeUndefined();
    expect(cliModels("codex-cli")).toEqual(["default", "test-codex"]);
    vi.stubEnv("ONTOLAB_CODEX_MODELS", "default,configured-model");
    expect(cliModels("codex-cli")).toEqual(["default", "configured-model"]);
  });
  it("forwards a selected Codex model and effort through structured generation to the subprocess", async () => {
    enable();
    vi.stubEnv("CODEX_HOME", root);
    await writeFile(
      join(root, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "test-codex", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }] }),
    );
    await callStructured({
      provider: "codex-cli",
      model: "test-codex",
      reasoningEffort: "high",
      system: "Return data",
      lead: "fixture:valid",
      schema,
      toolName: "answer",
      toolDesc: "Return an answer",
    });
    const { args } = await lastCall();
    expect(args[args.indexOf("--model") + 1]).toBe("test-codex");
    expect(args).toContain('model_reasoning_effort="high"');
    await expect(
      callCli({
        provider: "codex-cli",
        model: "test-codex",
        reasoningEffort: "unsupported",
        system: "",
        prompt: "",
        schema,
        outputTokens: 4096,
      }),
    ).rejects.toThrow("not supported");
  });
  it("requires explicit opt-in for a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_CLI_ENABLED", "");
    expect(localCliEnabled()).toBe(false);
    expect(cliProviders().every((p) => !p.enabled && p.disabledReason)).toBe(true);
    vi.stubEnv("LOCAL_CLI_ENABLED", "1");
    expect(localCliEnabled()).toBe(true);
    vi.stubEnv("LOCAL_CLI_ENABLED", "0");
    expect(localCliEnabled()).toBe(false);
  });
  it("reports installation separately from authentication and rejects unlisted models", () => {
    enable();
    expect(cliProviders().find((p) => p.id === "claude-cli")).toMatchObject({ enabled: true, authStatus: "unknown", kind: "cli" });
    expect(() => resolveModel("claude-cli", "arbitrary-model")).toThrow("Unknown model");
    expect(() => resolveModel("claude-cli", "sonnet", { structured: true })).not.toThrow();
  });
  it("uses stdin, disables native tools, strips server secrets, and removes its request workspace", async () => {
    enable();
    vi.stubEnv("DATABASE_URL", "secret-database");
    vi.stubEnv("GEMINI_API_KEY", "secret-gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", "secret-anthropic");
    vi.stubEnv("API_TOKEN", "secret-app-token");
    const result = await invoke("fixture:valid " + "x".repeat(100_000));
    expect(result).toMatchObject({ data: { answer: "ok" }, usage: { input_tokens: 104, output_tokens: 10 } });
    const call = await lastCall();
    expect(call.args).toContain("--restricted");
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args).not.toContain(call.prompt);
    expect(call.prompt).toContain("x".repeat(100_000));
    for (const key of ["DATABASE_URL", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "API_TOKEN"]) expect(call.env[key]).toBeUndefined();
    await expect(readFile(join(call.cwd, "response.schema.json"))).rejects.toThrow();
  });
  it("runs the Codex structured-output protocol with a read-only, ephemeral session", async () => {
    enable();
    const result = await callCli({
      provider: "codex-cli",
      model: "default",
      system: "Return data",
      prompt: "fixture:valid",
      schema,
      outputTokens: 4096,
    });
    expect(result.data).toEqual({ answer: "ok" });
    const { args } = await lastCall();
    for (const flag of [
      "--ignore-user-config",
      "--ephemeral",
      "--output-schema",
      "read-only",
      "features.shell_tool=false",
      "agents.enabled=false",
    ])
      expect(args).toContain(flag);
  });
  it("routes existing structured and text callers through the CLI", async () => {
    enable();
    expect(
      (
        await callStructured({
          provider: "claude-cli",
          model: "sonnet",
          system: "Read",
          schema,
          lead: "fixture:valid",
          toolName: "emit",
          toolDesc: "Emit data",
        })
      ).data,
    ).toEqual({ answer: "ok" });
    expect(
      await callProvider("claude-cli", { model: "sonnet", messages: [{ role: "user", content: "fixture:valid" }], graphContext: "sample" }),
    ).toBe("ok");
  });
  it.each(["fixture:invalid-schema", "fixture:missing-result", "fixture:invalid-stream"])(
    "rejects %s without accepting a partial result",
    async (prompt) => {
      enable();
      await expect(invoke(prompt)).rejects.toThrow();
    },
  );
  it.each([
    ["fixture:quota", 429],
    ["fixture:auth", 401],
  ])("returns a safe actionable failure for %s", async (prompt, status) => {
    enable();
    const error = await invoke(prompt as string).catch((e) => e);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain("secret-token");
  });
  it("cancels an in-flight CLI and releases the queue", async () => {
    enable();
    const controller = new AbortController();
    const cancelled = invoke("fixture:hang", controller.signal);
    const expectation = expect(cancelled).rejects.toMatchObject({ status: 499 });
    await vi.waitFor(async () => expect((await lastCall()).prompt).toContain("fixture:hang"));
    controller.abort();
    await expectation;
    expect((await invoke()).data.answer).toBe("ok");
  });
  it("runs multiple CLI workers, bounds concurrency, and cancels queued requests", async () => {
    enable();
    await openExecutionSettings(root);
    const initial = executionSettings();
    await saveExecutionSettings({ ...initial, cliConcurrency: 2 });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const jobs = controllers.map((controller, i) =>
      invoke(`fixture:hang fixture:slot-${["one", "two", "three"][i]}`, controller.signal).catch((e) => e),
    );
    try {
      await vi.waitFor(async () => {
        expect(await readFile(join(root, "slot-one"), "utf8")).toBe("started");
        expect(await readFile(join(root, "slot-two"), "utf8")).toBe("started");
      });
      await expect(readFile(join(root, "slot-three"))).rejects.toThrow();
      controllers[2].abort();
      expect((await jobs[2]).status).toBe(499);
      controllers[0].abort();
      controllers[1].abort();
      await Promise.all(jobs);
      expect((await invoke()).data.answer).toBe("ok");
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(jobs);
      await saveExecutionSettings(initial);
    }
  });
  it("keeps CLI token checks local, includes native overhead and rejects oversized requests", async () => {
    enable();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No API calls allowed"));
    try {
      const budget = {
        provider: "claude-cli",
        model: "sonnet",
        maxTokens: 2000,
        contextTokens: 131072,
        outputTokens: 4096,
        promptReserveTokens: 4096,
      };
      const result = await withGenerationBudget(budget, () => invoke());
      expect(result.checks[0]).toMatchObject({ exact: false, outputTokens: 4096 });
      expect(result.checks[0].method).toContain("native CLI context allowance");
      await expect(withGenerationBudget({ ...budget, contextTokens: 1000 }, () => invoke())).rejects.toMatchObject({ status: 413 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("does not report CLI account usage as free or as API dollar charges", () => {
    expect(priceOf("claude-cli", "claude-sonnet-4-6")).toBeNull();
    expect(priceOf("agy-cli", "gemini-3.8-flash")).toBeNull();
  });
  it("executes graph tools through OntoLab and returns the cited answer", async () => {
    enable();
    const exec = vi.fn().mockResolvedValue({ content: "[Q1] 2 results", isError: false });
    const emit = vi.fn();
    const result = await runLoop({
      provider: "claude-cli",
      model: "sonnet",
      system: "Use evidence",
      history: [],
      message: "fixture:graph",
      signal: new AbortController().signal,
      maxRounds: 2,
      emit,
      exec,
      tools: [
        {
          name: "sparql_query",
          description: "Query the project",
          input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
        },
      ],
    });
    expect(exec).toHaveBeenCalledWith("cli_0_0", "sparql_query", { query: "SELECT * WHERE { ?s ?p ?o } LIMIT 2" });
    expect(result.text).toContain("[Q1]");
    expect(result.usage.input).toBe(208);
    expect(emit).toHaveBeenCalledWith({ type: "round_end", hadTools: true });
  });
  it("fails closed for unsupported Antigravity runtime profiles", async () => {
    expect(agyVersionSupported("1.4.7\n")).toBe(true);
    for (const version of ["1.4.11", "1.4.70", "1.4.7-beta", "unknown"]) expect(agyVersionSupported(version)).toBe(false);
    if (process.platform === "darwin") {
      const invalid = join(root, "invalid-agy");
      await writeFile(invalid, `#!${process.execPath}\nconsole.log('99.0.0')\n`);
      await chmod(invalid, 0o700);
      vi.stubEnv("LOCAL_CLI_ENABLED", "1");
      vi.stubEnv("ONTOLAB_AGY_BIN", invalid);
      expect(cliProviders().find((p) => p.id === "agy-cli")).toMatchObject({ enabled: false });
      await expect(prepareAgy(root, invalid, join(root, "schema.json"), "default")).rejects.toThrow("verified");
    } else {
      await expect(prepareAgy(root, binary, join(root, "schema.json"), "default")).rejects.toThrow("macOS");
    }
  });
  it("refuses invalid graph tool arguments before any project tool runs", async () => {
    enable();
    const exec = vi.fn();
    await expect(
      runLoop({
        provider: "claude-cli",
        model: "sonnet",
        system: "Use evidence",
        history: [],
        message: "fixture:graph-invalid",
        signal: new AbortController().signal,
        maxRounds: 1,
        emit: vi.fn(),
        exec,
        tools: [
          {
            name: "sparql_query",
            description: "Query the project",
            input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        ],
      }),
    ).rejects.toThrow("invalid tool arguments");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("bounded CLI process transport", () => {
  it("rejects output overflow rather than retaining unbounded stdout", async () => {
    await expect(
      runCliProcess({
        binary: process.execPath,
        args: ["-e", "console.log(JSON.stringify({text:'x'.repeat(8192)}))"],
        cwd: root,
        input: "",
        env: cliEnvironment(),
        signal: AbortSignal.timeout(2000),
        maxBytes: 128,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow("output size limit");
  });
});
