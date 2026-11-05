import { build as bundle } from "esbuild";
import { build as buildWeb } from "vite";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { buildNotices } from "./build-notices.ts";
import { buildBundledDocs } from "./build-docs.ts";

const output = resolve(".desktop");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Render the existing OntoLab mark into the platform packagers' icon source.
const mark = await sharp(await readFile("src/assets/logo-mark-white.svg"))
  .resize(672, 672)
  .png()
  .toBuffer();
const tile = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="#303931"/></svg>',
);
await sharp(tile)
  .composite([{ input: mark, left: 176, top: 176 }])
  .png()
  .toFile(resolve(output, "icon.png"));
// Desktop always serves at the root, independently of a hosted deployment's .env.
process.env.BASE_PATH = "";
await buildWeb({ build: { outDir: resolve(output, "dist") } });
await buildBundledDocs({ output: resolve(output, "dist/docs"), basePath: "" });
await bundle({
  entryPoints: ["desktop/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  outfile: resolve(output, "main.cjs"),
});
await bundle({
  entryPoints: ["server/desktop/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  outfile: resolve(output, "server.mjs"),
});
await bundle({
  entryPoints: ["server/mcp/bridge.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  outfile: resolve(output, "mcp.mjs"),
});
await cp("samples", resolve(output, "samples"), { recursive: true });
await buildNotices(resolve(output, "third-party"));
console.info("Desktop app built in .desktop/");
