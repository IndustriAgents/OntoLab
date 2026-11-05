// Opt-in live test: uses the installed Codex CLI/account against a temporary graph.
// Run: LOCAL_CLI_ENABLED=1 npx tsx scripts/codex-graph-smoke.ts --live
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { createLocalStore } from "../server/store/local.ts";
import { startDocumentWorker } from "../server/documentWorker.ts";
import { silentLogger } from "../server/services/context.ts";
import { stopSparqlPool } from "../server/services/sparqlPool.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import type { Project, ProjectDocument, RevisionWithContent, Conversation } from "../src/types/project.ts";

if (!process.argv.includes("--live")) throw new Error("Pass --live to use your Codex CLI login and account quota.");
const root = await mkdtemp(join(tmpdir(), "ontolab-codex-graph-"));
const store = createLocalStore(root);
const worker = startDocumentWorker(store, silentLogger, { autoStart: false });
const auth = { mode: "local" as const, authenticate: async () => ({ user: { id: "codex-smoke" } }) };
const server = http.createServer(createApp({ store, auth, log: silentLogger, distDir: resolve("dist") }));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const report: { url: string; projectId?: string; conversationId?: string; turns: unknown[] } = { url: base, turns: [] };
console.log(JSON.stringify({ stage: "server", url: base, isolated: true }));

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as T;
}

async function chat(pid: string, question: string, conversationId?: string) {
  const start = Date.now();
  console.log(JSON.stringify({ stage: "question", question }));
  const response = await fetch(`${base}/api/projects/${pid}/assistant/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex-cli", model: "default", question, conversationId }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const events: ChatEvent[] = [];
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n").filter((l) => l.startsWith("data: "))) {
        const event = JSON.parse(line.slice(6)) as ChatEvent;
        events.push(event);
        if (["status", "tool_call", "sparql", "error", "saved"].includes(event.type))
          console.log(JSON.stringify({ stage: "event", event }));
      }
    }
  }
  const error = events.find((e) => e.type === "error");
  assert(!error, JSON.stringify(error));
  const saved = events.find((e): e is Extract<ChatEvent, { type: "saved" }> => e.type === "saved");
  assert(saved, "The answer was not saved");
  const conversation = (await json<{ conversation: Conversation }>("GET", `/api/projects/${pid}/conversations/${saved.conversationId}`))
    .conversation;
  const message = conversation.messages.find((m) => m.id === saved.messageId)!;
  assert(message.content.trim(), "The saved answer is empty");
  assert(message.agent?.tools.length, "The assistant did not execute any project tools");
  report.conversationId = saved.conversationId;
  report.turns.push({
    question,
    answer: message.content,
    tools: message.agent.tools,
    runs: message.agent.runs,
    citations: message.citations,
    ms: Date.now() - start,
  });
  console.log(JSON.stringify({ stage: "answer", text: message.content, ms: Date.now() - start }));
  return { message, conversationId: saved.conversationId, events };
}

try {
  const project = (
    await json<{ project: Project }>("POST", "/api/projects", {
      name: "Codex CLI live test",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).project;
  const pid = (report.projectId = project.id);
  const ns = "http://example.org/codex-smoke#";
  const turtle = `@prefix : <${ns}> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Asset a owl:Class ; rdfs:label "Asset" .
:Pump a owl:Class ; rdfs:label "Pump" ; rdfs:subClassOf :Asset .
:Sensor a owl:Class ; rdfs:label "Sensor" ; rdfs:subClassOf :Asset .
:maxPressureBar a owl:DatatypeProperty ; rdfs:label "maximum pressure in bar" ; rdfs:domain :Pump ; rdfs:range xsd:decimal .
:monitors a owl:ObjectProperty ; rdfs:label "monitors" ; rdfs:domain :Sensor ; rdfs:range :Pump .`;
  const draft = (
    await json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
      source: "manual",
      summary: "Synthetic CLI test graph",
      content: {
        baseIri: ns,
        modules: [{ id: "core", name: "test.ttl", turtle }],
        abox: {
          individuals: [
            { id: "pump101", label: "P-101", classUri: ns + "Pump", dataProperties: [{ propUri: ns + "maxPressureBar", value: "6" }] },
            { id: "pump102", label: "P-102", classUri: ns + "Pump", dataProperties: [{ propUri: ns + "maxPressureBar", value: "10" }] },
            {
              id: "sensor201",
              label: "S-201",
              classUri: ns + "Sensor",
              objectProperties: [{ propUri: ns + "monitors", targetId: "pump101" }],
            },
          ],
        },
      },
    })
  ).revision;
  await json("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true });
  const original = await json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${draft.id}`);
  const uploaded = await fetch(`${base}/api/projects/${pid}/documents`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": "maintenance-notes.txt" },
    body: "Maintenance register: P-101 requires inspection every 45 days. P-102 requires inspection every 90 days. Ticket reference: VX-472.",
  });
  assert(uploaded.ok, await uploaded.clone().text());
  const doc = ((await uploaded.json()) as { document: ProjectDocument }).document;
  await worker!.tick();
  const settings = { method: "paragraph", maxChars: 12000, overlap: 0.12 };
  const preview = await json<{ textHash: string }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings);
  await json("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, { settings, textHash: preview.textHash });
  console.log(JSON.stringify({ stage: "ready", assistantUrl: `${base}/p/${pid}/assistant` }));

  const first = await chat(
    pid,
    "Query the graph with SPARQL: how many Pump individuals are there? List their labels and maximum pressure in bar. Cite your executed queries.",
  );
  assert(
    first.message.agent!.runs.some((r) => r.ok),
    "No successful SPARQL query",
  );
  assert(/P-101/.test(first.message.content) && /P-102/.test(first.message.content), "Missing pump labels");
  assert(/\b2\b|\btwo\b/i.test(first.message.content), "Wrong pump count");
  assert(/\[Q\d+\]/.test(first.message.content), "Missing graph citation");
  assert(first.message.agent!.evidence?.edges.length, "Missing evidence graph");
  const followup = await chat(
    pid,
    "Of those two pumps, which has the higher maximum pressure? Verify with SPARQL and cite the query.",
    first.conversationId,
  );
  assert(followup.conversationId === first.conversationId, "Follow-up lost conversation");
  assert(/P-102/.test(followup.message.content) && /10/.test(followup.message.content), "Wrong maximum pressure");
  const document = await chat(
    pid,
    "Search the project documents: what is the required inspection interval for P-101, and what ticket reference is recorded? Cite the supporting passage.",
    first.conversationId,
  );
  assert(
    document.message.agent!.tools.some((t) => t.name === "search_documents"),
    "Document tool was not used",
  );
  assert(/45/.test(document.message.content) && /VX-472/.test(document.message.content), "Wrong maintenance answer");
  assert(document.message.citations?.length && /\[C\d+\]/.test(document.message.content), "Missing source citation");
  const citation = document.message.citations[0].evidence;
  const source = await json<{ text: string }>("GET", `/api/projects/${pid}/documents/${citation.documentId}/text`);
  assert.equal(citation.status, "verified", "The source excerpt was incorrectly marked unverified");
  assert.equal(source.text.slice(citation.start, citation.end), citation.quote, "The citation highlights the wrong text");
  const unchanged = (await json<{ project: Project }>("GET", `/api/projects/${pid}`)).project;
  assert(unchanged.currentRevisionId === draft.id, "Read-only answers changed the graph");
  const after = await json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${draft.id}`);
  assert.deepEqual(after.revision.content, original.revision.content, "Read-only answers changed the graph content");
  const output = process.argv.indexOf("--report");
  if (output >= 0) await writeFile(process.argv[output + 1], JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ stage: "passed", url: `${base}/p/${pid}/assistant?c=${report.conversationId}`, turns: report.turns.length }),
  );
  if (process.argv.includes("--serve"))
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
} finally {
  await worker?.stop();
  await new Promise<void>((done) => server.close(() => done()));
  await stopSparqlPool();
  await rm(root, { recursive: true, force: true });
}
