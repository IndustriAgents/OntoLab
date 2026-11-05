import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceReturnPath } from "../src/lib/workspace.js";
test("bundled documentation returns to the current workspace without external redirects", () => {
  const origin = "http://127.0.0.1:5173";
  assert.equal(
    workspaceReturnPath("/p/project/assistant?c=conversation#answer", "/docs/", origin),
    "/p/project/assistant?c=conversation#answer",
  );
  assert.equal(
    workspaceReturnPath("/ontolab/p/project/graph?tab=settings", "/ontolab/docs/", origin),
    "/ontolab/p/project/graph?tab=settings",
  );
  for (const bad of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/api/projects",
    "/unknown-route",
    "/docs/start/quickstart/",
    "javascript:alert(1)",
    null,
  ])
    assert.equal(workspaceReturnPath(bad, "/docs/", origin), "/");
  assert.equal(workspaceReturnPath("/p/other", "/ontolab/docs/", origin), "/ontolab/");
});
