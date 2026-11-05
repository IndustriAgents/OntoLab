// Local database URLs are passed only to child processes. Deployment dotenv
// files retain their Neon settings, including when `make` runs migrations.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = `${root}.data/local-dev`;
const pidFile = `${stateDir}/server.pid`;
const logFile = `${stateDir}/server.log`;
const dbPort = process.env.ONTOLAB_DB_PORT || "55432";
if (!/^\d+$/.test(dbPort) || Number(dbPort) < 1 || Number(dbPort) > 65535) throw new Error("Invalid ONTOLAB_DB_PORT.");
if (process.env.NODE_ENV === "production") throw new Error("Local development commands cannot run with NODE_ENV=production.");

const databaseUrl = `postgresql://ontolab:ontolab@127.0.0.1:${dbPort}/ontolab`;
const env = {
  ...process.env,
  NODE_ENV: "development",
  STORE_MODE: "postgres",
  DATABASE_URL: databaseUrl,
  DATABASE_URL_UNPOOLED: databaseUrl,
  ONTOLAB_DB_PORT: dbPort,
  API_PORT: "3000",
  BASE_PATH: "",
  API_TOKEN: "",
};

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}).`);
}
const compose = (...args: string[]) => run("docker", ["compose", "-p", "ontolab-local", "-f", `${root}compose.local.yaml`, ...args]);

function savedPid(): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error(`Invalid process ID in ${pidFile}.`);
  return pid;
}
function running(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function stop() {
  const pid = savedPid();
  if (pid && running(pid)) {
    process.kill(-pid, "SIGTERM");
    for (let i = 0; i < 40 && running(pid); i++) await delay(250);
    if (running(pid)) process.kill(-pid, "SIGKILL");
    console.info("Local app stopped.");
  }
  rmSync(pidFile, { force: true });
}
async function requireFreePort(port: number, host: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") resolve();
      else reject(new Error(`Port ${port} is occupied. Stop the existing server before running make up.`, { cause: error }));
    });
    server.listen(port, host, () => server.close(() => resolve()));
  });
}
async function healthy(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
async function start() {
  const oldPid = savedPid();
  if (oldPid && running(oldPid)) {
    console.info("Local app is already running. Use make restart to restart it.");
    return;
  }
  for (const port of [3000, 5173]) for (const host of ["127.0.0.1", "::1"]) await requireFreePort(port, host);
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(logFile, "a", 0o600);
  let pid: number;
  try {
    const child = spawn("npm", ["run", "dev"], { cwd: root, env, detached: true, stdio: ["ignore", log, log] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    pid = child.pid!;
    child.unref();
    writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
  } finally {
    closeSync(log);
  }
  for (let i = 0; i < 240 && running(pid); i++) {
    if ((await healthy("http://localhost:5173/")) && (await healthy("http://127.0.0.1:3000/api/projects"))) {
      console.info(`Local app ready: http://localhost:5173 · Postgres: 127.0.0.1:${dbPort}`);
      console.info("Use make logs, make restart, or make down.");
      return;
    }
    await delay(500);
  }
  await stop();
  throw new Error(`Local app did not become ready. Check ${logFile}.`);
}

switch (process.argv[2]) {
  case "db-up":
    compose("up", "-d", "--wait");
    break;
  case "db-stop":
    compose("stop");
    break;
  case "db-migrate":
    run("npm", ["run", "db:migrate"]);
    break;
  case "db-shell":
    compose("exec", "postgres", "psql", "-U", "ontolab", "-d", "ontolab");
    break;
  case "test-db":
    run("npm", ["run", "test:postgres"]);
    break;
  case "dev":
    run("npm", ["run", "dev"]);
    break;
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    await start();
    break;
  case "status": {
    compose("ps");
    const web = await healthy("http://localhost:5173/");
    const api = await healthy("http://127.0.0.1:3000/api/projects");
    console.info(`App: ${web && api ? "ready" : "not ready"} · http://localhost:5173 · local Postgres port ${dbPort}`);
    if (!web || !api) process.exitCode = 1;
    break;
  }
  default:
    throw new Error("Unknown local command. Run make help.");
}
