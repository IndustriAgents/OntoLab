# OntoLab

[![CI](https://github.com/IndustriAgents/OntoLab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/IndustriAgents/OntoLab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Turn documents into a knowledge graph you can review, query, and export.**

OntoLab is an open-source workspace for building ontologies and extracting facts from documents. Start with your own ontology, a template, or a draft generated from your sources. Review each proposed fact alongside its source passage, then save a version of the graph.

[Quick start](#quick-start) · [Sample walkthrough](website/docs/start/quickstart.md) · [Documentation](#documentation) · [Contributing](#contributing)

![OntoLab sample workspace with workflows for building an ontology, extracting knowledge, and aligning standards](website/static/img/sample-workspace.png)

## Quick start

Install **Node.js 22.22 or newer**. The demo uses local files and an offline mock model.

```bash
git clone https://github.com/IndustriAgents/OntoLab.git
cd OntoLab
npm ci
npm --prefix website ci
STORE_MODE=local MOCK_LLM=1 DATA_DIR=.data-demo npm run dev
```

Open [localhost:5173](http://localhost:5173) and choose **Open the sample project**. The sample includes a synthetic technical manual and a saved ontology. Follow the [sample walkthrough](website/docs/start/quickstart.md) to extract facts with the mock model, review their evidence, and export Turtle. The mock demonstrates the workflow and produces simulated results.

For real extraction, configure a model provider in `.env` using [the environment template](.env.example). The browser app runs locally as a single-user workspace. Desktop and Postgres setup are covered in the documentation below.

## What you can do

- **Build or import an ontology.** Define what your graph should answer, generate an ontology from documents, or import Turtle, RDF/XML, or JSON-LD. Align external standards with your own terms.
- **Extract facts and review the evidence.** Ingest PDF, Word, Excel, HTML, XML, Markdown, and text. Inspect source passages, resolve duplicate entities, and accept or reject proposed facts.
- **Validate and version your graph.** Run schema, SHACL, and competency-question checks. Save reviewed graphs as numbered versions and compare changes across source updates.
- **Ask questions and export.** Explore saved graphs, inspect cited sources and SPARQL results, and export RDF as Turtle. Use a project archive to move a workspace.

## Documentation

| I want to… | Start here |
| --- | --- |
| Start with my own documents | [Create your first project](website/docs/start/first-project.md) |
| Configure models or storage | [Local setup](website/docs/developers/local-setup.md) · [CLI providers](docs/LOCAL_CLI_PROVIDERS.md) · [Postgres](docs/LOCAL.md) |
| Run the desktop app or connect an AI client | [Desktop setup](docs/DESKTOP.md) · [Local MCP](docs/LOCAL_MCP.md) |
| Review facts or query a graph | [Review](website/docs/guides/review.md) · [Ask](website/docs/guides/ask.md) · [Connect a graph database](website/docs/guides/graph-connections.md) |
| Inspect how a run was produced | [Research records](website/docs/research/experiments.md) · [Evaluation](website/docs/research/evaluation.md) |
| Work on the code | [Architecture](website/docs/developers/architecture.md) · [API](website/docs/developers/api.md) |

## Contributing

Bug reports, documentation improvements, and code contributions are welcome. For a bug, include a minimal example, the steps to reproduce it, and what you expected to happen. Run these checks before opening a pull request.

```bash
npm run check
npm run docs:check
```

See the [contributor guide](website/docs/developers/contributing.md) for project conventions and additional checks.

## License

OntoLab’s original code, including work adapted from IndustriAgents GraphMind and its knowledge-graph chatbot, is [MIT licensed](LICENSE). Modified Helix Foundry components retain their [Apache-2.0 license](LICENSES/Apache-2.0.txt) and [upstream notice](NOTICE). See [third-party notices](THIRD-PARTY-NOTICES.txt) for bundled dependencies.
