import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, driveRun, type Client, type TestApp } from "./helpers.ts";
import type { Project, ProjectDocument, RevisionWithContent, RunView } from "../src/types/project.ts";
import type { RunResearch } from "../src/types/research.ts";
import * as induction from "../server/services/induction.ts";
import { ontologyBuildParams } from "../src/lib/ontologyBuild.ts";

let app: TestApp;
let c: Client;
let pid: string;
let did: string;
const ttl =
  '@prefix ex: <http://example.org/#>. @prefix owl: <http://www.w3.org/2002/07/owl#>. @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>. ex:Device a owl:Class; rdfs:label "Device"; rdfs:comment "A physical device". ex:Sensor a owl:Class; rdfs:subClassOf ex:Device; rdfs:label "Sensor"; rdfs:comment "Measures pressure".';
beforeEach(async () => {
  app = await startApp();
  c = app.as("alice");
  pid = (
    await c.json<{ project: Project }>("POST", "/api/projects", {
      name: "Build iteration",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  did = (
    await c.upload(
      `/api/projects/${pid}/documents`,
      "manual.txt",
      "A Sensor measures pressure in a Device. A Controller controls the Sensor.",
    )
  ).body.document.id as string;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});
const input = () => ({ kind: "induction", mode: "automatic", provider: "mock", model: "mock-1", documentIds: [did] });
async function version(projectId = pid, turtle = ttl) {
  const created = await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${projectId}/revisions`, {
    content: { modules: [{ id: "core", name: "core.ttl", turtle }], abox: null, baseIri: "" },
    source: "import",
    summary: "Starting ontology",
  });
  expect(created.status).toBe(201);
  const committed = await c.json("POST", `/api/projects/${projectId}/revisions/${created.body.revision.id}/commit`, {
    acknowledgedWarnings: true,
  });
  expect(committed.status).toBe(200);
  return created.body.revision.id;
}
describe("repeatable ontology builds", () => {
  it("saves a new version from added documents and changed chunks while preserving the original version and build evidence", async () => {
    const original = (await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, input())).body.run;
    const first = await driveRun(c, pid, original.id);
    expect(first.status).toBe("ready_for_review");
    const firstId = first.resultRevisionId as string;
    expect((await c.json("POST", `/api/projects/${pid}/revisions/${firstId}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
    const saved = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${firstId}`)).body.revision;
    const before = (await c.json<RunResearch>("GET", `/api/projects/${pid}/runs/${original.id}/research`)).body;

    const settings = { method: "fixed", maxChars: 200, overlap: 0 };
    const preview = await c.json<{ textHash: string }>("POST", `/api/projects/${pid}/documents/${did}/chunk-preview`, settings);
    const changed = await c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${did}/chunk-variant`, {
      settings,
      textHash: preview.body.textHash,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.document.variantOf).toBe(did);
    const added = await c.upload(`/api/projects/${pid}/documents`, "additional.txt", "A Valve regulates flow through a Device.");
    const params = ontologyBuildParams(firstId, "sources", original);
    const next = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      ...input(),
      baseRevisionId: params.get("base"),
      sourceRunId: params.get("from"),
      documentIds: [changed.body.document.id, (added.body.document as ProjectDocument).id],
      options: { ...original.options, cqGuided: false },
    });
    expect(next.status).toBe(201);
    expect(next.body.run.options?.cqGuided).toBe(false);
    const done = await driveRun(c, pid, next.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const draft = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body
      .revision;
    expect(draft).toMatchObject({ status: "draft", parentId: firstId });
    expect(draft.content.modules.slice(0, saved.content.modules.length)).toEqual(saved.content.modules);
    expect((await c.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(firstId);
    const committed = await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, {
      acknowledgedWarnings: true,
    });
    expect(committed.status).toBe(200);
    expect(committed.body.revision.number).toBe(2);
    expect((await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${firstId}`)).body.revision).toEqual(
      saved,
    );
    expect((await c.json<RunResearch>("GET", `/api/projects/${pid}/runs/${original.id}/research`)).body).toEqual(before);
  });

  it("builds against an explicitly selected older version and preserves the current one", async () => {
    const first = await version();
    const current = await version(pid, ttl + " <http://example.org/#Valve> a <http://www.w3.org/2002/07/owl#Class>.");
    const created = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, { ...input(), baseRevisionId: first });
    expect(created.status).toBe(201);
    expect(created.body.run.baseRevisionId).toBe(first);
    const done = await driveRun(c, pid, created.body.run.id);
    expect(done.status).toBe("ready_for_review");
    const draft = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body
      .revision;
    expect(draft.parentId).toBe(first);
    expect(draft.status).toBe("draft");
    expect((await c.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(current);
  });

  it("records a duplicated build's lineage and preserves its original snapshot and result", async () => {
    const original = (await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, input())).body.run;
    await driveRun(c, pid, original.id);
    const before = (await c.json<RunResearch>("GET", `/api/projects/${pid}/runs/${original.id}/research`)).body;
    const current = await version();
    const copied = await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      ...input(),
      sourceRunId: original.id,
      baseRevisionId: null,
    });
    expect(copied.status).toBe(201);
    expect(copied.body.run).toMatchObject({ sourceRunId: original.id, baseRevisionId: null });
    const done = await driveRun(c, pid, copied.body.run.id);
    const draft = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body
      .revision;
    expect(draft.parentId).toBeNull();
    expect((await c.json<RunResearch>("GET", `/api/projects/${pid}/runs/${original.id}/research`)).body).toEqual(before);
    expect((await c.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project.currentRevisionId).toBe(current);
  });

  it("rejects a starting version from another project", async () => {
    const other = (await c.json<{ project: Project }>("POST", "/api/projects", { name: "Other" })).body.project.id;
    const foreign = await version(other);
    expect((await c.json("POST", `/api/projects/${pid}/runs`, { ...input(), baseRevisionId: foreign })).status).toBe(404);
    expect((await c.json("POST", `/api/projects/${pid}/runs`, { ...input(), sourceRunId: "missing" })).status).toBe(404);
  });

  it("estimates without requesting embeddings before a build is started", async () => {
    const spy = vi.spyOn(induction, "planSteps").mockImplementation(async (_ctx, _pid, _chunks, embedder) => {
      expect(embedder).toBeNull();
      return [];
    });
    const estimated = await c.json("POST", `/api/projects/${pid}/runs/estimate`, input());
    expect(estimated.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect((await c.json<{ runs: RunView[] }>("GET", `/api/projects/${pid}/runs`)).body.runs).toEqual([]);
  });
});
