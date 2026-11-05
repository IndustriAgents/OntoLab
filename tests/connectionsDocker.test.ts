import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGraphFixtures, fixtureConnections } from "../scripts/graph-connection-fixtures.ts";
import { startApp, type TestApp } from "./helpers.ts";
import type { GraphConnection, GraphPublication } from "../src/types/connections.ts";
import type { Project, Conversation } from "../src/types/project.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import type { ExternalResult } from "../src/lib/connectionsApi.ts";

describe.skipIf(!process.env.TEST_GRAPH_DBS)("real Docker graph databases", () => {
  let app: TestApp, parent: Project;
  beforeAll(async () => {
    process.env.GRAPH_CONNECTIONS_KEY = Buffer.alloc(32, 8).toString("base64");
    process.env.GRAPH_CONNECTIONS_ALLOW_PRIVATE = "1";
    await seedGraphFixtures();
    app = await startApp();
    const created = await app.as("docker-connector-owner").json<{ project: Project }>("POST", "/api/projects/sample");
    expect(created.status).toBe(201);
    parent = created.body.project;
  }, 120000);
  afterAll(async () => {
    await app?.close();
  });
  const client = () => app.as("docker-connector-owner");
  const fixtures = [...fixtureConnections, { ...fixtureConnections[0], name: "Docker · Generic SPARQL", provider: "sparql" as const }];
  for (const input of fixtures) {
    it(`${input.name}: connect, browse, query, Ask, reject writes, and disconnect`, async () => {
      const created = await client().json<{ connection: GraphConnection }>("POST", "/api/connections", input);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const c = created.body.connection;
      const test = await client().json("POST", `/api/connections/${c.id}/test`, {});
      expect(test.status, JSON.stringify(test.body)).toBe(200);
      expect(test.body.reachable).toBe(true);
      const neo = input.provider === "neo4j";
      const graph = neo ? undefined : "urn:ontolab:test:one";
      const connected = await client().json<{ project: Project }>("POST", `/api/projects/${parent.id}/connected-graphs`, {
        name: input.name,
        connectionId: c.id,
        graph,
      });
      expect(connected.status).toBe(200);
      const child = connected.body.project;
      const query = neo
        ? "MATCH (n:OntoLabConnectorFixture) RETURN n.name AS label ORDER BY label"
        : "SELECT ?label WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label } ORDER BY ?label";
      const results = await client().json<ExternalResult>("POST", `/api/projects/${child.id}/external/query`, { query });
      expect(results.status, JSON.stringify(results.body)).toBe(200);
      expect(results.body.result.rows.some((r) => r.label.value === "Alice")).toBe(true);
      expect(results.body.result.rows.some((r) => r.label.value === "Bob")).toBe(neo);
      if (!neo)
        expect(results.body.result.rows.find((r) => r.label.value === "Alice")!.label).toMatchObject({ type: "literal", lang: "en" });
      const preview = await client().json<ExternalResult>("POST", `/api/projects/${child.id}/external/query`, {
        query: neo ? "MATCH (s)-[r]->(o) RETURN s, type(r) AS relationship, o LIMIT 100" : "SELECT ?s ?p ?o WHERE {?s ?p ?o} LIMIT 100",
      });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.result.rows.length).toBeGreaterThan(0);
      if (neo) {
        const numeric = await client().json<ExternalResult>("POST", `/api/projects/${child.id}/external/query`, {
          query: "RETURN 9007199254740993 AS integerValue, true AS flag",
        });
        expect(numeric.status).toBe(200);
        expect(numeric.body.result.rows[0].integerValue).toMatchObject({
          value: "9007199254740993",
          datatype: "http://www.w3.org/2001/XMLSchema#integer",
        });
        expect(numeric.body.result.rows[0].flag.datatype).toBe("http://www.w3.org/2001/XMLSchema#boolean");
      }
      const forbidden = await client().json("POST", `/api/projects/${child.id}/external/query`, {
        query: neo ? "MATCH(n) DETACH DELETE n RETURN n" : "CLEAR ALL",
      });
      expect(forbidden.status).toBe(400);
      const sse = await fetch(`${app.url}/api/projects/${child.id}/assistant/chat`, {
        method: "POST",
        headers: { "x-test-user": "docker-connector-owner", "content-type": "application/json" },
        body: JSON.stringify({ question: "Who is in this graph?", source: "external", provider: "mock", model: "mock-1" }),
      });
      expect(sse.status).toBe(200);
      const events = (await sse.text())
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      const queryEvent = events.find((e): e is Extract<ChatEvent, { type: "sparql" }> => e.type === "sparql" && e.run.purpose === "agent");
      expect(queryEvent?.run.ok, JSON.stringify(queryEvent)).toBe(true);
      expect(queryEvent?.run.rows.length).toBeGreaterThan(0);
      const saved = events.at(-1) as Extract<ChatEvent, { type: "saved" }>;
      expect(saved.type).toBe("saved");
      const conv = await client().json<{ conversation: Conversation }>(
        "GET",
        `/api/projects/${child.id}/conversations/${saved.conversationId}`,
      );
      const answer = conv.body.conversation.messages.at(-1)!;
      expect(answer.content).toContain("[Q1]");
      expect(answer.agent?.context).toMatchObject({ connectionId: c.id, connectionVersion: 1, provider: input.provider });
      expect(answer.agent?.runs[0].context?.graph).toBe(graph);
      if (input.provider === "fuseki") {
        expect(
          (await client().json("PUT", `/api/projects/${child.id}/external`, { connectionId: c.id, graph: "urn:ontolab:test:two" })).status,
        ).toBe(200);
        const changed = await client().json<ExternalResult>("POST", `/api/projects/${child.id}/external/query`, { query });
        expect(changed.body.result.rows.some((r) => r.label.value === "Bob")).toBe(true);
        expect(changed.body.result.rows.some((r) => r.label.value === "Alice")).toBe(false);
        const followup = await client().json("POST", `/api/projects/${child.id}/assistant/chat`, {
          question: "What changed?",
          conversationId: saved.conversationId,
          source: "external",
          provider: "mock",
          model: "mock-1",
        });
        expect(followup.status).toBe(409);
        expect(answer.agent?.context?.graph).toBe("urn:ontolab:test:one");
      }

      expect((await client().json("DELETE", `/api/connections/${c.id}?version=1`)).status).toBe(200);
      expect((await client().json("POST", `/api/projects/${child.id}/external/query`, { query })).status).toBe(404);
    }, 30000);
  }
  for (const input of fixtures.filter((c) => c.provider !== "neo4j")) {
    it(`${input.name}: publishes immutable graphs, reads back RDF, preserves earlier versions after failure`, async () => {
      const created = await client().json<{ connection: GraphConnection }>("POST", "/api/connections", input),
        c = created.body.connection;
      const path = `/api/projects/${parent.id}/revisions/${parent.currentRevisionId}/publish`;
      const first = await client().json<{ publication: GraphPublication }>("POST", path, { connectionId: c.id, acknowledged: true });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.publication.status).toBe("published");
      const second = await client().json<{ publication: GraphPublication }>("POST", path, { connectionId: c.id, acknowledged: true });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.publication.graph).not.toBe(first.body.publication.graph);
      const bind = await client().json<{ project: Project }>("POST", `/api/projects/${parent.id}/connected-graphs`, {
        name: "Published version",
        connectionId: c.id,
        graph: first.body.publication.graph,
      });
      const read = () =>
        client().json<ExternalResult>("POST", `/api/projects/${bind.body.project.id}/external/query`, {
          query: "SELECT ?s ?p ?o WHERE {?s ?p ?o} LIMIT 10",
        });
      expect((await read()).body.result.rows.length).toBeGreaterThan(0);
      const rotated = await client().json<{ connection: GraphConnection }>("PUT", `/api/connections/${c.id}`, {
        ...c,
        publishEndpoint: new URL("/missing-publish-endpoint", c.queryEndpoint).toString(),
        auth: { type: "none" },
      });
      expect(rotated.status).toBe(200);
      expect((await client().json("POST", path, { connectionId: c.id, acknowledged: true })).status).toBe(502);
      expect((await read()).body.result.rows.length).toBeGreaterThan(0);
      const updated = await client().json<{ project: Project }>("GET", `/api/projects/${parent.id}`);
      expect(updated.body.project.settings.publications?.at(-1)?.status).toBe("failed");
      expect(updated.body.project.settings.publications?.find((p) => p.id === first.body.publication.id)?.status).toBe("published");
    }, 30000);
  }
});
