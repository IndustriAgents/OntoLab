import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

// Exercise real HTTP imports with small limits instead of allocating huge buffers in CI.
vi.mock("../server/config.ts", async (original) => ({
  ...(await original<object>()),
  MAX_ARCHIVE_BYTES: 64 * 1024,
  MAX_ARCHIVE_EXPANDED_BYTES: 32 * 1024,
}));
let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(async () => {
  await app.close();
});
const archive = (padding = "") =>
  Buffer.from(
    JSON.stringify({
      format: "ontolab-archive",
      version: 2,
      project: { name: "Import", settings: {} },
      documents: [],
      revisions: [],
      padding,
    }),
  );

it.each([false, true])("imports a valid archive (gzip=%s)", async (compressed) => {
  const bytes = archive("a".repeat(30 * 1024));
  const result = await app.as("alice").upload("/api/projects/import", "backup.gz", compressed ? gzipSync(bytes) : bytes);
  expect(result.status).toBe(201);
});
it.each([false, true])("rejects oversized expanded JSON before creating projects (gzip=%s)", async (compressed) => {
  const bytes = archive("a".repeat(33 * 1024));
  const client = app.as("alice");
  const result = await client.upload("/api/projects/import", "backup.gz", compressed ? gzipSync(bytes) : bytes);
  expect(result.status).toBe(413);
  expect(result.body.error).toContain("expanded archive");
  expect((await client.json<any>("GET", "/api/projects")).body.projects).toEqual([]);
  expect((await client.get("/api/health")).status).toBe(200);
});
it("applies the expansion limit across concatenated gzip members", async () => {
  const bytes = Buffer.concat([gzipSync(Buffer.alloc(20 * 1024, 32)), gzipSync(Buffer.alloc(20 * 1024, 32))]);
  expect((await app.as("alice").upload("/api/projects/import", "backup.gz", bytes)).status).toBe(413);
});
it("rejects oversized request bodies and malformed compressed input", async () => {
  const client = app.as("alice");
  expect((await client.upload("/api/projects/import", "backup", Buffer.alloc(65 * 1024))).status).toBe(413);
  expect((await client.upload("/api/projects/import", "backup.gz", Buffer.from([0x1f, 0x8b, 0]))).status).toBe(400);
});
