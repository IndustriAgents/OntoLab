// Manual knowledge editing: every change is validated against the ontology before it is committed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, type TestApp, type Client } from "./helpers.ts";
import { TTL, C } from "../src/lib/ontology/manualEditing.fixture.ts";

let app: TestApp;
let alice: Client;

beforeEach(async () => {
  app = await startApp();
  alice = app.as("alice");
});
afterEach(async () => app.close());

type J = Record<string, any>;

const valid = {
  individuals: [
    { id: "L1", classUri: C("Station") },
    { id: "S1", classUri: C("Sensor"), objectProperties: [{ propUri: C("partOf"), targetId: "L1" }] },
  ],
};

/** A project whose current revision holds the fixture T-Box and a valid A-Box. */
async function project(): Promise<string> {
  const { body } = await alice.json<J>("POST", "/api/projects", { name: "Manual edits" });
  const pid = body.project.id as string;
  const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "core.ttl", turtle: TTL }], abox: valid, baseIri: "" }, source: "import" });
  expect((await alice.json("POST", `/api/projects/${pid}/revisions/${draft.body.revision.id}/commit`)).status).toBe(200);
  return pid;
}

async function edit(pid: string, abox: J): Promise<string> {
  const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "core.ttl", turtle: TTL }], abox, baseIri: "" }, source: "manual" });
  expect(draft.status).toBe(201);
  return draft.body.revision.id;
}

describe("manual edit validation", () => {
  it("refuses to commit a change that introduces an error, with no override", async () => {
    const pid = await project();
    const rid = await edit(pid, { individuals: [valid.individuals[1]] }); // deletes L1 → S1's link dangles
    const check = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/check`);
    expect(check.status).toBe(200);
    expect(check.body.check.blocked).toBe(true);
    expect(check.body.check.blocking.map((i: J) => i.code)).toContain("dangling-target");
    const commit = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/commit`, { acknowledgedWarnings: true });
    expect(commit.status).toBe(422);
    expect(commit.body.error).toMatch(/dangling|does not exist/);
  });

  it("asks to confirm a change that introduces only warnings", async () => {
    const pid = await project();
    const s1 = { ...valid.individuals[1], dataProperties: [{ propUri: C("pressure"), value: "high" }] };
    const rid = await edit(pid, { individuals: [valid.individuals[0], s1] });
    const check = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/check`);
    expect(check.body.check.blocked).toBe(false);
    expect(check.body.check.introduced.map((i: J) => i.code)).toEqual(["lexical"]);
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`)).status).toBe(428);
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
  });

  it("commits a clean change without confirmation and keeps the edit log", async () => {
    const pid = await project();
    const s1 = { ...valid.individuals[1], dataProperties: [{ propUri: C("pressure"), value: "2.5" }] };
    const draft = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, {
      content: { modules: [{ name: "core.ttl", turtle: TTL }], abox: { individuals: [valid.individuals[0], s1] }, baseIri: "", edits: [{ at: "2026-10-27T10:00:00Z", by: "alice", kind: "add", target: "S1#data:x", summary: "S1 pressure = 2.5" }] },
      source: "manual",
    });
    const rid = draft.body.revision.id;
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`)).status).toBe(200);
    const rev = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${rid}`);
    expect(rev.body.revision.content.edits).toHaveLength(1);
    // the next draft starts from this content but not from its log
    const next = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { ...rev.body.revision.content, edits: [...rev.body.revision.content.edits, { at: "2026-10-27T11:00:00Z", by: "alice", kind: "remove", target: "S1#data:x", summary: "removed" }] }, source: "manual" });
    const own = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${next.body.revision.id}`);
    expect(own.body.revision.content.edits.map((e: J) => e.summary)).toEqual(["removed"]);
    // autosaves from a client still holding the parent's log are trimmed the same way
    await alice.json("PUT", `/api/projects/${pid}/revisions/${next.body.revision.id}`, { content: { ...rev.body.revision.content, edits: [...rev.body.revision.content.edits, { at: "2026-10-27T11:00:00Z", by: "alice", kind: "remove", target: "S1#data:x", summary: "removed" }] } });
    const saved = await alice.json<J>("GET", `/api/projects/${pid}/revisions/${next.body.revision.id}`);
    expect(saved.body.revision.content.edits).toHaveLength(1);
  });

  it("does not hold pre-existing findings against a change", async () => {
    const { body } = await alice.json<J>("POST", "/api/projects", { name: "Legacy" });
    const pid = body.project.id as string;
    const legacy = { individuals: [valid.individuals[0], { id: "S1", classUri: C("Sensor") }] }; // restriction warning
    const first = await alice.json<J>("POST", `/api/projects/${pid}/revisions`, { content: { modules: [{ name: "core.ttl", turtle: TTL }], abox: legacy, baseIri: "" }, source: "import" });
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${first.body.revision.id}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
    const rid = await edit(pid, { individuals: [{ ...legacy.individuals[0], label: "Line 1" }, legacy.individuals[1]] });
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`)).status).toBe(200);
  });

  it("reports a reasoner inconsistency the change introduces", async () => {
    const pid = await project();
    const s1 = { ...valid.individuals[1], additionalTypes: [C("Actuator")] }; // Sensor ⊓ Actuator are disjoint
    const rid = await edit(pid, { individuals: [valid.individuals[0], s1] });
    const check = await alice.json<J>("POST", `/api/projects/${pid}/revisions/${rid}/check`);
    expect(check.body.check.blocked).toBe(true);
    expect(check.body.check.reasoner?.consistent).toBe(false);
    expect((await alice.json("POST", `/api/projects/${pid}/revisions/${rid}/commit`, { acknowledgedWarnings: true })).status).toBe(422);
  });
});
