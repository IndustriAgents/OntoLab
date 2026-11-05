---
title: "Run OntoLab locally"
description: "Start an offline demonstration or a configured development installation."
---

Use Node.js 22 or newer. Application and documentation dependencies are separate so a documentation build does not install or start the backend.

## Offline application demo

From the repository root:

```bash
npm ci
npm --prefix website ci
STORE_MODE=local MOCK_LLM=1 DATA_DIR=.data-demo npm run dev
```

Open `http://localhost:5173`. On Projects, open the sample and select the **mock** provider/model when running extraction. The offline mock makes no provider calls for its results. It demonstrates control flow, not factual accuracy.

The application listens on loopback and opens a single-user workspace without sign-in. `STORE_MODE=local` keeps the demo independent of any configured database URL.

## Use a real provider

Copy `.env.example` to `.env` if you do not already have local configuration, then set the provider keys you need. Existing process variables win over `.env.local`, then `.env`. Choose a real enabled model deliberately; calls can incur charges.

The API uses `API_PORT`, then `PORT`, then port 3000. Vite normally serves port 5173 and proxies API requests. Set the API port explicitly if another tool injects `PORT`.

## Durable development storage

The server selects Postgres when `DATABASE_URL` is configured unless you explicitly select another store. Use the pooled URL for runtime and direct URL for migrations. Configure an isolated database/branch for development and follow the migration instructions in the repository’s `docs/NEON.md`.

## Documentation development

```bash
npm --prefix website ci
npm --prefix website start
```

The development docs URL is `http://localhost:3100/ontolab/`. To verify local search and the production layout:

```bash
npm --prefix website run build
npm --prefix website run preview
```

Open `http://localhost:8788/ontolab/`. The preview includes the public hub and product-prefix routing. Search indexes are generated during the production build.
