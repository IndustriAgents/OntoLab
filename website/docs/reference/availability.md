---
title: "Feature availability"
description: "Distinguish hosted capabilities from optional and self-hosted features."
---

These guides describe OntoLab Desktop Preview 3 (`0.1.0-desktop.3`) and corresponding source behavior. Deployment settings determine which optional capabilities you can use. The app’s `/ontolab/api/config` endpoint reports enabled feature flags without exposing provider secrets.

| Capability | Local baseline | Optional configuration |
| --- | --- | --- |
| Project workspaces, workflows, manual editors, revisions | Single-user workspace | Local or Postgres stores |
| Induction, extraction and graph chat | Require an enabled server-side provider | Configure provider keys or local Ollama |
| PDF, DOCX, XLSX, XLS, HTML, Markdown, text parsing | Built in | Built in |
| OCR, PPTX and image parsing | Not enabled in the baseline rollout | Docling sidecar |
| Graph queries | Built-in SPARQL engine | Optional scoped RDF and native Neo4j connections; saved-version RDF publishing |
| Logical checks | In-process RL subset | Optional DL reasoner sidecar |
| Embeddings and entailment | Local models configured, with fallback if loading fails | Provider, local or lexical options |
| Background processing without an open browser | Depends on deployment configuration | Requires worker configuration and continuously allocated resources |
| Offline mock provider | Not enabled in production | Local development and automated tests |

## Check your installation

An administrator can change configuration after this release. If a guide references an absent provider or integration, inspect available options in the app and ask the installation operator. An absent integration does not become available by uploading another document.

Research inspection shows the actual backend when recorded. Configuring a local embedding model does not prove that it loaded successfully for a particular operation; a recorded lexical fallback must be interpreted as such.

See [local setup](../developers/local-setup.md) for the browser and desktop workspaces.
