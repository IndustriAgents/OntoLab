import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, type Client, type TestApp } from "./helpers.ts";
import type { Project } from "../src/types/project.ts";

let app: TestApp;
let alice: Client;
let pid: string;
const model = { provider: "mock", model: "mock-1" };
beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
  pid = (await alice.json<{ project: Project }>("POST", "/api/projects", { name: "Sensor research" })).body.project.id;
});
afterEach(async () => app.close());

describe("AI user story suggestions", () => {
  it("returns an improved story without changing saved stories or question approvals", async () => {
    await alice.json("PUT", `/api/projects/${pid}/requirements`, {
      stories: ["A saved story"],
      cqs: [{ id: "q1", text: "Which sensors measure pressure?", status: "approved", source: "user" }],
    });
    const before = (await alice.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project;
    const result = await alice.json<{ story: string }>("POST", `/api/projects/${pid}/requirements/suggest-story`, {
      ...model,
      story: "find pressure sensors",
      otherStories: ["Trace evidence to its source."],
    });
    expect(result.status).toBe(200);
    expect(result.body.story).toContain("find pressure sensors");
    const after = (await alice.json<{ project: Project }>("GET", `/api/projects/${pid}`)).body.project;
    expect(after).toEqual(before);
  });

  it("can draft from the project purpose or a parsed document when the field is empty", async () => {
    const empty = await alice.json("POST", `/api/projects/${pid}/requirements/suggest-story`, { ...model, story: "" });
    expect(empty.status).toBe(400);
    await alice.upload(`/api/projects/${pid}/documents`, "sensors.txt", "Pressure sensors measure hydraulic pressure.", false);
    await app.processDocuments();
    const fromDoc = await alice.json<{ story: string }>("POST", `/api/projects/${pid}/requirements/suggest-story`, { ...model, story: "" });
    expect(fromDoc.status).toBe(200);
    expect(fromDoc.body.story).toMatch(/^As a /);
    await alice.json("PATCH", `/api/projects/${pid}`, { purpose: "Compare pressure sensor specifications." });
    const fromPurpose = await alice.json("POST", `/api/projects/${pid}/requirements/suggest-story`, { ...model });
    expect(fromPurpose.status).toBe(200);
  });

  it("rejects invalid and excessive input instead of silently shortening stories", async () => {
    for (const input of [
      { story: 42 },
      { story: "x".repeat(1001) },
      { story: "find sensors", otherStories: Array(13).fill("story") },
      { story: "find sensors", otherStories: [12] },
    ]) {
      expect((await alice.json("POST", `/api/projects/${pid}/requirements/suggest-story`, { ...model, ...input })).status).toBe(400);
    }
  });

  it("does not expose another user's project context", async () => {
    const other = await app.as("bob").json("POST", `/api/projects/${pid}/requirements/suggest-story`, { ...model, story: "find sensors" });
    expect(other.status).toBe(404);
  });
});
