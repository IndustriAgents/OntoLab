import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers.ts";
import { createLocalStore } from "../server/store/local.ts";
import { startWorker } from "../server/worker.ts";
import { silentLogger } from "../server/services/context.ts";
import * as structured from "../server/structured.ts";
import * as revisions from "../server/services/revisions.ts";
import { mockStructured } from "../server/mockLlm.ts";
import { alignmentWorkEstimate } from "../server/services/alignment.ts";
import { costUsd } from "../server/services/pricing.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import type { AlignmentEstimate, AlignmentSetup } from "../src/types/alignment.ts";
import type { JobCheckpoint, OntologyRevision, RevisionWithContent, RunView } from "../src/types/project.ts";

const ontology = (namespace: string) => `@prefix : <${namespace}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
${Array.from({ length: 24 }, (_, n) => `:Device${n} a owl:Class; rdfs:label "Device ${n}" .`).join("\n")}`;
const setup: AlignmentSetup = {
  sourceModules: ["a"],
  targetModules: ["b"],
  matchers: { lexical: true, semantic: false, structural: false },
  verify: true,
  provider: "mock",
  model: "mock-1",
  maxSource: null,
};
let app: TestApp, client: Client, pid: string, rid: string;
let original: RevisionWithContent;
const revisionRoute = () => `/api/projects/${pid}/revisions/${rid}`;
const runRoute = (id: string) => `/api/projects/${pid}/runs/${id}`;
const start = (patch: Partial<AlignmentSetup> = {}, expectedHash?: string) =>
  client.json<{ run: RunView }>("POST", `${revisionRoute()}/align/runs`, { setup: { ...setup, ...patch }, expectedHash });
const advance = async (id: string) => (await client.json<{ run: RunView }>("POST", `${runRoute(id)}/advance`)).body.run;
const readRun = async (id: string) => (await client.json<{ run: RunView }>("GET", runRoute(id))).body.run;
const research = async (id: string) => (await client.json<{ checkpoints: JobCheckpoint[] }>("GET", `${runRoute(id)}/research`)).body;

beforeEach(async () => {
  app = await startApp();
  client = app.as("alignment-owner");
  pid = (
    await client.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Background alignment",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  rid = (
    await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions`, {
      source: "import",
      summary: "Compare",
      content: {
        baseIri: "https://a.test/#",
        abox: null,
        modules: [
          { id: "a", name: "a.ttl", turtle: ontology("https://a.test/#") },
          { id: "b", name: "b.ttl", turtle: ontology("https://b.test/#") },
        ],
      },
    })
  ).body.revision.id;
  original = (await client.json<{ revision: RevisionWithContent }>("GET", revisionRoute())).body.revision;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

describe("background alignment", () => {
  it("estimates selected coverage without calling models or creating a run", async () => {
    const calls = vi.spyOn(structured, "callStructured");
    const estimate = await client.json<{ estimate: AlignmentEstimate }>("POST", `${revisionRoute()}/align/estimate`, {
      setup: { ...setup, maxSource: 3 },
      expectedHash: original.contentHash,
    });
    expect(estimate.status).toBe(200);
    expect(estimate.body.estimate).toMatchObject({
      sourceTerms: 24,
      processedSourceTerms: 3,
      maxCandidatePairs: 6,
      modelCalls: 1,
      usd: 0,
      priced: true,
    });
    expect(estimate.body.estimate.inputTokens).toBeGreaterThan(0);
    const free = await client.json<{ estimate: AlignmentEstimate }>("POST", `${revisionRoute()}/align/estimate`, {
      setup: { ...setup, verify: false },
    });
    expect(free.body.estimate).toMatchObject({ modelCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(calls).not.toHaveBeenCalled();
    expect((await client.json<{ runs: RunView[] }>("GET", `/api/projects/${pid}/runs`)).body.runs).toEqual([]);
    expect((await start({}, "stale-hash")).status).toBe(409);
    expect((await client.json("POST", `${revisionRoute()}/align/estimate`, { setup, expectedHash: "stale-hash" })).status).toBe(409);
  });

  it("persists pause across worker restarts and resumes saved batches without charging twice", async () => {
    const calls = vi.spyOn(structured, "callStructured");
    const created = await start();
    expect(created.status).toBe(201);
    const id = created.body.run.id;
    expect(created.body.run).toMatchObject({ kind: "alignment", status: "queued", baseRevisionId: rid });
    expect((await advance(id)).completedStepKeys).toContain("alignment:retrieve");
    expect((await advance(id)).completedStepKeys).toContain("alignment:verify:0");
    const before = await readRun(id);
    expect((await client.json<{ run: RunView }>("POST", `${runRoute(id)}/pause`)).body.run.status).toBe("paused");
    expect((await advance(id)).usage).toEqual(before.usage);
    const worker = startWorker(createLocalStore(app.dataDir), silentLogger, { autoStart: false, now: () => app.clock.now })!;
    try {
      expect(await worker.tick()).toBe(0);
      expect((await client.json<{ run: RunView }>("POST", `${runRoute(id)}/retry`)).body.run.status).toBe("running");
      expect(await worker.tick()).toBe(1);
    } finally {
      await worker.stop();
    }
    const done = await readRun(id);
    expect(done.status).toBe("ready_for_review");
    const checkpoints = (await research(id)).checkpoints;
    const classified = checkpoints.filter((cp) => cp.key.startsWith("alignment:verify:"));
    expect(classified.length).toBeGreaterThan(1);
    expect(calls).toHaveBeenCalledTimes(classified.length);
    expect(done.usage).toEqual(
      checkpoints.reduce(
        (total, cp) => ({
          inputTokens: total.inputTokens + cp.usage.inputTokens,
          outputTokens: total.outputTokens + cp.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
    );
    expect(done.resultRevisionId).not.toBe(rid);
    const result = (await client.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`))
      .body.revision;
    expect(result).toMatchObject({ status: "draft", runId: id });
    expect(result.content.review!.alignmentRuns!.at(-1)!.diagnostics.processedSourceTerms).toBe(24);
    expect(result.content.review!.alignment!.every((m) => m.verified)).toBe(true);
    expect((await client.json<{ revision: RevisionWithContent }>("GET", revisionRoute())).body.revision.contentHash).toBe(
      original.contentHash,
    );
    expect((await advance(id)).resultRevisionId).toBe(done.resultRevisionId);
    expect(
      (await client.json<{ revisions: OntologyRevision[] }>("GET", `/api/projects/${pid}/revisions`)).body.revisions.filter(
        (r) => r.runId === id,
      ),
    ).toHaveLength(1);
  });

  it("finishes an in-flight batch without overwriting a pause or repeating its model call", async () => {
    const id = (await start()).body.run.id;
    await advance(id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const calls = vi.spyOn(structured, "callStructured").mockImplementationOnce(async (call) => {
      entered();
      await gate;
      return { ...(await mockStructured(call)), usage: { input_tokens: 100, output_tokens: 20 } };
    });
    const pending = advance(id);
    try {
      await reached;
      expect((await client.json<{ waitMs: number }>("POST", `${runRoute(id)}/advance`)).body.waitMs).toBeGreaterThan(0);
      expect((await client.json<{ run: RunView }>("POST", `${runRoute(id)}/pause`)).body.run.status).toBe("paused");
    } finally {
      release();
    }
    const paused = await pending;
    expect(paused.status).toBe("paused");
    expect(paused.completedStepKeys).toContain("alignment:verify:0");
    expect(paused.usage.inputTokens).toBeGreaterThan(0);
    await client.json("POST", `${runRoute(id)}/retry`);
    expect((await driveRun(client, pid, id)).status).toBe("ready_for_review");
    expect(calls).toHaveBeenCalledTimes((await research(id)).checkpoints.filter((cp) => cp.key.startsWith("alignment:verify:")).length);
  });

  it("keeps the frozen ontology when its original draft changes", async () => {
    const id = (await start({ verify: false })).body.run.id;
    const changed = {
      ...original.content,
      modules: original.content.modules.map((m) => ({ ...m, turtle: m.turtle.replaceAll("Device", "Changed") })),
    };
    expect((await client.json("PUT", revisionRoute(), { content: changed, expectedHash: original.contentHash })).status).toBe(200);
    const done = await driveRun(client, pid, id);
    expect(done.status).toBe("ready_for_review");
    const result = (await client.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`))
      .body.revision;
    expect(result.content.modules).toEqual(original.content.modules);
    expect(result.content.review!.alignmentRuns!.at(-1)!.inputHash).toBe(original.contentHash);
    expect((await client.json<{ revision: RevisionWithContent }>("GET", revisionRoute())).body.revision.content.modules).toEqual(
      changed.modules,
    );
  });

  it("repairs usage and progress after a crash between checkpoint persistence and run updates", async () => {
    const id = (await start()).body.run.id;
    await advance(id);
    vi.spyOn(structured, "callStructured").mockImplementationOnce(async (call) => ({
      ...(await mockStructured(call)),
      usage: { input_tokens: 123, output_tokens: 45 },
    }));
    await advance(id);
    const store = createLocalStore(app.dataDir).worker!.forOwner("alignment-owner");
    await store.runs.update(pid, id, { usage: { inputTokens: 0, outputTokens: 0 }, completedSteps: 0 });
    expect((await driveRun(client, pid, id)).status).toBe("ready_for_review");
    expect((await readRun(id)).usage.inputTokens).toBe(123);
    expect((await research(id)).checkpoints.filter((cp) => cp.key === "alignment:verify:0")).toHaveLength(1);
  });

  it("retries failed batches and cancelled runs while preserving successful checkpoints and failed-call usage", async () => {
    const id = (await start()).body.run.id;
    await advance(id);
    await advance(id);
    const saved = await readRun(id);
    vi.spyOn(structured, "callStructured").mockRejectedValueOnce(
      Object.assign(new Error("Invalid provider response"), {
        usage: { input_tokens: 200, output_tokens: 30 },
      }),
    );
    const failed = await advance(id);
    expect(failed.status).toBe("failed");
    expect(failed.completedStepKeys).toEqual(saved.completedStepKeys);
    expect(failed.usage.inputTokens).toBe(saved.usage.inputTokens + 200);
    await client.json("POST", `${runRoute(id)}/retry`);
    await client.json("POST", `${runRoute(id)}/cancel`);
    expect((await advance(id)).status).toBe("cancelled");
    await client.json("POST", `${runRoute(id)}/retry`);
    expect((await driveRun(client, pid, id)).status).toBe("ready_for_review");
    const checkpoints = (await research(id)).checkpoints;
    expect(checkpoints.filter((cp) => cp.key === "alignment:verify:0")).toHaveLength(1);
    expect((await readRun(id)).usage.inputTokens).toBe(checkpoints.reduce((sum, cp) => sum + cp.usage.inputTokens, 0) + 200);
  });

  it("recovers a pause after creating the result draft without duplicating that draft", async () => {
    const id = (await start({ verify: false })).body.run.id;
    await advance(id);
    const create = revisions.createRevision;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    vi.spyOn(revisions, "createRevision").mockImplementationOnce(async (...args) => {
      const saved = await create(...args);
      entered();
      await gate;
      return saved;
    });
    const pending = advance(id);
    try {
      await reached;
      await client.json("POST", `${runRoute(id)}/pause`);
    } finally {
      release();
    }
    expect((await pending).status).toBe("paused");
    await client.json("POST", `${runRoute(id)}/retry`);
    expect((await advance(id)).status).toBe("ready_for_review");
    expect(
      (await client.json<{ revisions: OntologyRevision[] }>("GET", `/api/projects/${pid}/revisions`)).body.revisions.filter(
        (r) => r.runId === id,
      ),
    ).toHaveLength(1);
  });

  it("enforces ownership and total budgets, and permits zero-cost matching under a zero generation budget", async () => {
    expect((await app.as("someone-else").json("POST", `${revisionRoute()}/align/runs`, { setup })).status).toBe(404);
    await client.json("PATCH", `/api/projects/${pid}`, { settings: { budget: { maxUsdPerRun: 0 } } });
    const id = (await start({ verify: false })).body.run.id;
    expect((await app.as("someone-else").json("POST", `${runRoute(id)}/pause`)).status).toBe(404);
    expect((await driveRun(client, pid, id)).status).toBe("ready_for_review");
    expect((await readRun(id)).cost?.actualUsd).toBe(0);
    await client.json("PATCH", `/api/projects/${pid}`, { settings: { budget: { maxUsdTotal: 0 } } });
    expect((await start()).status).toBe(409);
  });

  it("does not call a subscription price zero, and budgets only compatible candidate pairs", () => {
    const source = parseTBox(ontology("https://a.test/#"));
    const target = parseTBox("@prefix owl: <http://www.w3.org/2002/07/owl#> . <https://b.test/reading> a owl:DatatypeProperty .");
    const estimate = alignmentWorkEstimate(source, target, null, true);
    expect(estimate).toMatchObject({ maxCandidatePairs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    expect(costUsd("codex-cli", "gpt-4.1", { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });
});
