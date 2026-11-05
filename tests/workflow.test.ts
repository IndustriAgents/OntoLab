// The release acceptance workflow, end to end over HTTP with the mock model:
// sample project → extraction → review → commit → validation → export →
// re-import (both the Turtle and the project archive).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, driveRun, type TestApp } from "./helpers.ts";
import { parseABoxTurtle } from "../src/lib/ontology/aboxFromTurtle.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

type J = Record<string, any>;

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());

describe("sample workflow", () => {
  it("goes from upload to a re-imported export without losing data", async () => {
    const c = app.as("engineer");
    const sample = await c.json<J>("POST", "/api/projects/sample");
    const pid = sample.body.project.id;
    const docs = (await c.json<J>("GET", `/api/projects/${pid}/documents`)).body.documents;

    // extraction
    const run = await c.json<J>("POST", `/api/projects/${pid}/runs`, { documentIds: docs.map((d: J) => d.id), mode: "automatic", provider: "mock", model: "mock-1" });
    const done = await driveRun(c, pid, run.body.run.id);
    expect(done.status).toBe("ready_for_review");

    // review: correct a label in the draft, then commit
    const draft = (await c.json<J>("GET", `/api/projects/${pid}/revisions/${done.resultRevisionId}`)).body.revision;
    draft.content.abox.individuals[0].label = "Corrected — Ünïcode label";
    expect((await c.json("PUT", `/api/projects/${pid}/revisions/${draft.id}`, { content: draft.content })).status).toBe(200);
    const committed = await c.json<J>("POST", `/api/projects/${pid}/revisions/${draft.id}/commit`, { acknowledgedWarnings: true });
    expect(committed.body.revision.number).toBe(2);

    // validation of the committed revision
    const report = await c.json<J>("POST", `/api/projects/${pid}/revisions/${draft.id}/validate`, {
      queries: [{ question: "How many individuals?", sparql: "SELECT (COUNT(?s) AS ?n) WHERE { ?s a <http://www.w3.org/2002/07/owl#NamedIndividual> }" }],
    });
    expect(report.body.report.stale).toBe(false);
    expect(Number(report.body.report.cqResults[0].rows[0].n)).toBe(draft.content.abox.individuals.length);

    // export → re-import the Turtle
    const ttlRes = await c.get(`/api/projects/${pid}/revisions/${draft.id}/export?scope=abox&ack=1`);
    expect(ttlRes.status).toBe(200);
    const reparsed = parseABoxTurtle(await ttlRes.text());
    expect(reparsed.individuals.map((i) => i.id).sort()).toEqual(draft.content.abox.individuals.map((i: J) => i.id).sort());
    expect(reparsed.individuals.find((i) => i.label === "Corrected — Ünïcode label")).toBeTruthy();

    const tboxRes = await c.get(`/api/projects/${pid}/revisions/${draft.id}/export?scope=tbox`);
    const tbox = parseTBox(await tboxRes.text());
    expect(tbox.classes.length).toBeGreaterThan(5);
    expect(Object.keys(tbox.subClassOf).length).toBeGreaterThan(0);

    // archive → import as a new project (the pilot's backup path)
    const arch = await c.get(`/api/projects/${pid}/archive`);
    const imported = await c.upload("/api/projects/import", "backup.ontolab.json.gz", Buffer.from(await arch.arrayBuffer()));
    expect(imported.status).toBe(201);
    const np = imported.body.project as J;
    const cur = (await c.json<J>("GET", `/api/projects/${np.id}/revisions/${np.currentRevisionId}`)).body.revision;
    expect(cur.number).toBe(2);
    expect(cur.content.abox.individuals.find((i: J) => i.label === "Corrected — Ünïcode label")).toBeTruthy();
    // evidence survives the round trip
    expect(cur.content.abox.individuals.some((i: J) => i.evidence?.some((e: J) => e.status === "verified"))).toBe(true);
  });
});
