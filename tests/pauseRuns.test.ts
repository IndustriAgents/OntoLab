import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers";
import { createLocalStore } from "../server/store/local";
import { startWorker, type WorkerHandle } from "../server/worker";
import { silentLogger } from "../server/services/context";
import * as induction from "../server/services/induction";
import type { Project, RunView, RevisionWithContent } from "../src/types/project";
let app: TestApp, client: Client, pid: string, doc: string, worker: WorkerHandle;
beforeEach(async () => {
  // Share the HTTP app's temporary store with its worker.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  storeDir = await mkdtemp(join(tmpdir(), "ontolab-pause-"));
  const store = createLocalStore(storeDir);
  app = await startApp({ store });
  worker = startWorker(store, silentLogger, { autoStart: false, now: () => app.clock.now })!;
  client = app.as("owner");
  pid = (
    await client.json<{ project: Project }>("POST", "/api/projects", {
      name: "Pause checks",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  doc = (
    await client.upload(`/api/projects/${pid}/documents`, "source.txt", "A Sensor measures pressure. A Controller controls the Sensor.")
  ).body.document.id as string;
});
let storeDir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  await worker.stop();
  await app.close();
  await (await import("node:fs/promises")).rm(storeDir, { recursive: true, force: true });
});
const create = async (kind: "induction" | "extraction") => {
  const result = await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
    kind,
    documentIds: [doc],
    provider: "mock",
    model: "mock-1",
  });
  expect(result.status).toBe(201);
  return result.body.run;
};
const control = (id: string, action: string) => client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs/${id}/${action}`);
describe("durable pause across activity types", () => {
  it.each(["induction", "extraction"] as const)("keeps a queued %s paused across worker scans and direct advances", async (kind) => {
    if (kind === "extraction") {
      const revision = (
        await client.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
          content: {
            modules: [{ id: "m", name: "core.ttl", turtle: "<http://ex/Sensor> a <http://www.w3.org/2002/07/owl#Class> ." }],
            abox: null,
            baseIri: "http://ex/",
          },
          source: "import",
          summary: "Schema",
        })
      ).body.revision;
      expect(
        (await client.json("POST", `/api/projects/${pid}/revisions/${revision.id}/commit`, { acknowledgedWarnings: true })).status,
      ).toBe(200);
    }
    const run = await create(kind);
    expect((await control(run.id, "pause")).body.run.status).toBe("paused");
    expect((await control(run.id, "pause")).status).toBe(200);
    expect(await worker.tick()).toBe(0);
    expect((await control(run.id, "advance")).body.run.status).toBe("paused");
    expect((await control(run.id, "retry")).body.run.status).toBe("running");
  });
  it("saves an in-flight build step, then stops its worker until resumed", async () => {
    const original = induction.runStep;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = vi.spyOn(induction, "runStep").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const run = await create("induction");
    const tick = worker.tick();
    await started;
    await control(run.id, "pause");
    release();
    await tick;
    const paused = (await client.json<{ run: RunView }>("GET", `/api/projects/${pid}/runs/${run.id}`)).body.run;
    expect(paused.status).toBe("paused");
    expect(paused.completedSteps).toBeGreaterThan(0);
    const calls = call.mock.calls.length;
    expect(await worker.tick()).toBe(0);
    expect(call).toHaveBeenCalledTimes(calls);
    await control(run.id, "retry");
    expect((await driveRun(client, pid, run.id)).status).toBe("ready_for_review");
  });
  it("retains a result if pause arrives while the last step is saving it", async () => {
    const original = induction.finalize;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(induction, "finalize").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const run = await create("induction");
    const tick = worker.tick();
    await started;
    await control(run.id, "pause");
    release();
    await tick;
    const finished = (await client.json<{ run: RunView }>("GET", `/api/projects/${pid}/runs/${run.id}`)).body.run;
    expect(finished.status).toBe("paused");
    await control(run.id, "retry");
    expect(finished.resultRevisionId).toBeTruthy();
    expect((await control(run.id, "advance")).body.run.resultRevisionId).toBe(finished.resultRevisionId);
  });
});
