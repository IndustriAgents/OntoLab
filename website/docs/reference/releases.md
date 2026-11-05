---
title: "Release notes"
description: "OntoLab release notes and compatibility information."
---

## November 2026 — Desktop Preview 3

Version `0.1.0-desktop.3` adds scoped connections to GraphDB, Fuseki, RDF4J, generic SPARQL and Neo4j databases. Browse connected graphs and ask read-only questions, or publish a saved RDF version into a fresh named graph. Connection credentials are encrypted and scoped to their owner.

Project settings now live in Overview. Requirements have a compact summary, a dedicated editor in Build & sources, version history and recorded build inputs. The ontology picker selects a saved version or draft. Run details show the current result state and the appropriate next action, with server-side pause/resume and spending-limit recovery.

Graph, Ask and SPARQL have clearer workspaces: optional review panels and class filters, searchable conversation history, evidence on demand, query examples, paged results and CSV downloads. Documentation is bundled at `/docs/`, including local search, sample downloads and a return link to the workspace; desktop help works without internet access.

The desktop preview remains for Apple silicon Macs, ad-hoc signed and not notarized. Postgres installations use `migrations/0003_graph_connections.sql`. Retain your local data directory or configured `GRAPH_CONNECTIONS_KEY` to keep saved connections readable.

## November 2026 — Desktop Preview 2

Version `0.1.0-desktop.2` adds separate Ontology and Knowledge graphs navigation, remembered sidebar sections, focused project settings, and project-wide Activity. Ontology alignment includes persistent background runs, pause/resume, mapping review and undo, with links to each run’s source or result draft.

New configurations use an editable 100,000-token context budget. Saved custom limits are preserved. The default storage quota is 10 GiB per user, with up to 1,000 sources per knowledge graph; actual local disk space and explicit server overrides still apply. Document lists support search, pagination and compact action menus.

The desktop download remains an Apple silicon macOS preview, ad-hoc signed and not notarized.

## October 2026

This documentation covers the project-workspace release with the three guided workflows, manual T-Box/A-Box editing, evidence review, research inspection and workflow transparency.

Included capabilities:

- Durable project storage and immutable committed revisions.
- Requirements and competency questions, ontology induction and templates.
- Checkpointed extraction with evidence, entity resolution and review.
- Alignment proposals and reviewed ontology bridges.
- Graph chat with query and document citations.
- Structural, SHACL, logical and competency-query validation.
- Project archives and separate research-record export.

Docling, GraphDB and the DL reasoner are optional integrations; the baseline rollout uses built-in parsing, SPARQL and RL reasoning. See [availability](./availability.md).

## Reading older run records

Newer run records contain more preprocessing snapshots and measurements than older ones. Missing historical fields are not reconstructed as if they had been measured. A current method explanation describes current implementation and is not proof of the implementation used for an older run.

## Documentation changes

Documentation lives in `website/` in the OntoLab repository. Product behavior and its documentation should be reviewed in the same change. Screenshots from local mock-mode examples are labelled; they demonstrate the interface, not production extraction accuracy.
