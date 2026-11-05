import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";
import { readCypher, readSparql } from "../server/connections/query.ts";
import { allowedAddress, endpoint, remoteRequest } from "../server/connections/http.ts";
import type { GraphConnection } from "../src/types/connections.ts";
import type { Project } from "../src/types/project.ts";
import type { ExternalResult } from "../src/lib/connectionsApi.ts";
import { localConnectionInstall } from "../server/connections/policy.ts";
import { DATA_DIR } from "../server/config.ts";

let app: TestApp, server: http.Server, url: string;
const requests: { url: string; body: string; auth?: string }[] = [];
let publicationEntered: (() => void) | undefined;
let publicationRelease: (() => void) | undefined;
beforeAll(async () => {
  process.env.GRAPH_CONNECTIONS_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GRAPH_CONNECTIONS_ALLOW_PRIVATE = "1";
  app = await startApp();
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url!, body, auth: req.headers.authorization });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/secret" });
      res.end();
      return;
    }
    if (req.url === "/big") {
      res.end("x".repeat(2_000_001));
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => res.end("{}"), 100);
      return;
    }
    if (req.url === "/auth" && req.headers.authorization !== `Basic ${Buffer.from("user:secret-password").toString("base64")}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url?.startsWith("/publish-hold")) {
      publicationEntered?.();
      await new Promise<void>((resolve) => {
        publicationRelease = resolve;
      });
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith("/publish")) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/sparql-results+json");
    const params = new URLSearchParams(body);
    if (params.get("query")?.startsWith("ASK")) res.end(JSON.stringify({ boolean: true }));
    else
      res.end(
        JSON.stringify({
          head: { vars: ["s", "label", "value"] },
          results: {
            bindings: [
              {
                s: { type: "uri", value: params.get("default-graph-uri") ?? "urn:default" },
                label: { type: "literal", value: "Bonjour", "xml:lang": "fr" },
                value: { type: "literal", value: "42", datatype: "http://www.w3.org/2001/XMLSchema#integer" },
              },
            ],
          },
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await app.close();
});
const alice = () => app.as("connection-alice"),
  bob = () => app.as("connection-bob");
async function createConnection(path = "/query") {
  const r = await alice().json<{ connection: GraphConnection }>("POST", "/api/connections", {
    name: "My RDF store",
    provider: "sparql",
    queryEndpoint: url + path,
    auth: { type: "basic", username: "user", password: "secret-password" },
  });
  expect(r.status).toBe(200);
  return r.body.connection;
}
async function connected(c: GraphConnection, graph = "urn:only-this") {
  const parent = await alice().json<{ project: Project }>("POST", "/api/projects", { name: "Connections test" });
  const child = await alice().json<{ project: Project }>("POST", `/api/projects/${parent.body.project.id}/connected-graphs`, {
    name: "Live graph",
    connectionId: c.id,
    graph,
  });
  expect(child.status).toBe(200);
  return { parent: parent.body.project, child: child.body.project };
}
describe("graph connection boundary", () => {
  it("encrypts credentials and isolates connection operations by owner", async () => {
    const c = await createConnection("/auth");
    expect(JSON.stringify(c)).not.toContain("secret-password");
    expect(c).not.toHaveProperty("encryptedAuth");
    const raw = await readFile(`${app.dataDir}/u/connection-alice/connections/${c.id}.json`, "utf8");
    expect(raw).not.toContain("secret-password");
    expect(JSON.parse(raw).encryptedAuth).toBeTruthy();
    expect((await bob().json<{ connections: GraphConnection[] }>("GET", "/api/connections")).body.connections).toEqual([]);
    expect((await bob().json("POST", `/api/connections/${c.id}/test`, {})).status).toBe(404);
    expect((await bob().json("PUT", `/api/connections/${c.id}`, { ...c, auth: { type: "none" } })).status).toBe(404);
    expect((await bob().json("DELETE", `/api/connections/${c.id}?version=1`)).status).toBe(404);
    expect((await alice().json("POST", `/api/connections/${c.id}/test`, {})).body).toMatchObject({
      reachable: true,
      publishingVerified: false,
    });
  });
  it("connects without an ontology, fixes graph scope, preserves RDF term types, and denies foreign workspaces", async () => {
    const c = await createConnection(),
      { parent, child } = await connected(c);
    expect(child.currentRevisionId).toBeNull();
    const r = await alice().json<ExternalResult>("POST", `/api/projects/${child.id}/external/query`, {
      query: "SELECT ?s ?label ?value WHERE { ?s ?label ?value }",
    });
    expect(r.status).toBe(200);
    expect(r.body.result.rows[0]).toMatchObject({
      s: { type: "uri", value: "urn:only-this" },
      label: { lang: "fr" },
      value: { datatype: "http://www.w3.org/2001/XMLSchema#integer" },
    });
    expect(r.body.context).toMatchObject({ connectionId: c.id, connectionVersion: 1, graph: "urn:only-this" });
    const last = requests.at(-1)!;
    expect(new URLSearchParams(last.body).get("query")).toMatch(/LIMIT 200/);
    expect((await bob().json("POST", `/api/projects/${child.id}/external/query`, { query: "ASK {}" })).status).toBe(404);
    const list = await alice().json<{ corpora: Project[] }>("GET", `/api/projects/${parent.id}/corpora`);
    expect(list.body.corpora.map((p) => p.id)).toContain(child.id);
    const roots = await alice().json<{ projects: Project[] }>("GET", "/api/projects");
    expect(roots.body.projects.map((p) => p.id)).not.toContain(child.id);
  });
  it("refuses unsafe queries before contacting a database", async () => {
    const { child } = await connected(await createConnection());
    for (const query of [
      "INSERT DATA {<urn:a> <urn:p> <urn:b>}",
      "SELECT * WHERE { SERVICE <http://example.org> {?s ?p ?o} }",
      "SELECT * FROM <urn:other> WHERE {?s ?p ?o}",
      "SELECT * WHERE {GRAPH ?g {?s ?p ?o}}",
      "SELECT * WHERE { {SELECT * FROM <urn:other> WHERE {?s ?p ?o}} }",
      "definitely not sparql",
    ]) {
      const before = requests.length;
      expect((await alice().json("POST", `/api/projects/${child.id}/external/query`, { query })).status).toBe(400);
      expect(requests.length).toBe(before);
    }
  });
  it("rotates credentials using optimistic concurrency, and disconnects without deleting the workspace", async () => {
    const c = await createConnection("/auth"),
      { child } = await connected(c);
    const updated = await alice().json<{ connection: GraphConnection }>("PUT", `/api/connections/${c.id}`, {
      ...c,
      auth: { type: "basic", username: "user", password: "wrong-password" },
    });
    expect(updated.body.connection.version).toBe(2);
    expect((await alice().json("POST", `/api/connections/${c.id}/test`, {})).status).toBe(422);
    expect((await alice().json("PUT", `/api/connections/${c.id}`, { ...c, name: "stale" })).status).toBe(409);
    expect((await alice().json("DELETE", `/api/connections/${c.id}?version=1`)).status).toBe(409);
    expect((await alice().json("DELETE", `/api/connections/${c.id}?version=2`)).status).toBe(200);
    expect((await alice().json("GET", `/api/projects/${child.id}`)).status).toBe(200);
    expect((await alice().json("POST", `/api/projects/${child.id}/external/query`, { query: "ASK {}" })).status).toBe(404);
  });
  it("refuses redirects, caps response bytes, times out, and blocks metadata IPs", async () => {
    const opts = { body: "", contentType: "application/json" };
    await expect(
      remoteRequest(
        new URL(url.replace("127.0.0.1", "localhost") + "/query"),
        { type: "none" },
        { body: "query=ASK%7B%7D", contentType: "application/x-www-form-urlencoded" },
      ),
    ).resolves.toContain('"boolean":true');
    await expect(remoteRequest(new URL(url + "/redirect"), { type: "none" }, opts)).rejects.toThrow("redirects");
    await expect(remoteRequest(new URL(url + "/big"), { type: "none" }, opts)).rejects.toThrow("2 MB");
    await expect(remoteRequest(new URL(url + "/slow"), { type: "none" }, { ...opts, timeoutMs: 20 })).rejects.toThrow("timed out");
    expect(allowedAddress("169.254.169.254", true)).toBe(false);
    for (const ip of ["127.0.0.1", "10.0.0.1", "::1", "::ffff:7f00:1", "fd00::1"]) expect(allowedAddress(ip, false)).toBe(false);
    expect(allowedAddress("8.8.8.8", false)).toBe(true);
    for (const input of ["file:///etc/passwd", "https://user:secret@example.org/query", "https://example.org/query?key=secret"])
      expect(() => endpoint(input)).toThrow();
  });
  it("keeps publication history when project settings are saved during an upload, and refuses drafts", async () => {
    const created = await alice().json<{ project: Project }>("POST", "/api/projects/sample");
    const p = created.body.project;
    const connection = await alice().json<{ connection: GraphConnection }>("POST", "/api/connections", {
      name: "Publishing fixture",
      provider: "sparql",
      queryEndpoint: url + "/query",
      publishEndpoint: url + "/publish-hold",
      auth: { type: "none" },
    });
    const body = { connectionId: connection.body.connection.id, acknowledged: true };
    const entered = new Promise<void>((resolve) => {
      publicationEntered = resolve;
    });
    const uploading = alice().json("POST", `/api/projects/${p.id}/revisions/${p.currentRevisionId}/publish`, body);
    await entered;
    const updated = await alice().json("PATCH", `/api/projects/${p.id}`, { settings: { ...p.settings, budget: { maxUsdPerRun: 15 } } });
    expect(updated.status).toBe(200);
    publicationRelease!();
    expect((await uploading).status).toBe(200);
    const saved = await alice().json<{ project: Project }>("GET", `/api/projects/${p.id}`);
    expect(saved.body.project.settings.budget?.maxUsdPerRun).toBe(15);
    expect(saved.body.project.settings.publications?.at(-1)?.status).toBe("published");
    const draft = await alice().json<{ revision: { id: string } }>("POST", `/api/projects/${p.id}/revisions`, {
      content: { modules: [], abox: null, baseIri: "urn:test:" },
    });
    const before = requests.length;
    expect((await alice().json("POST", `/api/projects/${p.id}/revisions/${draft.body.revision.id}/publish`, body)).status).toBe(409);
    expect(requests.length).toBe(before);
  });
});
describe("read-only query parsers", () => {
  it("recognizes the desktop workspace independently of server authentication mode", () => {
    const old = process.env.ONTOLAB_DESKTOP_DATA_DIR;
    try {
      process.env.ONTOLAB_DESKTOP_DATA_DIR = DATA_DIR;
      expect(localConnectionInstall()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.ONTOLAB_DESKTOP_DATA_DIR;
      else process.env.ONTOLAB_DESKTOP_DATA_DIR = old;
    }
  });
  it("allows literal words while rejecting query-language escape routes", () => {
    expect(readCypher("MATCH (n) WHERE n.name = 'CREATE; DELETE' RETURN n LIMIT 2")).toContain("LIMIT 200");
    for (const q of [
      "CREATE (n) RETURN n",
      "MATCH (n) DETACH DELETE n RETURN n",
      "CALL db.labels() YIELD label RETURN label",
      "RETURN apoc.cypher.runFirstColumn('CREATE (n)', {})",
      "RETURN 1; CREATE (n)",
      "USE other MATCH(n) RETURN n",
      "MATCH(n) SET n.x=1 RETURN n",
      "RETURN 1 /*",
    ])
      expect(() => readCypher(q)).toThrow();
    expect(readSparql('SELECT ?s WHERE { ?s ?p "DELETE FROM" } LIMIT 2')).toContain("LIMIT 2");
  });
});
