import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import handler from "serve-handler";

const require = createRequire(import.meta.url);
const serverRequire = createRequire(require.resolve("serve-handler"));

test("serve-handler receives the callable matcher and its named APIs", () => {
  const match = serverRequire("minimatch");
  assert.equal(match("guides/extract-abox.html", "**/*.html"), true);
  assert.equal(match("guides/extract-abox.html", "**/*.txt"), false);
  assert.deepEqual(match.match(["manual.txt", "index.html"], "*.txt"), ["manual.txt"]);
  assert.equal(new match.Minimatch("**/*.html").match("guides/extract-abox.html"), true);
});

test("the docs server applies header globs and rewritten routes with the patched matcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ontolab-docs-server-"));
  const server = createServer((request, response) =>
    handler(request, response, {
      public: directory,
      rewrites: [{ source: "/guides/**", destination: "/index.html" }],
      headers: [{ source: "**/*", headers: [{ key: "X-Docs-Matched", value: "yes" }] }],
    }),
  );
  try {
    await writeFile(join(directory, "index.html"), "<!doctype html><p>Documentation</p>");
    await writeFile(join(directory, "manual draft.txt"), "Sample document");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const guide = await fetch(`${base}/guides/extract-abox`);
    assert.equal(guide.status, 200);
    assert.equal(guide.headers.get("X-Docs-Matched"), "yes");
    assert.match(await guide.text(), /Documentation/);
    const download = await fetch(`${base}/manual%20draft.txt`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "Sample document");
    assert.equal((await fetch(`${base}/missing-file.txt`)).status, 404);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
