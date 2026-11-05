import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, type TestApp, type Client } from "./helpers.ts";
import { createLocalStore } from "../server/store/local.ts";
import { startDocumentWorker } from "../server/documentWorker.ts";
import { silentLogger } from "../server/services/context.ts";
import type { DocumentText, ProjectDocument } from "../src/types/project.ts";

let app: TestApp;
let c: Client;
let pid: string;
beforeEach(async () => {
  app = await startApp();
  c = app.as("alice");
  pid = (await c.json<{ project: { id: string } }>("POST", "/api/projects", { name: "Processing stages" })).body.project.id;
});
afterEach(async () => app.close());
const list = async () => (await c.json<{ documents: ProjectDocument[] }>("GET", `/api/projects/${pid}/documents`)).body.documents;
const upload = (name: string, text: string) => c.upload(`/api/projects/${pid}/documents`, name, text, false);

describe("separate upload, parsing and chunk configuration", () => {
  it("stores originals immediately; a new worker resumes the queue, then chunks are explicitly configured", async () => {
    const res = await upload("notes.md", "# Motor\n\nThe motor drives the pump.");
    const queued = res.body.document as ProjectDocument;
    expect(res.status).toBe(201);
    expect(queued.parseState).toBe("pending");
    expect(queued.processing?.stage).toBe("queued");
    expect(await (await c.get(`/api/projects/${pid}/documents/${queued.id}/file`)).text()).toBe("# Motor\n\nThe motor drives the pump.");
    expect((await c.json("GET", `/api/projects/${pid}/documents/${queued.id}/text`)).status).toBe(409);
    const worker = startDocumentWorker(createLocalStore(app.dataDir), silentLogger, { autoStart: false, now: () => app.clock.now })!;
    expect(await worker.tick()).toBe(1);
    await worker.stop();
    const doc = (await list())[0];
    expect(doc.parseState).toBe("parsed");
    expect(doc.chunkCount).toBe(0);
    expect(doc.parsing?.version).toBe("node-text-v1");
    const blocked = await c.json("POST", `/api/projects/${pid}/runs`, {
      kind: "induction",
      provider: "mock",
      model: "mock-1",
      documentIds: [doc.id],
    });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("configure and create chunks");
    const settings = { method: "section", maxChars: 500, overlap: 0.1 };
    const preview = await c.json<{ textHash: string }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-preview`, settings);
    expect((await list())[0].chunkCount).toBe(0);
    const saved = await c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${doc.id}/chunk-variant`, {
      settings,
      textHash: preview.body.textHash,
    });
    expect(saved.body.document.id).toBe(doc.id);
    expect(saved.body.document.chunkCount).toBeGreaterThan(0);
    const text = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`)).body;
    expect(text.chunks.every((chunk) => text.text.slice(chunk.start, chunk.end).length > 0)).toBe(true);
    expect(await list()).toHaveLength(1);
  });

  it("isolates failures, retries without reuploading, and blocks overlapping attempts", async () => {
    await upload("good.txt", "Readable text");
    const res = await upload("broken.pdf", "%PDF-broken");
    const did = (res.body.document as ProjectDocument).id;
    expect((await c.json("POST", `/api/projects/${pid}/documents/${did}/retry`)).status).toBe(409);
    await app.processDocuments();
    expect((await list()).map((d) => d.parseState).sort()).toEqual(["failed", "parsed"]);
    const retry = await c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${did}/retry`);
    expect(retry.body.document.processing?.stage).toBe("queued");
    await app.processDocuments();
    expect((await list()).find((d) => d.id === did)?.parseState).toBe("failed");
    expect((await c.get(`/api/projects/${pid}/documents/${did}/file`)).status).toBe(200);
  });

  it("reclaims an expired lease and rejects stale results, including after removal", async () => {
    const queued = (await upload("a.txt", "A document")).body.document as ProjectDocument;
    const docs = createLocalStore(app.dataDir).forUser({ id: "alice" }).documents;
    const now = app.clock.now;
    const lease = new Date(now.getTime() + 1000).toISOString();
    expect(await docs.claimProcessing!(pid, queued.id, "old", lease, now.toISOString())).not.toBeNull();
    expect(await docs.claimProcessing!(pid, queued.id, "second", lease, now.toISOString())).toBeNull();
    app.clock.now = new Date(now.getTime() + 2000);
    await app.processDocuments();
    expect(await docs.finishProcessing!(pid, queued.id, "old", { parseState: "failed" })).toBeNull();
    expect((await list())[0].parseState).toBe("parsed");
    await c.json("DELETE", `/api/projects/${pid}/documents/${queued.id}`);
    expect(await docs.finishProcessing!(pid, queued.id, "old", {}, { text: { text: "stale", pages: [] }, chunks: [] })).toBeNull();
    expect(await docs.getText(pid, queued.id)).toBeNull();
  });

  it("reprocessing creates a new version and leaves existing text and chunks untouched", async () => {
    const old = (
      await c.upload(
        `/api/projects/${pid}/documents`,
        "article.xml",
        "<article><body><sec><title>Results</title><p>A motor moves.</p></sec></body></article>",
      )
    ).body.document as ProjectDocument;
    const before = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${old.id}/text`)).body;
    const originalBytes = Buffer.from(await (await c.get(`/api/projects/${pid}/documents/${old.id}/file`)).arrayBuffer());
    const res = await c.json<{ document: ProjectDocument }>("POST", `/api/projects/${pid}/documents/${old.id}/reprocess`);
    expect(res.body.document.id).not.toBe(old.id);
    expect(res.body.document.variantOf).toBe(old.id);
    expect(res.body.document.checksum).toBe(old.checksum);
    expect(Buffer.from(await (await c.get(`/api/projects/${pid}/documents/${res.body.document.id}/file`)).arrayBuffer())).toEqual(
      originalBytes,
    );
    await app.processDocuments();
    expect((await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${old.id}/text`)).body).toEqual(before);
    expect(Buffer.from(await (await c.get(`/api/projects/${pid}/documents/${old.id}/file`)).arrayBuffer())).toEqual(originalBytes);
    expect(before.sourceSpans?.[0].path).toContain("/article[1]");
    expect((await app.as("bob").json("POST", `/api/projects/${pid}/documents/${old.id}/reprocess`)).status).toBe(404);
  });
});
