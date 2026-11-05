import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const output = process.env.ONTOLAB_DOCS_OUTPUT ? pathToFileURL(resolve(process.env.ONTOLAB_DOCS_OUTPUT) + sep) : new URL("build/", root);
const bundled = process.env.ONTOLAB_BUNDLED_DOCS === "1";
const base = bundled ? (process.env.ONTOLAB_DOCS_APP_BASE ?? "").replace(/\/+$/, "") + "/docs/" : "/ontolab/";
const origin = bundled ? "http://localhost" : "http://localhost:8788";
const pages = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".md")) pages.push(p);
  }
}
await walk(new URL("docs", root).pathname);
assert.ok(pages.length >= 25, "Core documentation pages are missing");
const index = await readFile(new URL("index.html", output), "utf8");
assert.ok(index.includes(origin + base), "Canonical URL missing");
const search = await readFile(new URL("pagefind/pagefind.js", output), "utf8");
assert.ok(search.length > 1000, "Search bundle missing");
const links = pages.map((p) => base + p.split("/docs/")[1].replace(/\.md$/, "/"));
const htmlPages = [index];
for (const link of links) {
  htmlPages.push(await readFile(new URL(link.slice(base.length) + "index.html", output), "utf8"));
}
// Check rendered URLs, including files transformed by the Markdown compiler.
// A trailing slash added to a download URL can pass source-link validation.
const assets = new Set();
for (const html of htmlPages) {
  for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    const url = new URL(match[1], origin);
    if (url.origin === origin && url.pathname.startsWith(base) && /\.[a-z0-9]{2,8}\/?$/i.test(url.pathname)) {
      assets.add(url.pathname);
    }
  }
}
for (const asset of assets) {
  const file = new URL(asset.slice(base.length), output);
  assert.ok((await stat(file)).isFile(), `Rendered asset URL must resolve to a file: ${asset}`);
}
// A public, plain-text documentation index also helps agents discover the canonical pages.
await writeFile(
  new URL("llms.txt", output),
  "# OntoLab\n\nPublic documentation for OntoLab Desktop Preview 3 and corresponding source behavior.\n\n" +
    links.map((l) => "- " + (bundled ? l : origin + l)).join("\n") +
    "\n",
);
console.log(`Verified ${pages.length} documentation pages, ${assets.size} rendered assets, canonical base path and local search bundle.`);
