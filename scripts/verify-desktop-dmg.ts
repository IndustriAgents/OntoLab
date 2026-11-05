// Verify the artifact users download, then test a copy installed from that image.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "darwin") throw new Error("DMG verification requires macOS.");
if (!process.argv[2]) throw new Error("Usage: npm run desktop:verify:dmg -- path/to/OntoLab.dmg");
const dmg = resolve(process.argv[2]);
const run = promisify(execFile);
const temporaryRoot = await mkdtemp(join(tmpdir(), "ontolab-dmg-install-"));
let mountPoint: string | undefined;
try {
  await run("hdiutil", ["verify", dmg]);
  const { stdout: plist } = await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmg]);
  const mounted = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist, encoding: "utf8" })) as {
    "system-entities": { "mount-point"?: string }[];
  };
  mountPoint = mounted["system-entities"].find((entity) => entity["mount-point"])?.["mount-point"];
  assert.ok(mountPoint, "The DMG must mount a filesystem.");
  const applications = join(mountPoint, "Applications");
  assert.equal((await lstat(applications)).isSymbolicLink(), true);
  assert.equal(await readlink(applications), "/Applications");
  const installedApp = join(temporaryRoot, "OntoLab.app");
  await run("ditto", [join(mountPoint, "OntoLab.app"), installedApp]);
  await run("codesign", ["--verify", "--deep", "--strict", installedApp]);
  const { stdout } = await run(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/desktop-smoke.ts")], {
    env: { ...process.env, ONTOLAB_DESKTOP_EXECUTABLE: join(installedApp, "Contents", "MacOS", "OntoLab") },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  console.info(stdout.trim());
  console.info(`DMG verified: image integrity, Applications shortcut, installed signature and native app smoke test. ${dmg}`);
} finally {
  if (mountPoint) await run("hdiutil", ["detach", mountPoint]);
  await rm(temporaryRoot, { recursive: true, force: true });
}
