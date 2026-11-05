import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.mjs";
const origin = "http://localhost:8788";
const request = (path, method = "GET") => new Request(new URL(path, origin), { method });
test("public hub, canonical product path, health and unknown products", async () => {
  const hub = await worker.fetch(request("/"), {});
  assert.equal(hub.status, 200);
  assert.match(await hub.text(), /href="\/ontolab\/"/);
  const redirect = await worker.fetch(request("/ontolab?from=hub"), {});
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), `${origin}/ontolab/?from=hub`);
  assert.equal((await worker.fetch(request("/other/"), {})).status, 404);
  const robots = await worker.fetch(request("/robots.txt"), {});
  assert.ok((await robots.text()).includes(`Sitemap: ${origin}/ontolab/sitemap.xml`));
  assert.equal((await worker.fetch(request("/ontolab/", "POST"), {})).status, 405);
  assert.deepEqual(await (await worker.fetch(request("/__docs/health"), { SOURCE_COMMIT: "abc" })).json(), {
    ok: true,
    product: "ontolab",
    commit: "abc",
  });
  assert.equal(await (await worker.fetch(request("/", "HEAD"), {})).text(), "");
});
test("asset routing strips only the product prefix and preserves queries, 404s and redirects", async () => {
  const seen = [];
  const env = {
    ASSETS: {
      fetch: async (req) => {
        seen.push(new URL(req.url));
        return new Response("missing", { status: 404 });
      },
    },
  };
  const response = await worker.fetch(request("/ontolab/missing/?q=test"), env);
  assert.equal(response.status, 404);
  assert.equal(seen[0].pathname, "/missing/");
  assert.equal(seen[0].search, "?q=test");
  assert.equal((await worker.fetch(request("/ontolab-other/"), env)).status, 404);
  assert.equal(seen.length, 1);
  env.ASSETS.fetch = async () => Response.redirect(`${origin}/start/quickstart/`, 308);
  const redirect = await worker.fetch(request("/ontolab/start/quickstart"), env);
  assert.equal(redirect.headers.get("location"), `${origin}/ontolab/start/quickstart/`);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});
