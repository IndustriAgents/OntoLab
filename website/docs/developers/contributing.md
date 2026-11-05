---
title: "Contribute to the documentation"
description: "Update product behavior and user guidance together in the OntoLab repository."
---

Documentation source lives in `website/docs/`. UI components, site configuration, public sample assets and the routing Worker also live in `website/`. The existing repository `docs/` folder retains internal architecture and operations notes.

## Write for a task

Use a tutorial for an end-to-end example, a how-to guide for a specific task, a concept page for explanation and a reference page for exact options. Keep navigation labels aligned with the application.

Every new article needs a title, description, useful headings, prerequisites where necessary and a clear expected result. Describe optional integrations and hosted availability accurately. Avoid publishing private documents, real customer data or credentials in screenshots and examples.

## Verify a change

```bash
npm --prefix website ci
npm --prefix website run check
npm --prefix website run build
npm --prefix website run preview
```

The build checks links and generates local search. Inspect at least the changed article, a deep link on reload, search and mobile navigation. Review code samples against the actual routes and types. If screenshots use mock mode, label them.

## Review and publish

Open a PR containing both the product change and related documentation. CI builds the site and retains an artifact for preview/review. A merge to `main` publishes relevant docs changes using the repository’s scoped deployment secret.

Change a page’s URL only with a redirect plan. Add pages to the appropriate sidebar. When an important behavior changes, update release notes, reference values and affected tutorials together.

## What belongs elsewhere

Keep operational credentials and local release snapshots out of the public site. Product source remains the detailed implementation reference. Research results should include their dataset, options, model and limitations rather than converting a smoke-test result into an accuracy claim.
