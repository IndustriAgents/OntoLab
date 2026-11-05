import { prepareChat } from "../server/services/graphChat.ts";
import { silentLogger } from "../server/services/context.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";
import { seedEvidenceCorpus } from "./sourceEvidenceFixture.ts";
import { createLocalStore } from "../server/store/local.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import type { EvidenceSearchResult } from "../src/types/sourceEvidence.ts";
import type { Conversation, DocumentText } from "../src/types/project.ts";
import type { EvidenceInspection } from "../src/types/evidence.ts";
import type { ResearchInputs } from "../src/types/research.ts";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());

it("searches full retained sources, streams working references, survives replacement and refuses cross-scope evidence", async () => {
  const c = app.as("evidence-user");
  const f = await seedEvidenceCorpus(c, () => app.processDocuments());
  const root = `/api/projects/${f.corpus.id}`;
  const path = `${root}/revisions/${f.revision.id}/evidence`;
  const blobs = createLocalStore(app.dataDir).forUser({ id: "evidence-user" }).blobs;
  const inputPath = `${f.corpus.id}/research/${f.runId}/inputs.json`;
  const bytes = (await blobs.get(inputPath))!;
  // Simulate an extraction that only read an early chunk: full-text search must still find the table.
  const inputs = JSON.parse(bytes.toString()) as ResearchInputs;
  inputs.chunks = inputs.chunks.slice(0, 1).map((c) => ({ ...c, text: c.text.slice(0, 30), end: c.start + 30 }));
  await blobs.put(inputPath, Buffer.from(JSON.stringify(inputs)), "application/json");
  const search = await c.json<EvidenceSearchResult>("POST", `${path}/search`, { query: "load ratio" });
  expect(search.status).toBe(200);
  expect(search.body.coverage).toMatchObject({ available: 1, total: 1 });
  const hit = search.body.passages[0];
  expect(hit.evidence.quote).toContain("R = 0.1");
  expect(hit.evidence.quote).toContain("🧪");
  expect(f.text.slice(hit.evidence.start, hit.evidence.end)).toBe(hit.evidence.quote);
  const context = await c.json<DocumentText>("GET", `${path}/passages/${hit.key}`);
  expect(context.body.text).toBe(f.text);
  expect((await app.as("intruder").json("POST", `${path}/search`, { query: "ratio" })).status).toBe(404);
  expect((await c.json("GET", `${path}/passages/not-a-passage`)).status).toBe(404);
  expect(
    (await c.json("POST", `${root}/assistant/chat`, { question: "ratio", passageKey: "forged", provider: "mock", model: "mock-1" })).status,
  ).toBe(404);

  const response = await c.get(`${root}/corpus`);
  const detail = await response.json();
  const member = detail.corpus.settings.corpus.members[0];
  await c.upload(`${root}/corpus/documents?member=${member.id}`, "replacement.txt", "NEW DOCUMENT: load ratio is secret-new-value.", false);
  await app.processDocuments();
  const repeated = await c.json<EvidenceSearchResult>("POST", `${path}/search`, { query: "load ratio" });
  expect(repeated.body.passages).toEqual(search.body.passages);
  expect((await c.json<EvidenceSearchResult>("POST", `${path}/search`, { query: "secret-new-value" })).body.passages).toEqual([]);

  const answer = await fetch(`${app.url}${root}/assistant/chat`, {
    method: "POST",
    headers: { "x-test-user": "evidence-user", "content-type": "application/json" },
    body: JSON.stringify({
      question: "What load ratio was used?",
      revisionId: f.revision.id,
      passageKey: hit.key,
      provider: "mock",
      model: "mock-1",
    }),
  });
  const events = (await answer.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
  expect(events.some((e) => e.type === "error")).toBe(false);
  const passage = events.find((e) => e.type === "passage");
  expect(passage?.type === "passage" && passage.passage.evidence.quote).toContain("R = 0.1");
  expect(events.findIndex((e) => e.type === "passage")).toBeLessThan(events.findIndex((e) => e.type === "saved"));
  const saved = events.at(-1) as Extract<ChatEvent, { type: "saved" }>;
  const conv = (await c.json<{ conversation: Conversation }>("GET", `${root}/conversations/${saved.conversationId}`)).body.conversation;
  expect(conv.messages.at(-1)?.agent?.sourceCoverage?.revisionId).toBe(f.revision.id);
  expect(conv.messages.at(-1)?.agent?.passages?.[0].title).toBe("fatigue-study.txt");
  const cited = conv.messages.at(-1)!.citations![0];
  expect(cited.evidence.chunkId).toBeUndefined();
  expect(cited.evidence.runId).toBe(f.runId);
  const inspected = await c.json<EvidenceInspection>("POST", `${root}/evidence/inspect`, {
    target: { kind: "answer", conversationId: conv.id, messageId: saved.messageId, ref: cited.ref },
  });
  expect(inspected.status).toBe(200);
  expect(inspected.body.source?.match).toBe("exact");
  expect(inspected.body.source?.reference.quote).toBe(cited.evidence.quote);
  const feedbackPath = `${root}/conversations/${conv.id}/messages/${saved.messageId}/citation-issues`;
  expect((await c.json("POST", feedbackPath, { key: conv.messages.at(-1)!.agent!.passages![0].key, reason: "unsupported" })).status).toBe(
    200,
  );
  expect((await c.json("POST", feedbackPath, { key: "forged", reason: "unsupported" })).status).toBe(404);
  expect(
    (
      await c.json("POST", `${root}/assistant/chat`, {
        question: "hi",
        revisionId: f.corpus.currentRevisionId,
        conversationId: conv.id,
        provider: "mock",
        model: "mock-1",
      })
    ).status,
  ).toBe(409);
  // Cancellation persists an explicitly incomplete answer, rather than losing all evidence on navigation.
  const controller = new AbortController();
  const cancel = await prepareChat(
    {
      store: createLocalStore(app.dataDir).forUser({ id: "evidence-user" }),
      user: { id: "evidence-user" },
      now: () => app.clock.now,
      log: silentLogger,
      requestId: "cancel-test",
    },
    f.corpus.id,
    { question: "load ratio", revisionId: f.revision.id, provider: "mock", model: "mock-1" },
  );
  await cancel((event) => {
    if (event.type === "status") controller.abort();
  }, controller.signal);
  const conversations = (await c.json<{ conversations: Conversation[] }>("GET", `${root}/conversations`)).body.conversations;
  expect(conversations.some((c) => c.messages.at(-1)?.agent?.completion === "interrupted")).toBe(true);
  const other = await c.json("POST", `${root}/assistant/chat`, {
    question: "hi",
    revisionId: "wrong",
    conversationId: conv.id,
    provider: "mock",
    model: "mock-1",
  });
  expect(other.status).toBe(404);
  // Missing retained inputs is an explicit partial-coverage result, never a live-document fallback.
  await blobs.delete(inputPath);
  const missing = await c.json<EvidenceSearchResult>("POST", `${path}/search`, { query: "load ratio" });
  expect(missing.body.coverage).toMatchObject({ available: 0, total: 1 });
  expect(missing.body.passages).toEqual([]);
  expect((await c.json("GET", `${path}/passages/${hit.key}`)).status).toBe(404);
  const unavailableEvents: ChatEvent[] = [];
  const unavailable = await prepareChat(
    {
      store: createLocalStore(app.dataDir).forUser({ id: "evidence-user" }),
      user: { id: "evidence-user" },
      now: () => app.clock.now,
      log: silentLogger,
      requestId: "unavailable-source-test",
    },
    f.corpus.id,
    { question: "Can you verify the load ratio?", revisionId: f.revision.id, provider: "mock", model: "mock-1" },
  );
  await unavailable((event) => unavailableEvents.push(event), new AbortController().signal);
  expect(unavailableEvents.some((e) => e.type === "tool_call" && e.call.name === "search_documents")).toBe(false);
  expect(unavailableEvents.some((e) => e.type === "passage")).toBe(false);
  expect(unavailableEvents.find((e) => e.type === "source_context")).toMatchObject({ coverage: { available: 0, total: 1 } });
  expect(unavailableEvents.at(-1)?.type).toBe("saved");
});
