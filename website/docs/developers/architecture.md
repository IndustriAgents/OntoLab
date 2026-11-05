---
title: "Architecture"
description: "Understand the application and documentation deployment boundaries."
---

OntoLab is a React/Vite application with a Node HTTP backend. A production container serves the built SPA and API under a common mount prefix.

## Application layers

- **UI:** project workflows, specialist editors, evidence inspection and revision selection.
- **HTTP:** loopback server with Host and Origin checks. Desktop adds a per-launch session.
- **Services:** documents, requirements, induction, extraction, review, revisions, graph chat and validation.
- **Store:** local filesystem and Postgres adapters.
- **Optional sidecars:** Docling parsing and DL reasoning.

The backend holds provider credentials. Browser code uses session-bound requests rather than receiving those credentials. Graph chat uses the built-in SPARQL engine or a configured GraphDB backend.

## Persistence

The Postgres adapter keeps lossless project records, revision content, leases and uploaded bytes in a dedicated schema. Each owner operation uses a transaction-local identity and a non-owner role with row-level security. Immutable commits and leases use atomic database operations.

Background run advancement is optional. With the worker disabled, the browser drives bounded steps; checkpoints persist completed work.

## Documentation

`website/` contains a separate Docusaurus package. Its build produces HTML, browser assets and a local Pagefind index. The app bundles these at `/docs/`, including any configured application base path; desktop releases include the same files behind the existing private session. Documentation requests do not call model providers or query the project database. A separate public build uses a small Cloudflare Worker to serve `/ontolab/`.

Application code and docs are reviewed in the same repository. Their deployments are independent. Other products can publish their own documentation under more specific paths on the shared documentation hostname, using their own repositories and deployments.

See [deployment](./deployment.md) and [contributing](./contributing.md) for operational boundaries.
