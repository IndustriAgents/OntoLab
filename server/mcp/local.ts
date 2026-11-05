import { serialized } from "../actions/state.ts";
/** Desktop-only access adapter. Credentials are distinct from the browser session. */
import type http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { LOCAL_USER } from "../auth.ts";
import type { Store } from "../store/types.ts";
import { consoleLogger } from "../services/context.ts";
import { actionDefinitions, executeAction, actionFailure, type ActionAccess } from "../actions/index.ts";
import type { ActionDefinition } from "../../src/types/actions.ts";
import { json, readJsonBody, HttpError } from "../http.ts";
import { MAX_UPLOAD_BYTES } from "../config.ts";
import { newId } from "../services/context.ts";
import { requireProject } from "../services/projects.ts";

interface Connection {
  id: string;
  name: string;
  tokenHash: string;
  projects?: string[];
  effects: ActionDefinition["effect"][];
  fileRoots: string[];
  createdAt: string;
  revoked?: boolean;
  lastSeen?: string;
}
import { createHash } from "node:crypto";
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function createLocalAgent(options: {
  profileDir: string;
  store: Store;
  launch?: { command: string; args: string[] };
  onOpen?: (destination: string) => void;
}) {
  const root = join(options.profileDir, "mcp");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runtimeFile = join(root, "runtime.json");
  const configFile = join(root, "connections.json");
  const connections: Connection[] = await readFile(configFile, "utf8")
    .then((s) => JSON.parse(s) as Connection[])
    .catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
  let workspaceId = await readFile(join(root, "workspace-id"), "utf8").catch(() => "");
  if (!workspaceId) {
    workspaceId = newId("workspace");
    await writeFile(join(root, "workspace-id"), workspaceId, { mode: 0o600 });
  }
  const instanceId = newId("instance");
  const persist = () =>
    serialized(configFile, async () => {
      const tmp = `${configFile}.tmp`;
      await writeFile(tmp, JSON.stringify(connections), { mode: 0o600 });
      await rename(tmp, configFile);
    });
  const ctx = () => ({
    store: options.store.forUser(LOCAL_USER),
    user: LOCAL_USER,
    now: () => new Date(),
    log: consoleLogger,
    requestId: newId("agent"),
  });
  const summary = (c: Connection) => ({
    id: c.id,
    name: c.name,
    projects: c.projects,
    effects: c.effects,
    fileRoots: c.fileRoots,
    createdAt: c.createdAt,
    lastSeen: c.lastSeen,
    revoked: !!c.revoked,
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, authenticatedUI: boolean) {
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (authenticatedUI) {
        if (req.method === "GET" && url.pathname === "/api/local-mcp") {
          json(res, {
            available: true,
            workspaceId,
            connections: connections.map(summary),
            projects: await options.store.forUser(LOCAL_USER).projects.list(),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/local-mcp/connections") {
          const body = await readJsonBody<{ name?: string; projects?: string[]; allowSave?: boolean; fileRoots?: string[] }>(req);
          if (!body.name?.trim() || body.name.length > 100) throw new HttpError(400, "Enter a connection name of 1–100 characters.");
          if (
            body.projects !== undefined &&
            (!Array.isArray(body.projects) || !body.projects.length || body.projects.some((p) => typeof p !== "string"))
          )
            throw new HttpError(400, "Choose at least one project, or all projects.");
          for (const pid of body.projects ?? []) await requireProject(ctx(), pid);
          if (
            body.fileRoots !== undefined &&
            (!Array.isArray(body.fileRoots) ||
              body.fileRoots.length > 20 ||
              body.fileRoots.some((p) => typeof p !== "string" || !isAbsolute(p)))
          )
            throw new HttpError(400, "File folders must be absolute paths.");
          const id = newId("connection"),
            token = randomBytes(32).toString("hex");
          const c: Connection = {
            id,
            name: body.name.trim(),
            tokenHash: sha(token),
            projects: body.projects,
            effects: ["read", "draft", "run", ...(body.allowSave === true ? ["save" as const] : [])],
            fileRoots: (body.fileRoots ?? []).map((p) => resolve(p)),
            createdAt: new Date().toISOString(),
          };
          const credentialFile = join(root, `${id}.json`);
          await writeFile(credentialFile, JSON.stringify({ token, id, workspaceId, runtimeFile, fileRoots: c.fileRoots }), { mode: 0o600 });
          connections.push(c);
          await persist();
          const launch = options.launch ?? {
            command: process.execPath,
            args: [resolve("node_modules/tsx/dist/cli.mjs"), resolve("server/mcp/bridge.ts")],
          };
          const args = [...launch.args, "--connection", credentialFile];
          const command = [launch.command, ...args].map(shellQuote).join(" ");
          json(
            res,
            {
              connection: summary(c),
              config: { command: launch.command, args },
              codex: `codex mcp add ontolab -- ${command}`,
              claude: `claude mcp add --transport stdio ontolab -- ${command}`,
            },
            201,
          );
          return;
        }
        const match = url.pathname.match(/^\/api\/local-mcp\/connections\/([A-Za-z0-9_-]{1,80})$/);
        if (req.method === "DELETE" && match) {
          const c = connections.find((c) => c.id === match[1]);
          if (!c) throw new HttpError(404, "Connection not found.");
          c.revoked = true;
          await persist();
          await rm(join(root, `${c.id}.json`), { force: true });
          json(res, { revoked: true });
          return;
        }
        throw new HttpError(404, "Local connection endpoint not found.");
      }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const supplied = Buffer.from(sha(token));
      const c = connections.find((c) => !c.revoked && timingSafeEqual(supplied, Buffer.from(c.tokenHash)));
      if (!c || !token) throw new HttpError(401, "This local connection is missing or revoked. Open OntoLab → Settings → AI connections.");
      c.lastSeen = new Date().toISOString();
      const access: ActionAccess = { caller: c.id, label: c.name, allowedProjects: c.projects, effects: c.effects };
      if (req.method === "GET" && url.pathname === "/api/local-agent/tools") {
        json(res, {
          workspaceId,
          actions: actionDefinitions(access),
          fileRoots: c.fileRoots,
          maxFileBytes: MAX_UPLOAD_BYTES,
          canOpen: !!options.onOpen,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/local-agent/action") {
        const body = await readJsonBody<{ name: string; input: unknown }>(req);
        json(res, await executeAction(ctx(), body.name, body.input, access));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/local-agent/open") {
        const body = await readJsonBody<{ projectId: string; revisionId?: string }>(req);
        // Read through the same authorization boundary before focusing an app destination.
        await executeAction(ctx(), "get_project_context", body, access);
        const p = await requireProject(ctx(), body.projectId);
        const destination = `/p/${p.id}/${p.settings.corpus ? "graph?tab=updates" : "ontology?tab=review"}${body.revisionId ? `&rev=${body.revisionId}` : ""}`;
        options.onOpen?.(destination);
        json(res, { opened: !!options.onOpen, destination });
        return;
      }
      throw new HttpError(404, "Local action endpoint not found.");
    } catch (error) {
      const failure = actionFailure(error);
      json(res, { error: failure.message, failure }, failure.status);
    }
  }
  return {
    handle,
    async ready(origin: string) {
      const temp = `${runtimeFile}.tmp`;
      await writeFile(temp, JSON.stringify({ origin, workspaceId, instanceId }), { mode: 0o600 });
      await rename(temp, runtimeFile);
    },
    async close() {
      await persist();
      const current = await readFile(runtimeFile, "utf8")
        .then((s) => JSON.parse(s) as { instanceId: string })
        .catch(() => null);
      if (current?.instanceId === instanceId) await rm(runtimeFile, { force: true });
    },
    async credentialFiles() {
      return (await readdir(root)).filter((f) => f.startsWith("connection_"));
    },
  };
}
