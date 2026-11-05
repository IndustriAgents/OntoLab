// Disposable data only, in the isolated docker/connectors compose project.
const repo = "ontolab-connectors-test";
export const fixtureConnections = [
  {
    name: "Docker · Fuseki",
    provider: "fuseki" as const,
    queryEndpoint: "http://127.0.0.1:13030/ds/query",
    publishEndpoint: "http://127.0.0.1:13030/ds/data",
    auth: { type: "none" as const },
  },
  {
    name: "Docker · RDF4J",
    provider: "rdf4j" as const,
    queryEndpoint: `http://127.0.0.1:18080/rdf4j-server/repositories/${repo}`,
    publishEndpoint: `http://127.0.0.1:18080/rdf4j-server/repositories/${repo}/statements`,
    auth: { type: "none" as const },
  },
  {
    name: "Docker · GraphDB 10.8",
    provider: "graphdb" as const,
    queryEndpoint: `http://127.0.0.1:17200/repositories/${repo}`,
    publishEndpoint: `http://127.0.0.1:17200/repositories/${repo}/statements`,
    auth: { type: "none" as const },
  },
  {
    name: "Docker · Neo4j",
    provider: "neo4j" as const,
    queryEndpoint: "http://127.0.0.1:17474/db/neo4j/query/v2",
    auth: { type: "basic" as const, username: "neo4j", password: "ontolab-test-password" },
  },
];
async function wait(url: string) {
  for (let n = 0; n < 90; n++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      if (r.status < 500) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Database did not become ready: ${url}`);
}
async function checked(url: string, options: RequestInit) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
    text = await r.text();
  if (!r.ok) throw new Error(`Fixture setup HTTP ${r.status} at ${url}: ${text.slice(0, 1200)}`);
  return text;
}
async function exists(url: string) {
  try {
    return (await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "query=ASK%7B%7D" }))
      .ok;
  } catch {
    return false;
  }
}
export async function seedGraphFixtures() {
  await Promise.all([
    wait("http://127.0.0.1:13030/$/ping"),
    wait("http://127.0.0.1:18080/rdf4j-server/protocol"),
    wait("http://127.0.0.1:17200/rest/repositories"),
    wait("http://127.0.0.1:17474/"),
  ]);
  const prefixes = `@prefix rep: <http://www.openrdf.org/config/repository#> .\n@prefix sr: <http://www.openrdf.org/config/repository/sail#> .\n@prefix sail: <http://www.openrdf.org/config/sail#> .\n@prefix gdb: <http://www.ontotext.com/config/graphdb#> .\n`;
  const rdf = fixtureConnections[1];
  if (!(await exists(rdf.queryEndpoint)))
    await checked(rdf.queryEndpoint, {
      method: "PUT",
      headers: { "content-type": "text/turtle" },
      body: `${prefixes} [] a rep:Repository; rep:repositoryID "${repo}"; rep:repositoryImpl [rep:repositoryType "openrdf:SailRepository"; sr:sailImpl [sail:sailType "openrdf:MemoryStore"]].`,
    });
  const gdb = fixtureConnections[2];
  if (!(await exists(gdb.queryEndpoint))) {
    const form = new FormData();
    form.set(
      "config",
      new Blob(
        [
          `${prefixes} [] a rep:Repository; rep:repositoryID "${repo}"; rep:repositoryImpl [rep:repositoryType "graphdb:SailRepository"; sr:sailImpl [sail:sailType "graphdb:Sail"; gdb:ruleset "empty"; gdb:repository-type "file-repository"; gdb:enable-context-index "true"]].`,
        ],
        { type: "text/turtle" },
      ),
      "repository.ttl",
    );
    await checked("http://127.0.0.1:17200/rest/repositories", { method: "POST", body: form });
  }
  for (const c of fixtureConnections.filter((c) => c.provider !== "neo4j")) {
    for (const [graph, person] of [
      ["urn:ontolab:test:one", "Alice"],
      ["urn:ontolab:test:two", "Bob"],
    ]) {
      const u = new URL(c.publishEndpoint!),
        rdf4j = c.provider !== "fuseki";
      u.searchParams.set(rdf4j ? "context" : "graph", rdf4j ? `<${graph}>` : graph);
      const turtle = `@prefix ex: <urn:ontolab:test:> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . ex:${person} a ex:Person; rdfs:label "${person}"@en; ex:score 42; ex:knows ex:Colleague . ex:Colleague rdfs:label "Colleague" .`;
      await checked(u.toString(), { method: rdf4j ? "POST" : "PUT", headers: { "content-type": "text/turtle" }, body: turtle });
    }
    console.info(`Ready: ${c.name}`);
  }
  const neo = fixtureConnections[3];
  const out = JSON.parse(
    await checked(neo.queryEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("neo4j:ontolab-test-password").toString("base64")}`,
      },
      body: JSON.stringify({
        statement:
          "MERGE (a:OntoLabConnectorFixture {name:'Alice'}) MERGE (b:OntoLabConnectorFixture {name:'Bob'}) MERGE (a)-[:KNOWS]->(b) RETURN a.name AS name",
      }),
    }),
  );
  if (out.errors?.length) throw new Error(JSON.stringify(out.errors));
  console.info("Ready: Docker · Neo4j");
}
/** Opt-in demo registration against the local development server only. */
export async function registerLocalDemo() {
  const root = "http://localhost:3000";
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(root + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    return data as T;
  };
  const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
  const project =
    projects.find((p) => p.name === "Graph connections demo") ??
    (
      await api<{ project: { id: string; name: string } }>("/api/projects", {
        name: "Graph connections demo",
        purpose: "Disposable examples for the Docker graph connectors.",
      })
    ).project;
  const { connections } = await api<{ connections: { id: string; name: string; queryEndpoint: string }[] }>("/api/connections");
  const { corpora } = await api<{ corpora: { id: string; settings: { externalGraph?: { connectionId: string } } }[] }>(
    `/api/projects/${project.id}/corpora`,
  );
  for (const input of fixtureConnections) {
    const c =
      connections.find((c) => c.name === input.name && c.queryEndpoint === input.queryEndpoint) ??
      (await api<{ connection: { id: string } }>("/api/connections", input)).connection;
    if (input.provider === "fuseki" && process.argv.includes("--ui-demo")) continue;
    const graph =
      corpora.find((g) => g.settings.externalGraph?.connectionId === c.id) ??
      (
        await api<{ project: { id: string } }>(`/api/projects/${project.id}/connected-graphs`, {
          name: input.name,
          connectionId: c.id,
          graph: input.provider === "neo4j" ? undefined : "urn:ontolab:test:one",
        })
      ).project;
    console.info(`${input.name}: http://localhost:5173/p/${graph.id}/graph`);
  }
  console.info(`Demo project: http://localhost:5173/p/${project.id}/graphs`);
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await seedGraphFixtures();
  if (process.argv.includes("--register-local")) await registerLocalDemo();
}
