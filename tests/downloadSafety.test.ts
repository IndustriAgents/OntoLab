import { afterEach, beforeEach, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(async () => {
  await app.close();
});

it.each([
  ["attack.html", "text/html", "<script>fetch('/api/projects')</script>"],
  ["attack.xml", "application/xml", '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'],
  ["notes.txt", "text/plain", "Original document bytes"],
])("downloads %s without allowing an active same-origin document", async (name, mime, bytes) => {
  const client = app.as("alice");
  const { body } = await client.json<any>("POST", "/api/projects", { name: "Download safety" });
  const path = `/api/projects/${body.project.id}/documents`;
  const upload = await client.upload(path, name, bytes, false);
  expect(upload.status).toBe(201);
  const response = await client.get(`${path}/${(upload.body.document as any).id}/file`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(mime);
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(response.headers.get("content-security-policy")).toContain("sandbox;");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe(bytes);
});
