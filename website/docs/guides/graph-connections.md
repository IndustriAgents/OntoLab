---
title: Graph connections
description: Connect existing RDF and Neo4j graphs, query live data and publish saved RDF versions.
---

Use **Account & workspace → Graph connections** to add a database. Connections belong to your account. Credentials are encrypted on the server, omitted from API responses and never included in project archives.

## Connect an existing graph

1. Add a connection, select the database type and enter its query endpoint. Choose no authentication, username/password or a bearer token.
2. Save it and use **Test connection**. This performs a read-only query; it does not prove publishing permissions.
3. Open a project's **Knowledge graphs → Connect existing graph**. Choose the connection and, for RDF, an optional named graph IRI.

A connected graph needs no saved OntoLab ontology. **Explore** shows a bounded live sample. **Query** runs SPARQL or Cypher; **Ask** records the queries, returned rows, source connection version, scope and read time with each answer. External database results are sent to the model provider selected for Ask.

Connected workspaces are read-only. Documents and extraction remain in OntoLab-managed graph workspaces. Changing a source affects future queries; earlier answers retain their recorded source. Start a new conversation after changing the connection version or graph scope.

| Database | Query endpoint example | Optional publishing endpoint |
| --- | --- | --- |
| GraphDB | `https://host/repositories/research` | `https://host/repositories/research/statements` |
| RDF4J | `https://host/rdf4j-server/repositories/research` | `https://host/rdf4j-server/repositories/research/statements` |
| Fuseki | `https://host/research/query` | `https://host/research/data` |
| Generic SPARQL | Provider's SPARQL 1.1 endpoint | Provider's Graph Store HTTP endpoint |
| Neo4j 5.25+ | `https://host:7473/db/neo4j/query/v2` | Unavailable; native Cypher reads only |

Repository/dataset/database selection is part of the endpoint. Repository administration privileges and GraphDB MCP are not required. Neo4j uses the HTTP Query API; Bolt-only deployments need to enable an HTTPS Query API endpoint. RDF is not automatically translated into Neo4j's property graph model.

RDF queries allow parsed `SELECT` and `ASK`. The workspace controls the default graph dataset; `FROM`, `GRAPH` and federated `SERVICE` are refused. Neo4j supports a restricted read-only `MATCH`/`RETURN` surface with built-in functions; procedures, writes, extension functions and database switching are refused. Responses are limited to 200 rows and 2 MB; HTTP requests time out after 15 seconds. Configure a server-side transaction timeout on Neo4j too, since ending an HTTP request alone cannot guarantee immediate cancellation of database computation.

## Publish a saved RDF version

Enable a publishing endpoint in a connection. In an OntoLab workspace, open **Export → Publish a saved version**, choose the saved version and connection, then review the confirmation.

Each attempt writes to a fresh `urn:ontolab:publication:…` named graph. The ontology and facts permitted by the workspace's review policy are published together. The publication record stores its revision, payload hash, connection version, target graph, timestamp and outcome. **Open published graph** creates a read-only workspace for that target.

Earlier graphs are never cleared or overwritten. Failed or interrupted requests may leave a partial graph at the attempt's recorded IRI; it is not automatically removed. An interrupted publication can remain marked `publishing` if the server stopped before recording its outcome. Inspect the database before retrying; a retry creates another fresh graph. Publication is limited to 16 MB. There is no automatic two-way synchronization.

## Server setup

Apply Postgres migrations with `make db-migrate`.

Hosted servers must set `GRAPH_CONNECTIONS_KEY` to a base64-encoded 32-byte secret, for example generated with `openssl rand -base64 32`. Keep that key in your secret manager and retain it across deployments. Losing it requires restoring the key or re-entering credentials. Local/disabled-auth installations generate a mode-0600 key under `DATA_DIR`; back it up securely alongside your local installation, outside portable project archives.

Use HTTPS and a database account with the minimum permissions needed. Hosted connections reject private, loopback, link-local and reserved addresses. Local workspaces permit private database addresses; a trusted self-hosted installation can explicitly set `GRAPH_CONNECTIONS_ALLOW_PRIVATE=1`. Link-local cloud metadata addresses remain blocked. DNS addresses are checked and pinned for each request, redirects are refused and credentials never enter endpoint URLs. Also apply an infrastructure egress policy when hosting multiple users.

Editing a connection increments its version; rotating credentials requires the current version. Re-enter credentials when changing endpoints. **Disconnect** removes the saved credentials, while preserving remote data and local workspace history. Reconnect through the workspace's Graph settings. Portable archives exclude saved connections and do not copy external database contents; reconnect sources manually after import.

## Reproduce Docker verification

```sh
docker compose -f docker/connectors/compose.yml up -d --build
npm run test:graph-connections
```

The suite provisions disposable repositories, seeds separate RDF named graphs and a Neo4j fixture, then exercises the actual HTTP API. It covers GraphDB 10.8.11, Fuseki 5.6.0, RDF4J 5.2.2 and Neo4j 5.26, plus the generic SPARQL adapter against Fuseki. Ask uses the deterministic offline model in these tests; no model credentials or paid calls are needed. `make test-db` also checks connection persistence, concurrency and owner isolation in Postgres.

To register usable demo connections and workspaces in the local development app:

```sh
make up
npx tsx scripts/graph-connection-fixtures.ts --register-local
```

The Compose ports bind to loopback only. Its fixed Neo4j credentials and unauthenticated RDF endpoints are for disposable local tests. Stop and remove these fixtures with `docker compose -f docker/connectors/compose.yml down -v`; this affects only the `ontolab-connectors` project. GraphDB 11 requires a separately supplied license; these checks use 10.8 as a development fixture, and do not grant production, redistribution or SaaS rights. Check your database vendor's applicable terms before distribution.
