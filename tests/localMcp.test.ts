import { mkdtemp, mkdir, rm, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDesktopServer } from "../server/desktop/server.ts";
import type { ActionResult } from "../src/types/actions.ts";
import type { OntologyRevision, Project, ProjectDocument, RevisionWithContent } from "../src/types/project.ts";

let root: string;
let app: Awaited<ReturnType<typeof startDesktopServer>>;
const clients: Client[] = [];
const turtle = `@prefix : <https://example.com/equipment#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://example.com/equipment> a owl:Ontology .
:Pump a owl:Class ; rdfs:label "Pump" ; rdfs:comment "A pump described by the source manuals." .`;
async function ui(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${app.origin}${path}`, {
    method,
    headers: { cookie: app.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function connect(options: Record<string, unknown> = {}) {
  const setup = await ui("/api/local-mcp/connections", "POST", { name: "Test client", allowSave: true, ...options });
  expect(setup.status).toBe(201);
  const client = new Client({ name: "end-to-end-test", version: "1.0" });
  const transport = new StdioClientTransport({ command: setup.body.config.command, args: setup.body.config.args, stderr: "pipe" });
  await client.connect(transport);
  clients.push(client);
  return { client, setup: setup.body };
}
let sequence = 0;
async function call<T>(client: Client, name: string, input: Record<string, unknown> = {}, write = false): Promise<T> {
  const response = await client.callTool({
    name,
    arguments: { ...input, ...(write ? { requestId: input.requestId ?? `request_${++sequence}` } : {}) },
  });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return (response.structuredContent as unknown as ActionResult).data as T;
}
async function fail(client: Client, name: string, input: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: input });
  expect(response.isError).toBe(true);
  return JSON.stringify(response.content);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ontolab mcp "));
  await mkdir(join(root, "dist"));
  app = await startDesktopServer({
    dataDir: join(root, "workspace"),
    distDir: join(root, "dist"),
    agentLaunch: { command: process.execPath, args: [resolve("node_modules/tsx/dist/cli.mjs"), resolve("server/mcp/bridge.ts")] },
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await app.close();
  await rm(root, { recursive: true, force: true });
});
describe("local MCP full workflow", () => {
  it("reports desktop MCP availability to the authenticated desktop session", async () => {
    const status = await ui("/api/local-mcp");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ available: true, connections: [], projects: [] });
    expect((await fetch(`${app.origin}/api/local-mcp`)).status).toBe(401);
  });

  it("builds, reviews, saves, queries and exports an ontology and evidence-backed graph through real stdio, then reconnects", async () => {
    const { client, setup } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("answer_run_questions");
    const requestId = "create_once";
    const [a, b] = await Promise.all(
      [1, 2].map(() => call<{ project: Project }>(client, "create_project", { name: "Equipment", requestId }, true)),
    );
    expect(a.project.id).toBe(b.project.id);
    const pid = a.project.id;
    expect(await fail(client, "create_project", { name: "Different", requestId })).toContain("different inputs");
    await ui(`/api/projects/${pid}`, "PATCH", { settings: { models: { embeddings: "hash", nli: "off" } } });
    const draft = (
      await call<{ revision: OntologyRevision }>(
        client,
        "submit_ontology_draft",
        { projectId: pid, baseRevisionId: null, modules: [{ name: "equipment.ttl", turtle }], summary: "Equipment ontology" },
        true,
      )
    ).revision;
    await call(client, "validate_revision", { projectId: pid, revisionId: draft.id });
    await call(
      client,
      "save_version",
      { projectId: pid, revisionId: draft.id, expectedHash: draft.contentHash, acknowledgedWarnings: true },
      true,
    );
    const graph = (
      await call<{ project: Project }>(
        client,
        "create_knowledge_graph",
        { projectId: pid, name: "Manuals", ontologyRevisionId: draft.id },
        true,
      )
    ).project;
    const source = (
      await call<{ document: ProjectDocument }>(
        client,
        "import_document",
        { projectId: graph.id, name: "manual.txt", text: "Pump A transfers water. Pump A is a pump." },
        true,
      )
    ).document;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const context = await call<{ documents: ProjectDocument[] }>(client, "get_project_context", { projectId: graph.id });
      if (context.documents[0]?.parseState === "parsed") {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);
    await call(client, "prepare_documents", { projectId: graph.id, documentIds: [source.id] }, true);
    const prepared = await call<{ workPackageId: string }>(client, "prepare_fact_submission", { projectId: graph.id }, true);
    const work = await call<{ chunks: { id: string; text: string; start: number }[] }>(client, "read_work_package", {
      projectId: graph.id,
      workPackageId: prepared.workPackageId,
    });
    expect(work.chunks).toHaveLength(1);
    const recoverable = await call<{ workPackages: { id: string }[] }>(client, "get_project_context", { projectId: graph.id });
    expect(recoverable.workPackages.map((w) => w.id)).toContain(prepared.workPackageId);
    expect(
      await fail(client, "finalize_fact_submission", {
        projectId: graph.id,
        workPackageId: prepared.workPackageId,
        requestId: "early_finish",
      }),
    ).toContain("chunks remain");
    const input = {
      projectId: graph.id,
      workPackageId: prepared.workPackageId,
      batchId: "batch_one",
      chunkIds: [work.chunks[0].id],
      individuals: [
        {
          id: "pump_a",
          classUri: "https://example.com/equipment#Pump",
          label: "Pump A",
          evidence: [{ chunkId: work.chunks[0].id, quote: "Pump A transfers water." }],
        },
      ],
    };
    expect(
      await fail(client, "submit_fact_batch", {
        ...input,
        requestId: "forged",
        individuals: [{ ...input.individuals[0], review: { status: "accepted", by: "user" } }],
      }),
    ).toContain("Invalid");
    const initialBatch = await call<{ batchHash: string }>(client, "submit_fact_batch", input, true);
    await call(client, "submit_fact_batch", input, true);
    const wrong = { ...input, individuals: [{ ...input.individuals[0], classUri: "https://example.com/equipment#Unknown" }] };
    const invalidBatch = await call<{ batchHash: string }>(
      client,
      "submit_fact_batch",
      { ...wrong, replaceHash: initialBatch.batchHash },
      true,
    );
    expect(
      await fail(client, "finalize_fact_submission", {
        projectId: graph.id,
        workPackageId: prepared.workPackageId,
        requestId: "invalid_schema",
      }),
    ).toContain("schema errors");
    await call(client, "submit_fact_batch", { ...input, replaceHash: invalidBatch.batchHash }, true); // same batch, different transport request: durable deduplication
    const assembled = (
      await call<{ revision: OntologyRevision }>(
        client,
        "finalize_fact_submission",
        { projectId: graph.id, workPackageId: prepared.workPackageId },
        true,
      )
    ).revision;
    const content = await call<RevisionWithContent>(client, "get_revision", { projectId: graph.id, revisionId: assembled.id });
    const fact = content.content.abox!.individuals[0];
    expect(fact.review?.status).toBe("candidate");
    expect(fact.evidence![0]).toMatchObject({ status: "verified", start: 0, end: 23, review: true });
    expect(fact.evidence![0].confidence).toBeUndefined();
    const queue = await call<{ facts: { key: string; status: string }[] }>(client, "list_facts", {
      projectId: graph.id,
      revisionId: assembled.id,
      status: "all",
    });
    expect(queue.facts).toHaveLength(1);
    await call(
      client,
      "review_facts",
      {
        projectId: graph.id,
        revisionId: assembled.id,
        expectedHash: assembled.contentHash,
        decisions: queue.facts.map((f) => ({ key: f.key, status: "accepted", reason: "Reviewed against source" })),
      },
      true,
    );
    expect(
      await fail(client, "save_version", {
        projectId: graph.id,
        revisionId: assembled.id,
        expectedHash: assembled.contentHash,
        requestId: "stale_save",
      }),
    ).toContain("draft changed");
    const reviewed = await call<RevisionWithContent>(client, "get_revision", { projectId: graph.id, revisionId: assembled.id });
    await call(client, "validate_revision", { projectId: graph.id, revisionId: assembled.id });
    await call(
      client,
      "save_version",
      { projectId: graph.id, revisionId: assembled.id, expectedHash: reviewed.contentHash, acknowledgedWarnings: true },
      true,
    );
    const query = await call<{ rows: unknown[] }>(client, "query_graph", {
      projectId: graph.id,
      revisionId: assembled.id,
      query: "SELECT ?pump WHERE { ?pump a <https://example.com/equipment#Pump> }",
    });
    expect(query.rows).toHaveLength(1);
    const exported = await call<{ turtle: string }>(client, "create_export", { projectId: graph.id, revisionId: assembled.id });
    expect(exported.turtle).toContain("Pump A");
    await app.close();
    app = await startDesktopServer({ dataDir: join(root, "workspace"), distDir: join(root, "dist") });
    expect((await call<{ projects: Project[] }>(client, "list_projects")).projects.map((p) => p.id)).toContain(graph.id);
    const credentials = JSON.parse(await readFile(setup.config.args.at(-1), "utf8"));
    expect((await stat(setup.config.args.at(-1))).mode & 0o777).toBe(0o600);
    expect(
      (
        await fetch(`${app.origin}/api/local-agent/tools`, {
          headers: { authorization: `Bearer ${credentials.token}`, origin: "https://unrelated.example" },
        })
      ).status,
    ).toBe(403);
    expect((await ui(`/api/local-mcp/connections/${setup.connection.id}`, "DELETE")).status).toBe(200);
    expect(await fail(client, "list_projects", {})).toContain("revoked");
  }, 30000);
  it("restricts project scope, saving, read-only queries, and live draft writes", async () => {
    const { client: full } = await connect();
    const first = (await call<{ project: Project }>(full, "create_project", { name: "Allowed" }, true)).project;
    const second = (await call<{ project: Project }>(full, "create_project", { name: "Hidden" }, true)).project;
    const { client } = await connect({ projects: [first.id], allowSave: false });
    expect((await call<{ projects: Project[] }>(client, "list_projects")).projects.map((p) => p.id)).toEqual([first.id]);
    expect(await fail(client, "get_project_context", { projectId: second.id })).toContain("cannot access");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("save_version");
    const draft = (
      await call<{ revision: OntologyRevision }>(
        full,
        "submit_ontology_draft",
        { projectId: first.id, baseRevisionId: null, modules: [{ name: "equipment.ttl", turtle }], summary: "Initial draft" },
        true,
      )
    ).revision;
    expect(
      await fail(full, "submit_ontology_draft", {
        projectId: first.id,
        baseRevisionId: null,
        modules: [{ name: "bad.ttl", turtle: "not turtle" }],
        summary: "Invalid draft",
        requestId: "invalid_turtle",
      }),
    ).toContain("cannot be parsed");
    const rev = (await ui(`/api/projects/${first.id}/revisions/${draft.id}`)).body.revision;
    const changed = { ...rev.content, baseIri: "https://example.com/edited#" };
    expect(
      (await ui(`/api/projects/${first.id}/revisions/${draft.id}`, "PUT", { content: changed, expectedHash: draft.contentHash })).status,
    ).toBe(200);
    expect(
      (await ui(`/api/projects/${first.id}/revisions/${draft.id}`, "PUT", { content: rev.content, expectedHash: draft.contentHash }))
        .status,
    ).toBe(409);
    expect(
      await fail(client, "save_version", {
        projectId: first.id,
        revisionId: draft.id,
        expectedHash: draft.contentHash,
        requestId: "unauthorized",
      }),
    ).toContain("permissions");
    expect(await fail(full, "query_graph", { projectId: first.id, revisionId: draft.id, query: "DELETE WHERE { ?s ?p ?o }" })).toContain(
      "read-only",
    );
  });
});

describe("local authoring recovery and pipeline handoff", () => {
  it("starts a planned background build and continues an interactive graph update through MCP", async () => {
    const { client } = await connect();
    const p = (await call<{ project: Project }>(client, "create_project", { name: "Pipeline project" }, true)).project;
    await ui(`/api/projects/${p.id}`, "PATCH", {
      settings: { models: { embeddings: "hash", nli: "off" }, provider: "mock", model: "mock-1" },
    });
    const source = (
      await call<{ document: ProjectDocument }>(
        client,
        "import_document",
        { projectId: p.id, name: "manual.txt", text: "Pump A transfers water to Valve B. The pump belongs to the water system." },
        true,
      )
    ).document;
    for (let i = 0; i < 60; i++) {
      if (
        (await call<{ documents: ProjectDocument[] }>(client, "get_project_context", { projectId: p.id })).documents[0]?.parseState ===
        "parsed"
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await call(client, "prepare_documents", { projectId: p.id, documentIds: [source.id] }, true);
    const planned = await call<{ plan: { id: string } }>(
      client,
      "plan_ontology_build",
      { projectId: p.id, documentIds: [source.id], provider: "mock", model: "mock-1" },
      true,
    );
    await ui(`/api/projects/${p.id}`, "PATCH", { purpose: "Changed after planning" });
    // Purpose and scope are part of the requirements snapshot, so they must invalidate plans too.
    expect(await fail(client, "start_ontology_build", { projectId: p.id, planId: planned.plan.id, requestId: "stale_build" })).toContain(
      "inputs changed",
    );
    const fresh = await call<{ plan: { id: string } }>(
      client,
      "plan_ontology_build",
      { projectId: p.id, documentIds: [source.id], provider: "mock", model: "mock-1" },
      true,
    );
    const started = await call<{ run: { id: string } }>(client, "start_ontology_build", { projectId: p.id, planId: fresh.plan.id }, true);
    await call(client, "control_run", { projectId: p.id, runId: started.run.id, control: "pause" }, true);
    expect((await call<{ run: { status: string } }>(client, "get_run", { projectId: p.id, runId: started.run.id })).run.status).toBe(
      "paused",
    );
    await call(client, "control_run", { projectId: p.id, runId: started.run.id, control: "resume" }, true);
    let built: any;
    for (let i = 0; i < 200; i++) {
      built = (await call<{ run: any }>(client, "get_run", { projectId: p.id, runId: started.run.id })).run;
      if (["ready_for_review", "failed"].includes(built.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(built.status, built.error).toBe("ready_for_review");
    const draft = await call<RevisionWithContent>(client, "get_revision", { projectId: p.id, revisionId: built.resultRevisionId });
    await call(
      client,
      "save_version",
      { projectId: p.id, revisionId: draft.id, expectedHash: draft.contentHash, acknowledgedWarnings: true },
      true,
    );
    const graph = (
      await call<{ project: Project }>(
        client,
        "create_knowledge_graph",
        { projectId: p.id, name: "Interactive graph", ontologyRevisionId: draft.id },
        true,
      )
    ).project;
    const graphDoc = (
      await call<{ document: ProjectDocument }>(
        client,
        "import_document",
        { projectId: graph.id, name: "manual.txt", text: "Pump A transfers water to Valve B." },
        true,
      )
    ).document;
    for (let i = 0; i < 60; i++) {
      if (
        (await call<{ documents: ProjectDocument[] }>(client, "get_project_context", { projectId: graph.id })).documents[0]?.parseState ===
        "parsed"
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await call(client, "prepare_documents", { projectId: graph.id, documentIds: [graphDoc.id] }, true);
    const update = await call<{ plan: { hash: string; errors: string[] } }>(client, "plan_graph_update", { projectId: graph.id });
    expect(update.plan.errors).toEqual([]);
    const updating = await call<{ run: { id: string } }>(
      client,
      "start_graph_update",
      { projectId: graph.id, planHash: update.plan.hash, interactive: true },
      true,
    );
    let waiting: any;
    for (let i = 0; i < 200; i++) {
      waiting = (await call<{ run: any }>(client, "get_run", { projectId: graph.id, runId: updating.run.id })).run;
      if (["awaiting_answers", "failed"].includes(waiting.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(waiting.status, waiting.error).toBe("awaiting_answers");
    expect(waiting.questions.length).toBeGreaterThan(0);
    const continued = await call<{ run: { status: string } }>(
      client,
      "answer_run_questions",
      {
        projectId: graph.id,
        runId: waiting.id,
        answers: Object.fromEntries(waiting.questions.map((q: { id: string }) => [q.id, "Use only explicitly supported facts."])),
        finish: true,
      },
      true,
    );
    expect(continued.run.status).toBe("running");
    const chat = await ui(`/api/projects/${p.id}/agent/chat`, "POST", {
      message: "Inspect my project sources",
      provider: "mock",
      model: "mock-1",
      revisionId: draft.id,
    });
    expect(chat.status).toBe(200);
    expect(chat.body.results.length).toBeGreaterThan(0);
    const savedChat = await ui(`/api/projects/${p.id}/agent/conversations/${chat.body.threadId}`);
    expect(savedChat.body.messages).toHaveLength(2);
  }, 60000);
  it("refuses a second backend for the same local profile", async () => {
    await expect(startDesktopServer({ dataDir: join(root, "workspace"), distDir: join(root, "dist") })).rejects.toThrow("already open");
  });
});

it("imports only files inside explicitly granted folders, including symlink checks", async () => {
  const { client: full } = await connect();
  const project = (await call<{ project: Project }>(full, "create_project", { name: "Files" }, true)).project;
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  await writeFile(join(allowed, "manual.txt"), "Pump A moves water.");
  await writeFile(join(root, "outside.txt"), "Not granted");
  await symlink(join(root, "outside.txt"), join(allowed, "escape.txt"));
  const { client, setup } = await connect({ projects: [project.id], fileRoots: [allowed] });
  const credentialPath = setup.config.args.at(-1);
  const credential = JSON.parse(await readFile(credentialPath, "utf8"));
  await writeFile(credentialPath, JSON.stringify({ ...credential, fileRoots: [root] }), { mode: 0o600 });
  const tampered = new Client({ name: "edited-client-config", version: "1.0" });
  await tampered.connect(new StdioClientTransport({ command: setup.config.command, args: setup.config.args, stderr: "pipe" }));
  clients.push(tampered);
  expect(
    await fail(tampered, "import_local_file", { projectId: project.id, path: join(root, "outside.txt"), requestId: "edited_config" }),
  ).toContain("outside");
  expect(
    (
      await call<{ document: ProjectDocument }>(
        client,
        "import_local_file",
        { projectId: project.id, path: join(allowed, "manual.txt") },
        true,
      )
    ).document.name,
  ).toBe("manual.txt");
  expect(
    await fail(client, "import_local_file", { projectId: project.id, path: join(root, "outside.txt"), requestId: "outside" }),
  ).toContain("outside");
  expect(
    await fail(client, "import_local_file", { projectId: project.id, path: join(allowed, "escape.txt"), requestId: "symlink" }),
  ).toContain("outside");
});
