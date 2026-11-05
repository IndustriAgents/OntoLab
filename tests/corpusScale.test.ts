import { afterEach, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers";
import { createLocalStore } from "../server/store/local";
import type { CorpusMember, CorpusPlan } from "../src/types/corpus";
import type { Project, ProjectDocument, RunView } from "../src/types/project";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
});
it("plans 1,000 corpus sources, checkpoints bounded work, and permits replacements at the source limit", async () => {
  app = await startApp();
  const c = app.as("alice");
  const parent = (
    await c.json<{ project: Project }>("POST", "/api/projects", { name: "Scale", settings: { models: { embeddings: "hash", nli: "off" } } })
  ).body.project;
  const rid = (
    await c.json<{ revision: { id: string } }>("POST", `/api/projects/${parent.id}/revisions`, {
      source: "import",
      content: { modules: [{ id: "core", name: "schema", turtle: "<http://ex/Pump> a <http://www.w3.org/2002/07/owl#Class>." }] },
    })
  ).body.revision.id;
  expect((await c.json("POST", `/api/projects/${parent.id}/revisions/${rid}/commit`, { acknowledgedWarnings: true })).status).toBe(200);
  const corpus = (
    await c.json<{ corpus: Project }>("POST", `/api/projects/${parent.id}/corpora`, {
      name: "1000 sources",
      ontologyRevisionId: rid,
      provider: "mock",
      model: "mock-1",
    })
  ).body.corpus;
  const root = `/api/projects/${corpus.id}/corpus`;
  const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
  const first = (await c.upload(`${root}/documents`, "first.txt", "Pump is equipment.", false)).body.document as ProjectDocument;
  await app.processDocuments();
  const template = (await store.documents.get(corpus.id, first.id))!;
  const text = (await store.documents.getText(corpus.id, first.id))!;
  const chunks = await store.documents.chunks(corpus.id, [first.id]);
  const saved = (await store.projects.get(corpus.id))!;
  const members: CorpusMember[] = [...saved.settings.corpus!.members];
  for (let base = 1; base < 999; base += 25) {
    await Promise.all(
      Array.from({ length: Math.min(25, 999 - base) }, async (_, offset) => {
        const index = base + offset,
          id = `doc_scale_${index}`,
          checksum = `checksum_${index}`;
        const document = { ...template, id, name: `source-${index}.txt`, checksum };
        await store.documents.create(document);
        await store.documents.putText(
          corpus.id,
          id,
          text,
          chunks.map((chunk, i) => ({ ...chunk, id: `${id}_c${i}`, documentId: id })),
        );
        members.push({
          id: `src_scale_${index}`,
          name: document.name,
          headDocumentId: id,
          removed: false,
          versions: [{ documentId: id, checksum, number: 1, createdAt: template.createdAt }],
        });
      }),
    );
  }
  await store.projects.compareAndSwapSettings(
    corpus.id,
    saved.settings,
    { ...saved.settings, corpus: { ...saved.settings.corpus!, version: saved.settings.corpus!.version + 1, members } },
    template.createdAt,
  );
  const last = await c.upload(`${root}/documents`, "last.txt", "The last pump has a distinct source.", false);
  expect(last.status).toBe(201);
  await app.processDocuments();
  const plan = (await c.json<CorpusPlan>("POST", `${root}/plan`, {})).body;
  expect(plan.errors).toEqual([]);
  expect(plan.processDocumentIds).toHaveLength(1000);
  const started = await c.json<{ run: RunView }>("POST", `${root}/updates`, { hash: plan.hash });
  expect(started.status).toBe(200);
  expect(started.body.run.documentIds).toHaveLength(1000);
  const advanced = (await c.json<{ run: RunView }>("POST", `/api/projects/${corpus.id}/runs/${started.body.run.id}/advance`)).body.run;
  expect(advanced.status).toBe("running");
  expect(advanced.completedSteps).toBe(1);
  expect(await store.runs.checkpoints(corpus.id, advanced.id)).toHaveLength(1);
  await c.json("POST", `/api/projects/${corpus.id}/runs/${advanced.id}/cancel`);
  const retried = (await c.json<{ run: RunView }>("POST", `/api/projects/${corpus.id}/runs/${advanced.id}/retry`)).body.run;
  expect(retried.completedSteps).toBe(1);
  expect(retried.documentIds).toHaveLength(1000);
  expect((await c.upload(`${root}/documents`, "overflow.txt", "Additional source.", false)).status).toBe(409);
  expect((await c.upload(`${root}/documents`, "duplicate.txt", "Pump is equipment.", false)).status).toBe(200);
  const member = members[0];
  expect((await c.upload(`${root}/documents?member=${member.id}`, "replacement.txt", "A corrected pump source.", false)).status).toBe(201);
  expect((await store.projects.get(corpus.id))!.settings.corpus!.members).toHaveLength(1000);
}, 60000);
