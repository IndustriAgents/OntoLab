---
title: "Optional integrations"
description: "Understand the configuration boundary for providers, Docling, GraphDB and reasoning."
---

Integrations are enabled by the installation operator. A provider or sidecar that is absent from your installation cannot be enabled by changing a document.

| Integration | Purpose | Operator configuration |
| --- | --- | --- |
| Claude, OpenAI, Gemini, DeepSeek | Induction, extraction and assistant model calls | Server-side provider credentials |
| Ollama | Models hosted on an accessible Ollama server | Base URL and allowed models |
| OpenAI-compatible endpoints | Any server that speaks the OpenAI chat-completions API, such as LiteLLM, vLLM, LM Studio or an institutional gateway | **Settings → AI providers → Add endpoint**, or `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY` and `OPENAI_COMPAT_MODELS` |
| Docling | Layout-aware parsing, OCR, additional formats | `PARSER_URL` and matching token |
| Graph databases | Read existing RDF/Neo4j graphs; publish saved RDF versions | Per-account encrypted connections; optional publishing endpoint |
| DL reasoner | Additional OWL consistency checks | Reasoner sidecar URL, tier and optional token |
| External vocabularies | Reuse and grounding candidates | Enabled sources and any required credentials |

## Graph databases

Add GraphDB, Fuseki, RDF4J, generic SPARQL or Neo4j in **Account & workspace → Graph connections**. Connect an existing graph from a project’s Knowledge graphs, without requiring a saved ontology. Connected workspaces are read-only. Publishing from Export writes a saved RDF version to a fresh named graph and preserves earlier publications. See [Graph connections](../guides/graph-connections.md) for endpoints, server secrets, supported queries and Docker verification.

Users supply query endpoints within the server’s network policy. Hosted installations need a connection encryption key; local installations can connect to loopback Docker services.

## Parsing and reasoning

Docling changes the parser capability; it does not fix every reading-order or OCR error. Inspect its output. The optional DL reasoner extends the in-process RL checks, but results still depend on supported ontology constructs and successful execution.

## Credentials

Keep keys and tokens on the server or in the hosting secret manager. Do not put them in uploaded documents, browser code or prompts. See [deployment](../developers/deployment.md) for operational configuration and [availability](./availability.md) for the hosted baseline.
