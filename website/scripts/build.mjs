import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, process.env.ONTOLAB_DOCS_OUTPUT ?? "build");
function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, "node_modules", script), ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Documentation build failed (${result.status}): ${script}`);
}
run("@docusaurus/core/bin/docusaurus.mjs", ["build", "--out-dir", output]);
run("pagefind/lib/runner/bin.cjs", ["--site", output, "--root-selector", "article", "--output-subdir", "pagefind"]);

if (process.env.ONTOLAB_BUNDLED_DOCS === "1") {
  const base = (process.env.ONTOLAB_DOCS_APP_BASE ?? "").replace(/\/+$/, "") + "/docs/";
  // Keep the desktop CSP intact: move Docusaurus's executable theme bootstrap
  // into same-origin files rather than permitting arbitrary inline scripts.
  async function externalize(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await externalize(path);
      else if (entry.name.endsWith(".html")) {
        const html = await readFile(path, "utf8");
        const scripts = new Map();
        const next = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs, body) => {
          if (/\bsrc\s*=|\btype\s*=\s*["']application\/(?:ld\+)?json/i.test(attrs) || !body.trim()) return whole;
          const name = `bootstrap-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.js`;
          scripts.set(name, body);
          return `<script${attrs} src="${base}assets/js/${name}"></script>`;
        });
        for (const [name, body] of scripts) {
          const file = join(output, "assets/js", name);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, body);
        }
        await writeFile(path, next);
      }
    }
  }
  await externalize(output);
}
const result = spawnSync(process.execPath, [join(root, "scripts/check-site.mjs")], { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
