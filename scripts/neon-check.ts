// Explicit opt-in integration check against the linked Neon database. Only
// temporary users/projects created here are touched; they are removed at exit.
import "../server/env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgresConnectionString } from "../server/store/connection.ts";
import type { ActionResult } from "../src/types/actions.ts";
import type { Project, ProjectDocument, RunView, RevisionWithContent, OntologyRevision } from "../src/types/project.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing. Run neon deploy first.");
console.info(
  `Database target: ${new URL(process.env.DATABASE_URL).hostname.endsWith(".neon.tech") ? "Neon Postgres" : "Postgres (non-Neon host)"}.`,
);
process.env.MOCK_LLM = "1";
const { digest } = await import("../server/actions/state.ts");
const { createPostgresStore } = await import("../server/store/postgres.ts");
const { startApp, driveRun } = await import("../tests/helpers.ts");
const store = createPostgresStore(process.env.DATABASE_URL);
const prefix = `smoke_${randomUUID().replace(/-/g, "")}`;
const aliceId = `${prefix}_alice`;
const bobId = `${prefix}_bob`;
const aliceStore = store.forUser({ id: aliceId });
const bobStore = store.forUser({ id: bobId });
let app = await startApp({ store });
const workspaceActionPath = `agent/requests/${digest(["ui", "create_project", `${prefix}_project`])}.json`;

try {
  const c = app.as(aliceId);
  const sample = await c.json<{ project: Project }>("POST", "/api/projects/sample");
  assert.equal(sample.status, 201, JSON.stringify(sample.body));
  const pid = sample.body.project.id;
  const connection = {
    id: "conn_smoke",
    name: "Private graph",
    provider: "sparql" as const,
    queryEndpoint: "https://example.org/sparql",
    authType: "none" as const,
    hasCredentials: false,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await aliceStore.connections.put(connection, null);
  assert.equal((await aliceStore.connections.get(connection.id))?.name, connection.name);
  assert.equal(await bobStore.connections.get(connection.id), null);
  await assert.rejects(aliceStore.connections.put({ ...connection, version: 2 }, 99));
  assert.equal((await c.json<{ connections: unknown[] }>("GET", "/api/connections")).body.connections.length, 1);
  console.info("PASS Postgres: owner-bound graph connections and concurrent update protection.");
  const creation = { requestId: `${prefix}_project`, name: "Assistant action persistence" };
  const actionProject = await c.json<ActionResult>("POST", "/api/actions/create_project", creation);
  assert.equal(actionProject.status, 200, JSON.stringify(actionProject.body));
  const actionPid = (actionProject.body.data as { project: Project }).project.id;
  assert.deepEqual((await c.json("POST", "/api/actions/create_project", creation)).body, actionProject.body);
  assert.ok(await aliceStore.blobs.get(workspaceActionPath));
  assert.equal(await bobStore.blobs.get(workspaceActionPath), null);
  const source = { projectId: actionPid, requestId: `${prefix}_import`, name: "manual.txt", text: "A pump is equipment." };
  const imported = await c.json<ActionResult>("POST", "/api/actions/import_document", source);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual((await c.json("POST", "/api/actions/import_document", source)).body, imported.body);
  assert.equal((await aliceStore.documents.list(actionPid)).length, 1);
  assert.equal((await c.json("POST", "/api/actions/import_document", { ...source, text: "Changed" })).status, 409);
  const scopedPath = `${actionPid}/agent/requests/${digest(["ui", "import_document", source.requestId])}.json`;
  assert.ok(await aliceStore.blobs.get(scopedPath));
  assert.equal(await bobStore.blobs.get(scopedPath), null);
  const requirements = await c.json<ActionResult>("POST", "/api/actions/set_requirements", {
    projectId: actionPid,
    requestId: `${prefix}_requirements`,
    expectedVersion: 0,
    requirements: { stories: ["Inspect equipment."], cqs: [{ text: "Which pumps are equipment?", status: "approved" }] },
  });
  assert.equal(requirements.status, 200, JSON.stringify(requirements.body));
  assert.deepEqual((requirements.body.data as { project: Project }).project.competencyQuestions, ["Which pumps are equipment?"]);
  assert.equal(
    (
      await c.json("POST", "/api/actions/set_requirements", {
        projectId: actionPid,
        requestId: `${prefix}_invalid_requirements`,
        expectedVersion: 1,
        requirements: { competencyQuestions: ["Incorrect shape must not silently clear questions."] },
      })
    ).status,
    400,
  );
  await aliceStore.projects.delete(actionPid);
  assert.equal(await aliceStore.blobs.get(scopedPath), null);
  console.info("PASS Postgres: assistant actions, durable retry identity, requirements validation, owner isolation and project cleanup.");
  const docs = (await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents;
  assert.ok(docs[0].chunkCount > 1);
  assert.equal((await c.get(`/api/projects/${pid}/documents/${docs[0].id}/file`)).status, 200);
  assert.ok((await aliceStore.documents.search(pid, "cylinder", 5)).length > 0);
  console.info("PASS Postgres: project, document bytes, parsed chunks and full-text search over HTTP.");

  assert.equal((await app.as(bobId).get(`/api/projects/${pid}`)).status, 404);
  assert.equal((await app.as(bobId).get(`/api/projects/${pid}/documents/${docs[0].id}/file`)).status, 404);
  assert.deepEqual(await bobStore.documents.chunks(pid), []);
  const sql = new Pool({ connectionString: postgresConnectionString(process.env.DATABASE_URL), max: 1 });
  const db = await sql.connect();
  try {
    await db.query("begin");
    await db.query("set local role ontolab_app");
    await db.query("select set_config('ontolab.user_id',$1,true)", [bobId]);
    // Deliberately omit owner filters: the database must still hide Alice.
    assert.equal((await db.query("select id from ontolab.projects where id=$1", [pid])).rowCount, 0);
    assert.equal((await db.query("select id from ontolab.records where project_id=$1", [pid])).rowCount, 0);
    assert.equal((await db.query("select path from ontolab.blobs where project_id=$1", [pid])).rowCount, 0);
    assert.equal((await db.query("select id from ontolab.graph_connections where id=$1", [connection.id])).rowCount, 0);
    await assert.rejects(
      db.query("insert into ontolab.projects(owner_id,id,data) values($1,$2,'{}')", [aliceId, "forbidden"]),
      /row-level security/,
    );
  } finally {
    await db.query("rollback");
    db.release();
    await sql.end();
  }
  console.info("PASS Postgres: cross-user API access and database RLS isolation, including writes.");

  const created = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
    documentIds: docs.map((d) => d.id),
    mode: "automatic",
    provider: "mock",
    model: "mock-1",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rid = created.body.run.id;
  const now = new Date();
  const leases = await Promise.all([
    aliceStore.runs.acquireLease(pid, rid, "first", 60_000, now),
    aliceStore.runs.acquireLease(pid, rid, "second", 60_000, now),
  ]);
  assert.equal(leases.filter(Boolean).length, 1);
  await aliceStore.runs.releaseLease(pid, rid, leases[0] ? "first" : "second");
  assert.ok((await store.worker!.activeRuns()).some((r) => r.runId === rid));
  console.info("PASS Postgres: atomic concurrent job lease and background-worker discovery.");

  const done = await driveRun(c, pid, rid);
  assert.equal(done.status, "ready_for_review", JSON.stringify(done));
  const checkpoints = await aliceStore.runs.checkpoints(pid, rid);
  assert.ok(checkpoints.length > 0);
  const cp = { ...checkpoints[0], key: "smoke:concurrent-checkpoint" };
  assert.equal(
    (await Promise.all([aliceStore.runs.putCheckpoint(pid, cp), aliceStore.runs.putCheckpoint(pid, cp)])).filter(Boolean).length,
    1,
  );
  const draft = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body
    .revision;
  assert.ok(draft.content.abox && draft.content.abox.individuals.length > 0);
  // The mock extraction has validation warnings: exercise the same explicit
  // confirmation step as the UI before checking durable revision commits.
  const unconfirmed = await c.json("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`);
  assert.equal(unconfirmed.status, 428, JSON.stringify(unconfirmed.body));
  const committed = await c.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, {
    acknowledgedWarnings: true,
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.revision.number, 2);
  await assert.rejects(
    aliceStore.revisions.updateDraft(
      pid,
      draft.id,
      { summary: "illegal", contentHash: "x", stats: draft.stats, updatedAt: new Date().toISOString() },
      draft.content,
    ),
    /Committed revisions/,
  );
  assert.equal((await c.get(`/api/projects/${pid}/revisions/${draft.id}/export?scope=combined&ack=1`)).status, 200);
  const report = await c.json("POST", `/api/projects/${pid}/revisions/${draft.id}/validate`, {});
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.ok(await aliceStore.reports.latest(pid, draft.id));
  const nextA = await c.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions`, {
    content: draft.content,
    source: "manual",
    summary: "Concurrent A",
  });
  const nextB = await c.json<{ revision: OntologyRevision }>("POST", `/api/projects/${pid}/revisions`, {
    content: draft.content,
    source: "manual",
    summary: "Concurrent B",
  });
  const commits = await Promise.all(
    [nextA, nextB].map((r) => c.json("POST", `/api/projects/${pid}/revisions/${r.body.revision.id}/commit`)),
  );
  assert.deepEqual(commits.map((r) => r.status).sort(), [200, 409]);
  console.info(
    "PASS Postgres: checkpoint uniqueness, extraction, immutable commits, stale-commit conflict, validation and RDF export (mock LLM).",
  );

  const conversation = {
    id: `conversation_${prefix}`,
    projectId: pid,
    revisionId: draft.id,
    title: "Persistence check",
    messages: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await aliceStore.conversations.put(conversation);
  assert.equal((await aliceStore.conversations.get(pid, conversation.id))?.title, conversation.title);
  const archive = await c.get(`/api/projects/${pid}/archive`);
  assert.equal(archive.status, 200);
  const restored = await c.upload("/api/projects/import", "neon-smoke.ontolab.json.gz", Buffer.from(await archive.arrayBuffer()));
  assert.equal(restored.status, 201, JSON.stringify(restored.body));
  console.info("PASS Postgres: conversations and project archive export/import.");

  await app.close();
  app = await startApp({ store });
  const after = await app.as(aliceId).json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${draft.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.revision.content.abox?.individuals.length, draft.content.abox.individuals.length);
  assert.equal((await app.as(aliceId).get(`/api/projects/${pid}/documents/${docs[0].id}/file`)).status, 200);
  // A fresh pool proves the data is in Neon, rather than process memory/files.
  const fresh = createPostgresStore(process.env.DATABASE_URL);
  try {
    assert.equal((await fresh.forUser({ id: aliceId }).revisions.get(pid, draft.id))?.number, 2);
  } finally {
    await fresh.close!();
  }
  console.info("PASS Postgres: data and uploads survive HTTP server restart and a fresh database pool.");
} finally {
  await app.close();
  await aliceStore.blobs.delete(workspaceActionPath);
  for (const s of [aliceStore, bobStore]) {
    for (const p of await s.projects.list()) await s.projects.delete(p.id);
    for (const c of await s.connections.list()) await s.connections.delete(c.id, c.version);
  }
  await store.close!();
}
console.info("Postgres end-to-end check passed; temporary test projects removed.");
