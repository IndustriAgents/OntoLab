// Native end-to-end check: use a disposable profile and the offline model only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication } from "playwright";

const temporaryRoot = await mkdtemp(join(tmpdir(), "ontolab-desktop-smoke-"));
const profile = join(temporaryRoot, "new-profile");
const artifactDir = resolve("output", "desktop-smoke");
const executablePath = process.env.ONTOLAB_DESKTOP_EXECUTABLE;
const options = {
  ...(executablePath ? { executablePath } : {}),
  args: executablePath ? [] : [process.cwd()],
  env: { ...process.env, ONTOLAB_DESKTOP_PROFILE: profile, MOCK_LLM: "1", EMBEDDINGS_BACKEND: "hash", NLI_BACKEND: "lexical" },
};
let desktop: ElectronApplication | undefined;
const errors: string[] = [];

async function launch() {
  desktop = await _electron.launch(options);
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  return page;
}

try {
  await mkdir(artifactDir, { recursive: true });
  let page = await launch();
  const oldOrigin = new URL(page.url()).origin;
  assert.equal((await fetch(`${oldOrigin}/api/projects`)).status, 401);
  const preferences = await desktop!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & {
      getLastWebPreferences(): Electron.WebPreferences;
    };
    const value = contents.getLastWebPreferences();
    return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const probePath = join(temporaryRoot, "native-probe.cjs");
  await writeFile(
    probePath,
    [
      "const root = process.env.ONTOLAB_PROBE_ROOT;",
      "const ort = require(root + '/node_modules/onnxruntime-node');",
      "const ox = require(root + '/node_modules/oxigraph');",
      "process.parentPort.postMessage({ onnxLoaded: typeof ort.InferenceSession === 'function', graphSize: new ox.Store().size });",
      "process.exit(0);",
    ].join("\n"),
  );
  const native = await desktop!.evaluate(
    ({ utilityProcess, app }, probe) =>
      new Promise((resolve, reject) => {
        const child = utilityProcess.fork(probe, [], { env: { ...process.env, ONTOLAB_PROBE_ROOT: app.getAppPath() }, stdio: "pipe" });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Native dependency probe timed out."));
        }, 15_000);
        let error = "";
        child.stderr?.on("data", (value: Buffer) => {
          error = (error + value.toString()).slice(-8192);
        });
        child.once("message", (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.once("exit", (code) => {
          if (code !== 0) {
            clearTimeout(timer);
            reject(new Error(`Native dependency probe failed (${code}): ${error}`));
          }
        });
      }),
    probePath,
  );
  assert.deepEqual(native, { onnxLoaded: true, graphSize: 0 });
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Desktop smoke project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("heading", { name: "Build an ontology", exact: true }).waitFor();
  await desktop!.close();
  desktop = undefined;
  await assert.rejects(fetch(`${oldOrigin}/api/health`, { signal: AbortSignal.timeout(2000) }));

  page = await launch();
  await page.getByRole("link", { name: "Desktop smoke project", exact: true }).click();
  await page.getByRole("button", { name: "Account menu for This computer", exact: true }).click();
  await page.getByRole("link", { name: "Account & workspace settings", exact: true }).click();
  await page.getByRole("link", { name: "AI providers", exact: true }).click();
  await page.getByRole("heading", { name: "Local CLIs", exact: true }).waitFor();
  assert.ok(
    (await page.getByLabel("Provider", { exact: true }).locator("option").allTextContents()).some((value) => value.includes("Codex")),
  );
  await page.getByRole("heading", { name: "Local CLIs", exact: true }).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 650);
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll("h3")].find((value) => value.textContent === "Local CLIs");
    return heading && heading.getBoundingClientRect().top < innerHeight / 2;
  });
  await page.screenshot({ path: join(artifactDir, "providers-native.png") });
  const screenshot = await desktop!.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const [width, height] = win.getContentSize();
    return (await win.capturePage()).resize({ width, height }).toPNG();
  });
  await writeFile(join(artifactDir, "providers.png"), screenshot);
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.info(
    `Desktop smoke passed: sandbox, ONNX and graph runtimes, local project persistence, CLI picker, minimum window width and backend shutdown. Screenshot: ${artifactDir}`,
  );
} finally {
  await desktop?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
