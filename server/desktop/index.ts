// Configure the desktop process before importing any application configuration.
import { config } from "dotenv";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const dataDir = process.env.ONTOLAB_DESKTOP_DATA_DIR;
const resources = process.env.ONTOLAB_DESKTOP_RESOURCES;
const secret = process.env.ONTOLAB_DESKTOP_SECRET;
delete process.env.ONTOLAB_DESKTOP_SECRET; // CLI subprocesses never inherit the session secret.
if (!dataDir || !isAbsolute(dataDir) || !resources || !isAbsolute(resources) || !secret || secret.length < 32 || !process.parentPort) {
  throw new Error("The desktop backend must be started by the OntoLab desktop app.");
}
config({ path: join(dirname(dataDir), "desktop.env") });
Object.assign(process.env, {
  DATA_DIR: dataDir,
  MODEL_CACHE_DIR: process.env.MODEL_CACHE_DIR || join(dataDir, "models"),
  STORE_MODE: "local",
  BASE_PATH: "",
  API_TOKEN: "",
  WORKER: "1",
  SAMPLES_DIR: join(resources, "samples"),
  LOCAL_CLI_ENABLED: process.env.LOCAL_CLI_ENABLED ?? "1",
  // Finder and Start Menu launches may have a shorter PATH than a terminal.
  PATH: [
    ...new Set([
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
      join(homedir(), ".local", "bin"),
      join(homedir(), ".npm-global", "bin"),
      join(homedir(), ".bun", "bin"),
      ...(process.platform === "win32"
        ? [join(process.env.APPDATA || homedir(), "npm")]
        : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
    ]),
  ].join(delimiter),
});

const { startDesktopServer } = await import("./server.ts");
const server = await startDesktopServer({
  dataDir,
  distDir: join(resources, "dist"),
  secret,
  agentLaunch: {
    command: process.env.ONTOLAB_DESKTOP_EXECUTABLE ?? process.execPath,
    args: [...(process.env.ONTOLAB_DESKTOP_APP_PATH ? [process.env.ONTOLAB_DESKTOP_APP_PATH] : []), "--mcp-stdio"],
  },
  onOpen: (destination: string) => process.parentPort!.postMessage({ type: "open", destination }),
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 9000);
  await server.close();
  clearTimeout(timer);
  process.exit(0);
}
process.parentPort.on("message", (event: { data?: { type?: string } }) => {
  if (event.data?.type === "shutdown") void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
process.parentPort.postMessage({ type: "ready", port: server.port });
