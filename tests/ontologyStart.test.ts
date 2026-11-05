import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, type TestApp, type Client } from "./helpers.ts";
import type { Project, OntologyRevision, RevisionWithContent } from "../src/types/project.ts";
import { WORKFLOWS, workflowSteps, workflowStep } from "../src/features/workflows/model.ts";

let app: TestApp;
let client: Client;
let project: Project;
beforeEach(async () => {
  app = await startApp();
  client = app.as("alice");
  project = (await client.json<{ project: Project }>("POST", "/api/projects", { name: "Research workspace", purpose: "My own purpose" }))
    .body.project;
});
afterEach(async () => app.close());

describe("ontology starting points", () => {
  it("applies a template inside the existing project as an uncommitted draft", async () => {
    const endpoint = `/api/projects/${project.id}/templates/technical-manuals`;
    expect((await app.as("bob").json("POST", endpoint)).status).toBe(404);
    const result = await client.json<{ revision: OntologyRevision }>("POST", endpoint);
    expect(result.status).toBe(201);
    expect(result.body.revision).toMatchObject({ projectId: project.id, status: "draft", source: "template", number: null });
    expect(result.body.revision.stats.classes).toBeGreaterThan(0);
    const updated = (await client.json<{ project: Project }>("GET", `/api/projects/${project.id}`)).body.project;
    expect(updated.name).toBe("Research workspace");
    expect(updated.purpose).toBe("My own purpose");
    expect(updated.currentRevisionId).toBeNull();
    expect(updated.settings.requirements!.cqs.length).toBeGreaterThan(0);
    expect((await client.json<{ projects: Project[] }>("GET", "/api/projects")).body.projects).toHaveLength(1);
    const draft = (
      await client.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${project.id}/revisions/${result.body.revision.id}`)
    ).body.revision;
    expect(draft.content.modules).toHaveLength(1);
  });

  it("preserves existing requirements and current saved versions", async () => {
    const cq = "Which sensor measures pressure?";
    await client.json("PUT", `/api/projects/${project.id}/requirements`, {
      stories: ["As an engineer, I need sensor facts."],
      cqs: [{ text: cq, status: "approved", source: "manual" }],
    });
    const first = (await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${project.id}/templates/technical-manuals`))
      .body.revision;
    await client.json("POST", `/api/projects/${project.id}/revisions/${first.id}/commit`, { acknowledgedWarnings: true });
    const second = (await client.json<{ revision: OntologyRevision }>("POST", `/api/projects/${project.id}/templates/contracts`)).body
      .revision;
    const updated = (await client.json<{ project: Project }>("GET", `/api/projects/${project.id}`)).body.project;
    expect(updated.currentRevisionId).toBe(first.id);
    expect(second.status).toBe("draft");
    expect(updated.settings.requirements!.cqs.map((q) => q.text)).toEqual([cq]);
    const saved = (await client.json<{ revision: OntologyRevision }>("GET", `/api/projects/${project.id}/revisions/${first.id}`)).body
      .revision;
    expect(saved.status).toBe("committed");
    expect(saved.contentHash).toBe(first.contentHash);
  });

  it("rejects an unknown template without creating a draft", async () => {
    expect((await client.json("POST", `/api/projects/${project.id}/templates/does-not-exist`)).status).toBe(404);
    expect((await client.json<{ revisions: OntologyRevision[] }>("GET", `/api/projects/${project.id}/revisions`)).body.revisions).toEqual(
      [],
    );
  });
});

describe("adaptive workflow navigation", () => {
  it("starts at the choice screen and expands document preprocessing only for the document path", () => {
    expect(workflowStep("tbox", null)).toBe("start");
    expect(workflowSteps("tbox", new URLSearchParams()).map(([key]) => key)).toEqual(["start"]);
    expect(workflowSteps("tbox", new URLSearchParams("start=documents&step=sources")).map(([key]) => key)).toEqual([
      "start",
      "requirements",
      "sources",
      "parse",
      "chunks",
      "generate",
      "results",
      "validate",
    ]);
  });
  it.each(["template", "import", "previous"])("skips document generation for %s", (start) => {
    const params = new URLSearchParams({ start, step: "review", rev: "draft" });
    expect(workflowSteps("tbox", params).map(([key]) => key)).toEqual(["start", "requirements", "review", "validate"]);
    expect(workflowStep("tbox", "parse", params)).toBe("start");
    params.set("from", "original-build");
    expect(workflowStep("tbox", "parse", params)).toBe("start");
  });
  it("preserves historical run URLs and other workflows", () => {
    const params = new URLSearchParams("run=history&step=results");
    expect(workflowSteps("tbox", params).map(([key]) => key)).toEqual([
      "requirements",
      "sources",
      "parse",
      "chunks",
      "generate",
      "results",
      "validate",
    ]);
    expect(workflowStep("tbox", "results", params)).toBe("results");
    expect(workflowStep("tbox", null, new URLSearchParams("history=1"))).toBe("sources");
    for (const kind of ["abox", "alignment"] as const) expect(workflowSteps(kind, new URLSearchParams())).toEqual(WORKFLOWS[kind].steps);
  });
});
