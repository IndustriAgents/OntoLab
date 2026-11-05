// Explicit integration check: point TEST_DATABASE_URL at an isolated, migrated branch.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresStore } from "../server/store/postgres.ts";
import { createProject } from "../server/services/projects.ts";
import { uploadDocument, processDocument } from "../server/services/documents.ts";
import { previewChunks, saveChunkVariant } from "../server/services/research.ts";
import { silentLogger, type ServiceCtx } from "../server/services/context.ts";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must point to an isolated test database.");
const store = createPostgresStore(process.env.TEST_DATABASE_URL);
const user = { id: `processing-check-${randomUUID()}` };
const owner = store.forUser(user);
const ctx: ServiceCtx = { store: owner, user, log: silentLogger, now: () => new Date(), requestId: "processing-check" };
let pid: string | undefined;
try {
  pid = (await createProject(ctx, { name: "Temporary document processing check" })).id;
  const doc = await uploadDocument(
    ctx,
    pid,
    "check.xml",
    Buffer.from("<article><body><sec><title>Results</title><p>Motor A moves.</p></sec></body></article>"),
    { deferParsing: true },
  );
  assert.equal(doc.processing?.stage, "queued");
  assert.ok((await store.worker!.pendingDocuments!()).some((j) => j.documentId === doc.id && j.ownerId === user.id));
  const pair = await Promise.all([processDocument(ctx, pid, doc.id), processDocument(ctx, pid, doc.id)]);
  assert.equal(pair.filter(Boolean).length, 1);
  const parsed = await owner.documents.get(pid, doc.id);
  assert.equal(parsed?.chunkCount, 0);
  assert.equal(parsed?.parsing?.version, "xml-article-v1");
  const settings = { method: "section" as const, maxChars: 500, overlap: 0.1 };
  const preview = await previewChunks(ctx, pid, doc.id, settings);
  const configured = await saveChunkVariant(ctx, pid, doc.id, settings, preview.textHash);
  assert.equal(configured.id, doc.id);
  assert.ok(configured.chunkCount > 0);
  assert.equal(await store.forUser({ id: "different-owner" }).documents.get(pid, doc.id), null);
  assert.equal(await owner.documents.finishProcessing!(pid, doc.id, "stale", { parseState: "failed" }), null);
  const text = await owner.documents.getText(pid, doc.id);
  assert.ok(text?.sourceSpans?.length);
  console.info("Postgres queue discovery, atomic claims, XML extraction, explicit chunking, source paths and ownership checks passed.");
} finally {
  if (pid) await owner.projects.delete(pid);
  await store.close?.();
}
