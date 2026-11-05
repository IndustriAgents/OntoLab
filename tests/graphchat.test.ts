// Graph chat (Ask mode, ported from kg_chatbot) end to end over HTTP with the
// mock model: a committed extraction is queried with SPARQL, the steps stream
// as server-sent events, and the answer is stored with its queries, trace and
// evidence graph.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp } from "./helpers.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import { analyzeQuery, sparqlResultForLlm, type RunRecord } from "../server/graphchat/sparql.ts";
import { citedQueryIds } from "../server/graphchat/turn.ts";
import { parseTsv } from "../server/graphchat/rdf.ts";

type J = Record<string, any>;

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());

async function chat(user: string, pid: string, body: J): Promise<{ status: number; events: ChatEvent[] }> {
  const res = await fetch(`${app.url}/api/projects/${pid}/assistant/chat`, {
    method: "POST",
    headers: { "x-test-user": user, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
  return { status: res.status, events };
}

async function committedSample(user: string): Promise<string> {
  const c = app.as(user);
  const pid = (await c.json<J>("POST", "/api/projects/sample")).body.project.id;
  const docs = (await c.json<J>("GET", `/api/projects/${pid}/documents`)).body.documents;
  const run = await c.json<J>("POST", `/api/projects/${pid}/runs`, {
    documentIds: docs.map((d: J) => d.id),
    mode: "automatic",
    provider: "mock",
    model: "mock-1",
  });
  const done = await driveRun(c, pid, run.body.run.id);
  await c.json("POST", `/api/projects/${pid}/revisions/${done.resultRevisionId}/commit`, { acknowledgedWarnings: true });
  return pid;
}

describe("graph chat", () => {
  it("answers from the project graph with queries, evidence and a stored trace", async () => {
    const pid = await committedSample("ana");
    const { status, events } = await chat("ana", pid, { question: "What is in the graph?", provider: "mock", model: "mock-1" });
    expect(status).toBe(200);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types.at(-1)).toBe("saved");
    expect(events.find((e) => e.type === "error")).toBeUndefined();

    const run = events.find((e): e is Extract<ChatEvent, { type: "sparql" }> => e.type === "sparql" && e.run.purpose === "agent")!.run;
    expect(run.id).toBe("Q1");
    expect(run.ok).toBe(true);
    expect(run.rowCount).toBeGreaterThan(0);
    expect(run.rows[0].item.type).toBe("uri");
    expect(run.rows[0].label.type).toBe("literal");

    const evidence = events.find((e): e is Extract<ChatEvent, { type: "evidence" }> => e.type === "evidence")!.graph;
    expect(evidence.queryIds).toEqual(["Q1"]);
    expect(evidence.edges.length).toBeGreaterThan(0);
    expect(evidence.nodes.some((n) => n.individualId)).toBe(true);

    const saved = events.at(-1) as Extract<ChatEvent, { type: "saved" }>;
    const conv = (await app.as("ana").json<J>("GET", `/api/projects/${pid}/conversations/${saved.conversationId}`)).body.conversation;
    const msg = conv.messages.find((m: J) => m.id === saved.messageId);
    expect(msg.content).toMatch(/\[Q1\]/);
    expect(msg.agent.source).toBe("project");
    expect(msg.agent.sourceCheck?.status).toBe("passed");
    expect(msg.agent.runs[0].id).toBe("Q1");
    expect(msg.agent.trace.some((t: J) => t.kind === "tool")).toBe(true);
    expect(msg.agent.evidence.edges.length).toBe(evidence.edges.length);
    expect(msg.entities.length).toBeGreaterThan(0);
    // the document search ran too, and its passage became a citation
    expect(msg.agent.tools.some((t: J) => t.name === "search_documents")).toBe(true);
    expect(msg.citations?.[0]?.ref).toBe("C1");
    const citation = msg.citations[0].evidence;
    expect(citation.status).toBe("verified");
    const source = (await app.as("ana").json<J>("GET", `/api/projects/${pid}/documents/${citation.documentId}/text`)).body;
    expect(source.text.slice(citation.start, citation.end)).toBe(citation.quote);
    expect(citation.end - citation.start).toBe(citation.quote.length);

    // a follow-up continues the same conversation
    const next = await chat("ana", pid, { question: "And now?", conversationId: saved.conversationId, provider: "mock", model: "mock-1" });
    const saved2 = next.events.at(-1) as Extract<ChatEvent, { type: "saved" }>;
    expect(saved2.conversationId).toBe(saved.conversationId);
  });

  it("keeps projects private and reports a missing GraphDB", async () => {
    const pid = await committedSample("bo");
    const other = await chat("cy", pid, { question: "hi", provider: "mock", model: "mock-1" });
    expect(other.status).toBe(404);

    const status = await app.as("bo").json<J>("GET", "/api/graphdb");
    expect(status.body.graphdb.configured).toBe(false);
    const viaGraphDb = await chat("bo", pid, { question: "hi", provider: "mock", model: "mock-1", source: "graphdb" });
    expect(viaGraphDb.status).toBe(400);

    const project = (await app.as("bo").json<J>("GET", `/api/projects/${pid}`)).body.project;
    const publish = await app
      .as("bo")
      .json<J>("POST", `/api/projects/${pid}/revisions/${project.currentRevisionId}/graphdb`, { repository: "repo" });
    expect(publish.status).toBe(400);
  });
});

describe("graph chat units", () => {
  it("refuses updates and finds cited query ids", () => {
    expect(analyzeQuery("INSERT DATA { <a> <b> <c> }").isUpdate).toBe(true);
    expect(analyzeQuery("SELECT * WHERE { ?s ?p ?o }").kind).toBe("select");
    expect(citedQueryIds("Four sensors [Q3]. Also [Q4, Q5] and Q6.")).toEqual(["Q3", "Q4", "Q5"]);
  });

  it("parses GraphDB TSV and shows typed results to the model", () => {
    const { vars, rows } = parseTsv('?s\t?label\t?n\n<http://ex/a>\t"A \\"x\\""@en\t3\n');
    expect(vars).toEqual(["s", "label", "n"]);
    expect(rows[0].label).toEqual({ type: "literal", value: 'A "x"', lang: "en" });
    const run = { id: "Q2", ok: true, kind: "select", vars, rows, allRows: rows, rowCount: 1 } as unknown as RunRecord;
    const text = sparqlResultForLlm(run);
    expect(text).toContain("[Q2] SELECT returned 1 row.");
    expect(text).toContain('<http://ex/a>\t"A \\"x\\""@en\t"3"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });
});
