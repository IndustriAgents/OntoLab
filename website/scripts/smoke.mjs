import assert from "node:assert/strict";
const base = process.argv[2];
const expectedCommit = process.argv[3];
assert.ok(base?.startsWith("http"));
for (const [path, status, contains] of [
  ["/__docs/health", 200, '"ok":true'],
  ["/", 200, "/ontolab/"],
  ["/ontolab/", 200, "Documents."],
  ["/ontolab/start/quickstart/", 200, "Your first knowledge graph"],
  ["/ontolab/reference/formats/", 200, "Supported formats"],
  ["/ontolab/pagefind/pagefind.js", 200, "pagefind"],
  ["/ontolab/mechatronic-tbox.ttl", 200, "owl:"],
  ["/ontolab/distributing-manual.txt", 200, "Distributing station DS-10"],
  ["/ontolab/llms.txt", 200, "# OntoLab"],
  ["/ontolab/missing-article/", 404],
  ["/missing-product/", 404],
]) {
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  assert.equal(r.status, status, `${path}: cf-ray=${r.headers.get("cf-ray")}; ${body.slice(0, 400)}`);
  if (contains) assert.ok(body.includes(contains), `${path}: expected content missing`);
  if (path === "/__docs/health" && expectedCommit) {
    assert.equal(JSON.parse(body).commit, expectedCommit, "Production source commit");
  }
  console.log(`${status} ${path}`);
}
const canonical = await fetch(new URL("/ontolab", base), { redirect: "manual" });
assert.equal(canonical.status, 308);
assert.ok(canonical.headers.get("location").endsWith("/ontolab/"));
console.log("Documentation deployment smoke checks passed.");
