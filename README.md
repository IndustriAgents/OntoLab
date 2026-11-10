# OntoLab

[![CI](https://github.com/IndustriAgents/OntoLab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/IndustriAgents/OntoLab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Build ontologies and knowledge graphs from documents.**

OntoLab is an open-source workspace for defining a domain’s vocabulary and turning documents into facts you can trace to their sources. Build and align ontologies on their own, or use a saved ontology to guide knowledge graph extraction.

[How it works](#how-it-works) · [Two workflows](#two-workflows) · [Quick start](#quick-start) · [Architecture](#architecture) · [Documentation](#documentation) · [Contributing](#contributing)

<video src="media/ontolab-linkedin-40s-horizontal-16x9.mp4" controls muted width="100%">
  <a href="media/ontolab-linkedin-40s-horizontal-16x9.mp4">Watch the OntoLab 40-second overview</a>
</video>

## Why OntoLab

- **Every fact is traceable.** Extracted facts keep the source passage they came from, so reviewers can check evidence before accepting it.
- **Requirements first.** Competency questions define what the ontology must answer and are reused to test the ontology and the graph.
- **People stay in control.** Models propose classes, mappings, and facts; you accept, reject, or edit them and save versions you can compare.
- **Standards in, standards out.** Import Turtle, RDF/XML, or JSON-LD, validate with SHACL and SPARQL, and export RDF or publish to a graph database.
- **Runs where you work.** Use it in the browser or as a desktop app, with local CLIs, Ollama, or API providers, and local or Postgres storage.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/ontolab-workflows-dark.png">
  <img alt="How OntoLab works: highlighted phrases from a source manual pass through the ontology, drawn as a prism, and come out as color-coded knowledge graph nodes (a station, a component, an actuator, and a sensor), so each fact can be traced back to the words it came from. Below, the five steps of the ontology workflow and of the knowledge graph workflow." src="docs/diagrams/ontolab-workflows.png">
</picture>

The two workflows share one project. A saved ontology guides knowledge graph extraction, and new documents can feed back into the ontology. Each step that uses a model produces proposals for review, and nothing is saved as a version until you choose to save it.

## Two workflows

### 1. Build, edit, and align ontologies

An ontology defines the kinds of things your graph can describe and how they relate.

- **Build from documents.** Upload sources, define the questions your ontology should answer, and generate a draft of classes and properties. Use new documents to refine an existing ontology. [Build an ontology from documents](website/docs/guides/build-tbox.md)
- **Edit directly.** Start from a template or import Turtle, RDF/XML, or JSON-LD. Use the editor to add or change classes, properties, and relationships. [Manual editing](website/docs/guides/manual-editing.md#edit-the-schema)
- **Align and merge.** Compare ontologies or standards, review proposed matches, and save the mappings you accept. [Ontology alignment](website/docs/guides/align-merge.md)

### 2. Build and edit knowledge graphs

A knowledge graph records the specific entities and facts found in your sources.

- **Extract from documents.** Choose a saved ontology and extract entities, attributes, and relationships from PDFs, Word documents, spreadsheets, and other supported files. [Build a knowledge graph](website/docs/guides/extract-abox.md)
- **Review and edit facts.** Inspect source passages, resolve duplicates, and accept, reject, or edit proposed facts. You can also edit graph entities and relationships directly. [Review evidence](website/docs/guides/review.md) · [Edit graph facts](website/docs/guides/manual-editing.md#edit-assertions)
- **Validate and use the graph.** Save a reviewed version, ask questions with citations, or export RDF as Turtle. [Ask questions](website/docs/guides/ask.md) · [Export a graph](website/docs/guides/export.md)

## Quick start

Install **Node.js 22.22 or newer** and choose a model provider. If you already use **Codex CLI** or **Claude Code**, install and sign in through the official CLI on the same machine and account where you’ll run OntoLab. [Local CLI setup](docs/LOCAL_CLI_PROVIDERS.md)

Follow the guide for your operating system. Each one installs the prerequisites, fetches the code, and starts OntoLab with local storage.

### macOS

Install Git and Node.js with [Homebrew](https://brew.sh), then run OntoLab from Terminal:

```bash
brew install git node@22
brew link --overwrite node@22
node -v   # must print v22.22.0 or newer

git clone https://github.com/IndustriAgents/OntoLab.git
cd OntoLab
npm ci
npm --prefix website ci
STORE_MODE=local npm run dev
```

### Windows

Install Git and Node.js with `winget` in PowerShell, then open a **new** PowerShell window so both are on your `PATH`:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.22
```

```powershell
node -v   # must print v22.22.0 or newer

git clone https://github.com/IndustriAgents/OntoLab.git
cd OntoLab
npm ci
npm --prefix website ci
$env:STORE_MODE = "local"
npm run dev
```

PowerShell does not accept the `STORE_MODE=local npm run dev` form used on macOS and Linux; set the variable on its own line as shown. In Command Prompt, use `set STORE_MODE=local` instead. If PowerShell blocks `npm` with a script execution policy error, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again.

### Linux

Install Git with your package manager and Node.js with [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), since distribution packages are often older than Node.js 22.22:

```bash
sudo apt install git        # Debian/Ubuntu; use dnf, pacman, or zypper on other distributions
nvm install 22
node -v   # must print v22.22.0 or newer

git clone https://github.com/IndustriAgents/OntoLab.git
cd OntoLab
npm ci
npm --prefix website ci
STORE_MODE=local npm run dev
```

### Open OntoLab

Open [localhost:5173](http://localhost:5173) and select **Codex** or **Claude Code** under **Local CLIs** in the model picker when setting up a run.

- **Try graph extraction first.** Choose **Open the sample project** to start with a synthetic technical manual and a saved ontology. [Sample walkthrough](website/docs/start/quickstart.md)
- **Build an ontology first.** Create a project, open **Ontology → Build & sources**, and choose **From documents**. [First project guide](website/docs/start/first-project.md)

### Use Ollama or an API key

For **Ollama**, start Ollama and pull a model such as `llama3.1`. Set `OLLAMA_BASE_URL=http://127.0.0.1:11434` and `OLLAMA_MODELS=llama3.1` in `.env`. For an **API provider**, set its key in `.env`, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Restart OntoLab and select the provider in the model picker. For any other **OpenAI-compatible server** (LiteLLM, vLLM, LM Studio, a university or company gateway), open **Settings → AI providers → Add endpoint** and enter its base URL, API key and models; no restart is needed. [Environment template](.env.example) · [Supported providers](website/docs/reference/integrations.md)

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/ontolab-architecture-dark.png">
  <img alt="OntoLab architecture: the server is drawn as a circle with the RDF engine at its core and nine services around it. Web, desktop, and MCP clients connect from the left; model providers, project storage, and optional graph databases and sidecars connect on the right. Credentials stay inside the server." src="docs/diagrams/ontolab-architecture.png">
</picture>

| Layer          | What it does                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Clients**    | React/Vite web app, Electron desktop app, and AI clients through the [local MCP bridge](docs/LOCAL_MCP.md). Docs are bundled at `/docs/`. |
| **HTTP API**   | Node server with loopback Host and Origin checks. Provider credentials stay on the server.                                                |
| **Services**   | Documents, requirements, induction, alignment, extraction, review, revisions, graph chat, and validation (`server/services/`).            |
| **RDF engine** | N3.js for Turtle, `rdf-validate-shacl` for shapes, Oxigraph (WASM) for SPARQL, and built-in OWL RL checks.                                |
| **Models**     | Codex or Claude Code CLIs, Claude, OpenAI, Gemini, DeepSeek, or Ollama.                                                                   |
| **Storage**    | Local filesystem or Postgres/Neon. Optional connections to GraphDB, Fuseki, RDF4J, generic SPARQL, or Neo4j.                              |
| **Sidecars**   | Optional Docling parser and DL reasoner.                                                                                                  |

The diagram sources are in [`docs/diagrams/`](docs/diagrams). Each diagram has a light and a `-dark` version, and GitHub shows the one that matches your theme. Open the `.drawio` files in [draw.io](https://app.diagrams.net) to edit them, then export a PNG with the same name. See the [architecture guide](website/docs/developers/architecture.md) for details.

## Documentation

| I want to…                                  | Start here                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start with my own documents                 | [Create your first project](website/docs/start/first-project.md)                                                                                   |
| Configure models or storage                 | [Local setup](website/docs/developers/local-setup.md) · [CLI providers](docs/LOCAL_CLI_PROVIDERS.md) · [Postgres](docs/LOCAL.md)                   |
| Run the desktop app or connect an AI client | [Desktop setup](docs/DESKTOP.md) · [Local MCP](docs/LOCAL_MCP.md)                                                                                  |
| Review facts or query a graph               | [Review](website/docs/guides/review.md) · [Ask](website/docs/guides/ask.md) · [Connect a graph database](website/docs/guides/graph-connections.md) |
| Inspect how a run was produced              | [Research records](website/docs/research/experiments.md) · [Evaluation](website/docs/research/evaluation.md)                                       |
| Work on the code                            | [Architecture](website/docs/developers/architecture.md) · [API](website/docs/developers/api.md)                                                    |

## Contributing

Bug reports, documentation improvements, and code contributions are welcome. For a bug, include a minimal example, the steps to reproduce it, and what you expected to happen. Run these checks before opening a pull request.

```bash
npm run check
npm run docs:check
```

See the [contributor guide](website/docs/developers/contributing.md) for project conventions and additional checks.

## License

OntoLab’s original code, including work adapted from IndustriAgents GraphMind and its knowledge-graph chatbot, is [MIT licensed](LICENSE). Modified Helix Foundry components retain their [Apache-2.0 license](LICENSES/Apache-2.0.txt) and [upstream notice](NOTICE). See [third-party notices](THIRD-PARTY-NOTICES.txt) for bundled dependencies.
