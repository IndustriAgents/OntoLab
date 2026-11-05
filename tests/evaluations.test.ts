import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type TestApp, type Client } from "./helpers.ts";
import { createLocalStore } from "../server/store/local.ts";
import { createPostgresStore } from "../server/store/postgres.ts";
import type { Store } from "../server/store/types.ts";
import { startWorker } from "../server/worker.ts";
import { silentLogger } from "../server/services/context.ts";
import * as graphChat from "../server/services/graphChat.ts";
import * as http from "../server/http.ts";
import { scoreEvaluation } from "../src/lib/evaluation.ts";
import type { Evaluation } from "../src/types/evaluation.ts";
import type { Project, RevisionWithContent } from "../src/types/project.ts";

let app: TestApp, client: Client, pid: string, baseline: string, candidate: string;
let testStore: Store;
const sourceText = "The baseline graph describes Sensor Alpha. The updated graph adds Sensor Beta.";
const ttl = `@prefix ex: <http://example.org/eval#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Sensor a owl:Class ; rdfs:label "Sensor" .`;
const base = () => `/api/projects/${pid}/evaluations`;

beforeEach(async () => {
  // Each temporary server is an independent client, despite sharing loopback.
  vi.spyOn(http, "clientKey").mockReturnValue(crypto.randomUUID());
  const database = process.env.EVALUATION_TEST_DATABASE_URL;
  const configuredStore = database ? createPostgresStore(database) : undefined;
  app = await startApp({ store: configuredStore });
  testStore = configuredStore ?? createLocalStore(app.dataDir);
  client = app.as("owner");
  pid = (await client.json<{ project: Project }>("POST", "/api/projects", { name: "Answer evaluations" })).body.project.id;
  const store = testStore.forUser({ id: "owner" });
  await store.blobs.put(
    `${pid}/research/source_run/inputs.json`,
    Buffer.from(
      JSON.stringify({
        documents: [{ id: "source_doc", name: "study.txt", checksum: "source-checksum" }],
        documentTexts: { source_doc: { documentId: "source_doc", text: sourceText, pages: [] } },
        chunks: [],
      }),
    ),
    "application/json",
  );
  for (const count of [1, 2]) {
    const response = await client.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
      source: "import",
      summary: `Graph with ${count} sensors`,
      content: {
        baseIri: "http://example.org/eval#",
        modules: [{ id: "m", name: "schema.ttl", turtle: ttl }],
        abox: {
          individuals: Array.from({ length: count }, (_, i) => ({
            id: `sensor_${i}`,
            classUri: "http://example.org/eval#Sensor",
            label: i ? "Sensor Beta" : "Sensor Alpha",
            evidence: [
              { runId: "source_run", documentId: "source_doc", status: "verified", quote: sourceText, start: 0, end: sourceText.length },
            ],
          })),
        },
      },
    });
    expect(response.status).toBe(201);
    const revision = response.body.revision;
    expect((await client.json("POST", `/api/projects/${pid}/revisions/${revision.id}/commit`, { acknowledgedWarnings: true })).status).toBe(
      200,
    );
    if (count === 1) baseline = revision.id;
    else candidate = revision.id;
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await testStore.forUser({ id: "owner" }).projects.delete(pid);
  await app.close();
  await testStore.close?.();
});

async function create(overrides: Record<string, unknown> = {}) {
  const result = await client.json<{ evaluation: Evaluation }>("POST", base(), {
    title: "Before and after",
    baselineRevisionId: baseline,
    candidateRevisionId: candidate,
    provider: "mock",
    model: "mock-1",
    questions: [{ text: "Which sensors are in the graph?", expectation: "Identify the sensors present in this graph version." }],
    ...overrides,
  });
  expect(result.status).toBe(201);
  return result.body.evaluation;
}
async function action(id: string, name: string, body: unknown = {}) {
  return client.json<{ evaluation: Evaluation }>("POST", `${base()}/${id}/${name}`, body);
}
async function drive(id: string) {
  let item = (await action(id, "start")).body.evaluation;
  for (let i = 0; i < 50 && ["queued", "running"].includes(item.state); i++) item = (await action(id, "advance")).body.evaluation;
  return item;
}
async function review(item: Evaluation, captureId: string, grade = "correct", previousId: string | null = null) {
  const capture = item.attempts.at(-1)!.captures.find((c) => c.id === captureId)!;
  return action(item.id, "reviews", {
    captureId,
    grade,
    support: "supported",
    reason: "The saved source and query results support this answer.",
    sourceId: capture.sources[0]?.id,
    quote: sourceText,
    previousId,
    confirmedSourceReview: true,
  });
}

describe("saved graph answer comparisons", () => {
  it("edits setup before execution, rejects stale edits, and freezes setup at the first run", async () => {
    const item = await create();
    const changes = {
      version: item.version,
      title: "Edited before running",
      provider: "mock",
      model: "mock-1",
      baselineRevisionId: candidate,
      candidateRevisionId: baseline,
      questions: [
        {
          text: "How many sensors are present?",
          expectation: "Count the saved sensors.",
          origin: "competency",
          competencyQuestionId: "cq1",
        },
      ],
    };
    const edited = await client.json<{ evaluation: Evaluation }>("PATCH", `${base()}/${item.id}`, changes);
    expect(edited.status).toBe(200);
    expect(edited.body.evaluation.id).toBe(item.id);
    expect(edited.body.evaluation.questions[0].competencyQuestionId).toBe("cq1");
    expect((await client.json("PATCH", `${base()}/${item.id}`, changes)).status).toBe(409);
    const done = await drive(item.id);
    expect(done.attempts[0].captures.map((c) => c.answer)).toEqual([
      expect.stringContaining("2 labelled individuals"),
      expect.stringContaining("1 labelled individual"),
    ]);
    expect((await client.json("PATCH", `${base()}/${item.id}`, { ...changes, version: done.version })).status).toBe(409);
  });

  it("retries only failed answers and keeps successful reviews and the earlier report", async () => {
    const execution = vi.spyOn(graphChat, "executeGraphAnswer").mockRejectedValueOnce(new Error("Temporary provider failure"));
    let item = await drive((await create()).id);
    const success = item.attempts[0].captures.find((c) => !c.error)!;
    item = (await review(item, success.id)).body.evaluation;
    item = (await action(item.id, "reports")).body.evaluation;
    const exportPath = `${base()}/${item.id}/reports/${item.reports[0].id}/export`;
    const originalReport = (await client.json("GET", exportPath)).body;
    item = (await action(item.id, "retry")).body.evaluation;
    expect(item.attempts[1].captures.map((c) => c.id)).toEqual([success.id]);
    expect(item.judgments).toHaveLength(1);
    item = (await action(item.id, "advance")).body.evaluation;
    expect(item.state).toBe("awaiting_review");
    expect(execution).toHaveBeenCalledTimes(3);
    expect(scoreEvaluation(item, item.attempts[1]).reviewed).toBe(1);
    expect(item.attempts[1].usageUncertain).toBe(true);
    expect((await client.json("GET", exportPath)).body).toEqual(originalReport);
    expect((await action(item.id, "retry")).status).toBe(409);
  });

  it("accepts an exact selected occurrence while rejecting ambiguous or forged source positions", async () => {
    const item = await drive((await create()).id);
    const capture = item.attempts[0].captures[0];
    const body = {
      captureId: capture.id,
      grade: "correct",
      support: "supported",
      sourceId: capture.sources[0].id,
      quote: "graph",
      reason: "This exact source occurrence was selected.",
      confirmedSourceReview: true,
    };
    expect((await action(item.id, "reviews", body)).status).toBe(400);
    expect((await action(item.id, "reviews", { ...body, start: 0, end: 5 })).status).toBe(400);
    const start = sourceText.lastIndexOf("graph");
    const saved = await action(item.id, "reviews", { ...body, start, end: start + 5 });
    expect(saved.status).toBe(200);
    expect(saved.body.evaluation.judgments[0]).toMatchObject({ quote: "graph", start, end: start + 5 });
  });

  it("uses the current Ask engine on pinned saved versions without creating conversations", async () => {
    const execution = vi.spyOn(graphChat, "executeGraphAnswer");
    const item = await create();
    expect(execution).not.toHaveBeenCalled();
    expect(item.state).toBe("draft");
    const store = testStore.forUser({ id: "owner" });
    // The source revisions can be removed after setup: evaluation uses its own snapshots.
    await store.revisions.delete(pid, baseline);
    const done = await drive(item.id);
    expect(done.state).toBe("awaiting_review");
    const captures = done.attempts[0].captures;
    expect(captures.map((c) => c.answer)).toEqual([
      expect.stringContaining("1 labelled individual"),
      expect.stringContaining("2 labelled individuals"),
    ]);
    expect(captures.every((c) => c.agent?.runs.some((r) => r.ok && r.purpose === "agent"))).toBe(true);
    expect(captures.every((c) => !c.agent?.tools.some((t) => t.name === "search_documents"))).toBe(true);
    expect(execution).toHaveBeenCalledTimes(2);
    expect(execution.mock.calls[0][1].graphRevision?.id).toBe(baseline);
    expect(execution.mock.calls[1][1].graphRevision?.id).toBe(candidate);
    expect((await client.json<{ conversations: unknown[] }>("GET", `/api/projects/${pid}/conversations`)).body.conversations).toEqual([]);
    expect(captures[0].sources[0].available).toBe(true);
  });

  it("retains source text, rejects invented evidence and stale reviews, and keeps old reports immutable", async () => {
    let item = await drive((await create()).id);
    const captures = item.attempts[0].captures;
    const source = captures[0].sources[0];
    const store = testStore.forUser({ id: "owner" });
    await store.blobs.delete(`${pid}/research/source_run/inputs.json`);
    expect((await client.json<{ text: string }>("GET", `${base()}/${item.id}/sources/${source.id}`)).body.text).toBe(sourceText);
    const invalid = await action(item.id, "reviews", {
      captureId: captures[0].id,
      grade: "correct",
      support: "supported",
      sourceId: source.id,
      quote: "This evidence was fabricated.",
      reason: "An invalid review must not be saved.",
      confirmedSourceReview: true,
    });
    expect(invalid.status).toBe(400);
    expect((await action(item.id, "reports")).status).toBe(409);
    for (const capture of captures) {
      const saved = await review(item, capture.id);
      expect(saved.status).toBe(200);
      item = saved.body.evaluation;
    }
    expect((await review(item, captures[0].id)).status).toBe(409);
    item = (await action(item.id, "reports")).body.evaluation;
    expect(item.reports[0].reviewed).toBe(2);
    const path = `${base()}/${item.id}/reports/${item.reports[0].id}/export`;
    const original = (await client.json("GET", path)).body;
    const previous = item.judgments.find((j) => j.captureId === captures[1].id)!;
    item = (await review(item, captures[1].id, "incorrect", previous.id)).body.evaluation;
    item = (await action(item.id, "reports")).body.evaluation;
    expect(item.reports).toHaveLength(2);
    expect(item.reports[1].outcomes[0].outcome).toBe("regressed");
    expect((await client.json("GET", path)).body).toEqual(original);
    expect(item.judgments.every((j) => j.origin === "human")).toBe(true);
  });

  it("does not replay an expired in-flight request without an explicit linked retry", async () => {
    const item = await create();
    const started = (await action(item.id, "start")).body.evaluation;
    const store = testStore.forUser({ id: "owner" });
    started.state = "running";
    started.attempts[0].state = "running";
    started.attempts[0].inFlight = { arm: "baseline", questionId: started.questions[0].id, startedAt: app.clock.now.toISOString() };
    started.attempts[0].lease = { holder: "crashed-process", expiresAt: "2020-01-01T00:00:00Z" };
    const version = started.version;
    started.version++;
    await store.evaluations.put(started, version);
    const execution = vi.spyOn(graphChat, "executeGraphAnswer");
    const interrupted = (await action(item.id, "advance")).body.evaluation;
    expect(interrupted.state).toBe("interrupted");
    expect(execution).not.toHaveBeenCalled();
    const retry = (await action(item.id, "retry")).body.evaluation;
    expect(retry.attempts[1].retryOf).toBe(started.attempts[0].id);
    expect(retry.attempts[0].state).toBe("interrupted");
  });

  it("serializes competing advances and preserves completed answers through cancellation and retry", async () => {
    const original = graphChat.executeGraphAnswer;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const execution = vi.spyOn(graphChat, "executeGraphAnswer").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const item = await create();
    await action(item.id, "start");
    const first = action(item.id, "advance");
    await started;
    const second = await action(item.id, "advance");
    expect(second.body.evaluation.attempts[0].captures).toHaveLength(0);
    const pending = scoreEvaluation(second.body.evaluation, second.body.evaluation.attempts[0]);
    expect(pending.outcomes[0].outcome).toBe("unreviewed");
    expect(pending.errors).toBe(0);
    expect(pending.costUsd).toBeNull();
    expect(execution).toHaveBeenCalledTimes(1);
    await action(item.id, "cancel");
    release();
    await first;
    const cancelled = (await client.json<{ evaluation: Evaluation }>("GET", `${base()}/${item.id}`)).body.evaluation;
    expect(cancelled.state).toBe("cancelled");
    const completed = cancelled.attempts[0].captures.length;
    let retry = (await action(item.id, "retry")).body.evaluation;
    expect(retry.attempts[1].captures).toHaveLength(completed);
    for (let i = 0; i < 4 && retry.state === "queued"; i++) retry = (await action(item.id, "advance")).body.evaluation;
    expect(retry.state).toBe("awaiting_review");
    expect(retry.attempts[1].captures).toHaveLength(2);
    expect(execution.mock.calls.length).toBe(3 - completed);
  });

  it("runs in the background worker and keeps all evaluation routes owner scoped", async () => {
    const item = await create();
    await action(item.id, "start");
    const worker = startWorker(testStore, silentLogger, { autoStart: false, now: () => app.clock.now })!;
    try {
      await worker.tick();
      await worker.tick();
      const saved = (await client.json<{ evaluation: Evaluation }>("GET", `${base()}/${item.id}`)).body.evaluation;
      expect(saved.state).toBe("awaiting_review");
      const other = app.as("other");
      for (const suffix of ["", `/${item.id}`, `/${item.id}/sources/${saved.attempts[0].captures[0].sources[0].id}`])
        expect((await other.get(base() + suffix)).status).toBe(404);
      expect((await other.json("POST", `${base()}/${item.id}/advance`)).status).toBe(404);
    } finally {
      await worker.stop();
    }
  });

  it("keeps model failures and changed expectations distinct from regressions", async () => {
    vi.spyOn(graphChat, "executeGraphAnswer").mockRejectedValueOnce(new Error("Provider failed"));
    let item = await drive(
      (
        await create({
          questions: [
            {
              text: "Which sensors are listed?",
              expectation: "Name Sensor Alpha and Beta.",
              baselineExpectation: "Name only Sensor Alpha.",
            },
          ],
        })
      ).id,
    );
    expect(item.attempts[0].captures[0].error).toBe("Provider failed");
    const second = item.attempts[0].captures[1];
    item = (await review(item, second.id)).body.evaluation;
    item = (await action(item.id, "reports")).body.evaluation;
    expect(item.reports[0].errors).toBe(1);
    expect(item.reports[0].outcomes[0].outcome).toBe("error");
  });

  it("pins source identity at setup and can report unavailable evidence without inventing a judgment", async () => {
    const item = await create({
      questions: [
        {
          text: "Which sensors are present?",
          expectation: "Name Sensor Alpha and Sensor Beta.",
          baselineExpectation: "Name Sensor Alpha only.",
        },
      ],
    });
    const store = testStore.forUser({ id: "owner" });
    await store.blobs.put(
      `${pid}/research/source_run/inputs.json`,
      Buffer.from(
        JSON.stringify({
          documents: [{ id: "source_doc", name: "study.txt", checksum: "source-checksum" }],
          documentTexts: {
            source_doc: { documentId: "source_doc", text: "Different parser output must not replace the pinned source.", pages: [] },
          },
        }),
      ),
      "application/json",
    );
    let done = await drive(item.id);
    for (const capture of done.attempts[0].captures) {
      expect(capture.sources[0].available).toBe(false);
      expect(capture.sources[0].issue).toContain("changed after comparison setup");
      expect((await client.get(`${base()}/${item.id}/sources/${capture.sources[0].id}`)).status).toBe(410);
      const response = await action(item.id, "reviews", {
        captureId: capture.id,
        grade: "unassessable",
        support: "unavailable",
        reason: "The retained source changed, so source support cannot be assessed.",
        confirmedSourceReview: true,
      });
      expect(response.status).toBe(200);
      done = response.body.evaluation;
    }
    done = (await action(item.id, "reports")).body.evaluation;
    expect(done.reports[0].assessable).toBe(0);
    expect(done.reports[0].unavailableSources).toBe(2);
    expect(done.reports[0].outcomes[0].outcome).toBe("changed_expectation");
  });

  it("respects current project spending limits before starting provider work", async () => {
    const item = await create();
    const store = testStore.forUser({ id: "owner" });
    const project = (await store.projects.get(pid))!;
    await store.projects.update(pid, { settings: { ...project.settings, budget: { maxUsdTotal: 0 } } });
    const execution = vi.spyOn(graphChat, "executeGraphAnswer");
    expect((await action(item.id, "start")).status).toBe(409);
    expect(execution).not.toHaveBeenCalled();
  });
});
