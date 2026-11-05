---
title: "Build and configure OntoLab"
description: "Build the local application and documentation."
---

Run `npm ci` and `npm --prefix website ci`, then `npm run build` and
`npm start`. Open `http://127.0.0.1:3000`. The server and development proxy
listen on loopback and serve one local workspace.

The server and frontend use the same optional `BASE_PATH` prefix. For
Postgres storage, apply migrations with `npm run db:migrate` before starting.
See [local setup](./local-setup.md) for storage and provider configuration.

The documentation workflow runs the site checks and builds a preview artifact.
To build the docs by themselves, run `npm --prefix website run build`.
