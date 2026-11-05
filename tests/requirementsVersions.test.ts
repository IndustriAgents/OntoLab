import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp, type Client } from "./helpers";
import type { Project, Requirements, RunView } from "../src/types/project";
import type { RunResearch } from "../src/types/research";

let app: TestApp;
let client: Client;
let pid: string;
const first: Requirements = {
  stories: ["As an engineer, I want to compare pressure sensors."],
  cqs: [{ id: "q1", text: "Which sensors measure pressure?", status: "approved", source: "user" }],
};
const second: Requirements = {
  stories: ["As an engineer, I want to trace controller commands."],
  cqs: [{ id: "q2", text: "Which controllers issue commands?", status: "approved", source: "user" }],
};
beforeEach(async () => {
  app = await startApp();
  client = app.as("alice");
  pid = (
    await client.json<{ project: Project }>("POST", "/api/projects", {
      name: "Requirements",
      settings: { models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
});
afterEach(async () => app.close());
const save = async (requirements: Requirements) => {
  const result = await client.json<{ project: Project }>("PUT", `/api/projects/${pid}/requirements`, requirements);
  expect(result.status).toBe(200);
  return result.body.project;
};

describe("versioned project requirements", () => {
  it("keeps immutable history, skips unchanged saves, and restores as a new version", async () => {
    const v1 = await save(first);
    expect(v1.settings.requirementsVersions?.map((v) => v.number)).toEqual([1]);
    expect((await save(first)).settings.requirementsVersions).toEqual(v1.settings.requirementsVersions);
    const v2 = await save(second);
    expect(v2.settings.requirementsVersions?.map((v) => v.number)).toEqual([1, 2]);
    expect(v2.settings.requirementsVersions?.[0].requirements).toEqual(first);
    const restored = await client.json<{ project: Project }>("POST", `/api/projects/${pid}/requirements/versions/1/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.project.settings.requirementsVersions?.at(-1)).toMatchObject({ number: 3, restoredFrom: 1, requirements: first });
    expect(restored.body.project.competencyQuestions).toEqual([first.cqs[0].text]);
    expect(restored.body.project.settings.requirementsVersions?.[1].requirements).toEqual(second);
    expect((await client.json("POST", `/api/projects/${pid}/requirements/versions/999/restore`)).status).toBe(404);
    expect((await app.as("bob").json("POST", `/api/projects/${pid}/requirements/versions/1/restore`)).status).toBe(404);
  });

  it("preserves legacy requirements as v1 and ignores stale history in general settings saves", async () => {
    const legacy = (
      await client.json<{ project: Project }>("POST", "/api/projects", { name: "Legacy", competencyQuestions: ["Original question?"] })
    ).body.project;
    pid = legacy.id;
    const changed = await save(second);
    expect(changed.settings.requirementsVersions?.[0].requirements.cqs[0].text).toBe("Original question?");
    const patched = await client.json<{ project: Project }>("PATCH", `/api/projects/${pid}`, {
      settings: { ...legacy.settings, requirements: first, requirementsVersions: [] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.settings.requirementsVersions).toEqual(changed.settings.requirementsVersions);
    expect(patched.body.project.settings.requirements).toEqual(second);
  });

  it("retains both concurrent saves in history", async () => {
    await save(first);
    await Promise.all([save(second), save({ ...second, stories: ["Another goal"] })]);
    const project = (await client.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project;
    expect(project.settings.requirementsVersions?.map((v) => v.number)).toEqual([1, 2, 3]);
    expect(
      project.settings.requirementsVersions
        ?.slice(1)
        .map((v) => v.requirements.stories[0])
        .sort(),
    ).toEqual([second.stories[0], "Another goal"].sort());
  });

  it("executes an ontology build with its pinned requirements after the project changes", async () => {
    await save(first);
    const doc = (
      await client.upload(
        `/api/projects/${pid}/documents`,
        "sensors.txt",
        "A pressure Sensor measures pressure in a Device. A Controller issues commands.",
      )
    ).body.document.id as string;
    const created = await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      kind: "induction",
      provider: "mock",
      model: "mock-1",
      documentIds: [doc],
    });
    expect(created.status).toBe(201);
    const run = created.body.run;
    expect(run.requirementsSnapshot).toMatchObject({ version: 1, requirements: first });
    await save(second);
    const finished = await driveRun(client, pid, run.id);
    expect(finished.status).toBe("ready_for_review");
    const research = (await client.json<RunResearch>("GET", `/api/projects/${pid}/runs/${run.id}/research`)).body;
    expect(research.inputs?.requirements).toMatchObject({ requirementsVersion: 1, requirements: first });
    const recorded = JSON.stringify(research.checkpoints.map((step) => step.trace?.input));
    expect(recorded).toContain(first.cqs[0].text);
    expect(recorded).not.toContain(second.cqs[0].text);
    const next = await client.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      kind: "induction",
      provider: "mock",
      model: "mock-1",
      documentIds: [doc],
    });
    expect(next.body.run.requirementsSnapshot).toMatchObject({ version: 2, requirements: second });
  });
});
