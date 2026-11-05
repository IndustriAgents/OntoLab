import "../server/env.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildBundledDocs(options: { output: string; basePath?: string; cache?: boolean }) {
  const output = resolve(options.output),
    base = (options.basePath ?? "").replace(/\/+$/, "");
  if (base && (!base.startsWith("/") || base.startsWith("//") || /[?#\\]/.test(base))) throw new Error("Invalid documentation mount path.");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const hash = createHash("sha256").update(JSON.stringify({ base, version }));
  const fingerprintFiles = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await fingerprintFiles(file);
      else hash.update(file.slice(root.length)).update(await readFile(file));
    }
  };
  for (const dir of ["website/docs", "website/src", "website/static", "website/scripts"]) await fingerprintFiles(join(root, dir));
  for (const file of [
    "website/docusaurus.config.js",
    "website/sidebars.js",
    "website/package.json",
    "website/package-lock.json",
    "src/styles/helix.css",
    "samples/mechatronic-tbox.ttl",
    "samples/distributing-manual.txt",
    "scripts/build-docs.ts",
  ])
    hash.update(await readFile(join(root, file)));
  const fingerprint = hash.digest("hex"),
    manifest = join(output, "ontolab-docs.json");
  if (options.cache) {
    try {
      if (JSON.parse(await readFile(manifest, "utf8")).fingerprint === fingerprint) {
        console.info("Bundled documentation is up to date.");
        return;
      }
    } catch {
      /* first build */
    }
  }
  console.info(`Building bundled documentation at ${base}/docs/…`);
  await new Promise<void>((done, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", "website", "run", "build"], {
      cwd: root,
      env: {
        ...process.env,
        ONTOLAB_BUNDLED_DOCS: "1",
        ONTOLAB_DOCS_APP_BASE: base,
        ONTOLAB_DOCS_OUTPUT: output,
        ONTOLAB_DOCS_VERSION: version,
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(new Error(`Bundled documentation build failed (${code}). Install website dependencies with npm --prefix website ci.`)),
    );
  });
  await mkdir(output, { recursive: true });
  await writeFile(manifest, JSON.stringify({ version, basePath: `${base}/docs/`, fingerprint, builtAt: new Date().toISOString() }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes("--dev");
  await buildBundledDocs({
    output: dev ? join(root, ".data/bundled-docs") : join(root, "dist/docs"),
    basePath: dev ? "" : process.env.BASE_PATH,
    cache: dev,
  });
}
