---
title: "HTTP API reference"
description: "The local application HTTP interface and its access rules."
---

This is the application’s current HTTP interface, not a separately versioned public integration API or a promise of SDK compatibility. The implementation and TypeScript contracts remain the detailed reference for this release.

## Local access

The browser edition listens on `127.0.0.1` and serves one workspace without
sign-in. If a request has an `Origin` header, it must match the local
request origin. Local command-line clients can omit this header. The desktop
app uses its own loopback server and a per-launch session.

Leave `API_TOKEN` empty when using the browser UI. If you set it for
command-line use, send it as `x-api-token` on protected routes. Provider keys
are used by the server to call models.

## Check the local server

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/config
```

Health reports whether the server responds. Configuration exposes client-safe
limits and feature flags.

## Core routes

Paths are relative to the application mount prefix if you set `BASE_PATH`. `:pid`, `:rid` and `:did` identify projects, revisions and documents in the local workspace.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/projects` | List the user’s project summaries |
| POST | `/api/projects` | Create a project from JSON name/purpose/scope |
| POST | `/api/projects/sample` | Create the bundled sample project |
| GET | `/api/projects/:pid` | Read an accessible project |
| PATCH | `/api/projects/:pid` | Update supported project fields |
| GET / POST | `/api/projects/:pid/documents` | List documents / upload raw bytes |
| GET | `/api/projects/:pid/documents/:did/text` | Read parsed document text |
| GET | `/api/projects/:pid/revisions` | List revisions |
| POST | `/api/projects/:pid/revisions` | Create a draft from revision content |
| POST | `/api/projects/:pid/revisions/:rid/commit` | Validate and attempt a commit |
| GET | `/api/projects/:pid/archive` | Download a project archive |
| POST | `/api/projects/import` | Import archive bytes |

Document uploads use `application/octet-stream` with an encoded `x-file-name` header. They are not multipart form uploads. Consult `server/app.ts`, `src/lib/projectApi.ts` and `src/types/project.ts` in your checkout for full request/response contracts before writing a client.

## Evidence inspection

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/api/projects/:pid/evidence/inspect` | Read a stored fact, term, passage, document, or answer target with optional source selection and model-input projection |
| POST | `/api/projects/:pid/evidence/original` | Read a selected original after checksum verification |
| POST | `/api/projects/:pid/evidence/structure` | Read an original XML element selected from recorded structural locations |
| GET | `/api/projects/:pid/runs/:runId/documents/:did/evidence` | Read the retained document text associated with a run |

The POST routes read data through the same local request checks. Targets are defined in `src/types/evidence.ts`; browser-supplied quotations are locators, not authoritative support scores. Run, revision, document, and answer associations are validated before source access. Missing historical text is not replaced with current text. Existing corpus evidence reads remain compatible.

## Errors and concurrency

JSON errors include a message and, when available, a request ID. Keep the request ID when reporting failures. Responses include access failures, stale-parent conflicts and validation acknowledgement requirements; see [validation messages](../reference/validation-messages.md).

Never retry a mutation blindly after a network interruption: first inspect whether the project/run/revision was already created or committed. The API scopes data to the workspace and uses atomic leases for background work.
