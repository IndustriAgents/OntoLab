import type { Router } from "../router.ts";
import type { RouteCtx } from "../app.ts";
import {
  connectionDto,
  saveConnection,
  deleteConnection,
  testConnection,
  createConnectedGraph,
  externalQuery,
  externalSettings,
  publishVersion,
} from "./service.ts";
export function registerConnectionRoutes(r: Router<RouteCtx>) {
  r.get("/api/connections", async ({ svc }) => ({
    connections: (await svc.store.connections.list()).map(connectionDto).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  r.post("/api/connections", async ({ svc, json }) => ({ connection: await saveConnection(svc, await json()) }));
  r.put("/api/connections/:cid", async ({ svc, params, json }) => ({ connection: await saveConnection(svc, await json(), params.cid) }));
  r.delete("/api/connections/:cid", async ({ svc, params, query }) => deleteConnection(svc, params.cid, Number(query.get("version"))));
  r.post("/api/connections/:cid/test", async ({ svc, params, signal }) => testConnection(svc, params.cid, signal));
  r.post("/api/projects/:pid/connected-graphs", async ({ svc, params, json }) => ({
    project: await createConnectedGraph(svc, params.pid, await json()),
  }));
  r.post("/api/projects/:pid/external/query", async ({ svc, params, json, signal }) => {
    const b = await json<{ query: string }>();
    return externalQuery(svc, params.pid, b.query, signal);
  });
  r.put("/api/projects/:pid/external", async ({ svc, params, json }) => ({
    project: await externalSettings(svc, params.pid, await json()),
  }));
  r.post("/api/projects/:pid/revisions/:rid/publish", async ({ svc, params, json, signal }) =>
    publishVersion(svc, params.pid, params.rid, await json(), signal),
  );
}
