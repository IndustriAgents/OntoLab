# OntoLab

[Local setup](website/docs/developers/local-setup.md) · [Sample walkthrough](website/docs/start/quickstart.md)

OntoLab turns **documents from any domain** — contracts, clinical notes, financial filings, HR records, research papers, technical manuals — into a **reviewed knowledge graph**. It starts from what the graph is for (user stories → competency questions), builds or reuses an **ontology** (T-Box) for it, extracts the **instances** (A-Box) with every claim checked against its source quote, resolves duplicates, validates the result, and exports RDF.

You can bring your own T-Box, start from a template, or let OntoLab induce one from your documents — nothing has to be written in Turtle by hand.

**Vite + React + TypeScript** frontend, a **Node backend** that holds the API keys, **N3.js** for Turtle, **rdf-validate-shacl** for SHACL, **Oxigraph** for SPARQL and RDF/XML/JSON-LD import, **transformers.js** for local embeddings and entailment, **Cytoscape** for graph visualization, and an optional **Docling** sidecar (Python) for layout-aware parsing and OCR.

## From documents to a graph

```
Documents → Parse & chunk → Requirements → Ontology → Extraction → Entity resolution → Evidence gate → A-Box draft → Validate → Commit → Assistant / Export
                                              ▲                 │
                                              └── unmatched ────┘   (improvement loop: terms the ontology lacks become proposed additions)
```

| Stage                 | What happens                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parse & chunk**     | PDF, DOCX, XLSX, XLS, HTML, XML, Markdown and text natively (headings and tables kept); PPTX, images and OCR through the Docling sidecar. Chunks overlap by ~12% and carry their section path; page offsets stay exact.                                                                                                                                                         |
| **Requirements**      | 2–4 user stories → generated competency questions → you edit and approve them. Each approved question keeps its SPARQL once translated; its pass rate is reported on every commit.                                                                                                                                                                                         |
| **Ontology**          | Induced from your documents (topic clusters → classes → merge → relations → reuse lookup in LOV/schema.org/BioPortal → pitfall scan and repair), started from a **template**, or imported (Turtle, RDF/XML, JSON-LD). Standards can be **aligned** with your modules. Always a draft you review.                                                                           |
| **Extraction**        | Per chunk, with a **document summary** and the chunk's section path, the **retrieved part of the T-Box** for large ontologies, a **code-style** schema rendering, and the known individuals of the committed graph so runs **add to** the graph instead of replacing it. A relevance screen skips unrelated chunks and a result cache never pays twice for the same chunk. |
| **Entity resolution** | Candidates by name, meaning and grounding (Wikidata, GeoNames, UMLS); the model only judges the ambiguous pairs; you merge or keep separate in Explore.                                                                                                                                                                                                                    |
| **Evidence gate**     | Every quote is located in its chunk (offsets, page) and every claim is scored for entailment against its quote; weak ones are marked for review.                                                                                                                                                                                                                           |
| **Assistant**         | Questions are routed: passages (keyword + dense, fused), Personalized PageRank over the graph for multi-hop, Text2SPARQL with repair for counts and lists.                                                                                                                                                                                                                 |

## How it works

OntoLab is a persistent **project workspace**. Each project holds its requirements, ontology, source documents, runs and every committed revision:

The project sidebar organizes the main work into three paths:

1. **Ontology → Build & sources**: documents → parsed text → chunks → generation → stage results → validation and commit.
2. **Knowledge graphs**: choose or create a graph workspace, prepare documents, extract against a saved ontology, review evidence and validate, then save a graph version. Corpus documents, extraction updates, history and settings stay inside this workflow.
3. **Ontology → Align & merge**: import standards → inspect parsed terms → find matches → review and apply mappings → validation and commit.

Each screen shows one step. Expand **Method, parameters & research details** to inspect the algorithm and recorded evidence. Switch **Experiment** to revisit a saved run; historical preprocessing reads its snapshot, never the current document. New runs also retain full parsed text and page/section/table spans. The sidebar separates **Ontology**, **Knowledge graphs** and **Activity**; project settings live in **Overview**, and each graph has its own settings. Existing editor and run URLs remain available.

Ontology source management lives in **Ontology → Build & sources → Documents**, and chunk configuration lives in **Chunks**. The sidebar has no separate Ontology sources or Research workspace entries. Open **Inspect methods, inputs & stage results** from a run in **Activity** for recorded diagnostics and exports. Older document and research overview URLs lead to these workflow steps; direct file/evidence and recorded-run links remain usable.

Choose the ontology draft or saved version in the sidebar’s **Selected ontology** picker. **Build & sources** shows **Continue selected ontology**, where you can resume a draft, edit a saved version as a new draft, or improve it with documents. **Improve with documents** is also available directly in review and validation. Add or change documents, adjust chunks and embedding models, or change generation settings. The previous build's exact document selection and settings are carried forward when available, with the selected ontology as the starting point. Generate a separate draft, review and validate it, then save the next version; earlier versions and build evidence remain available.

| Page                 | What it does                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects**         | Create a project from your documents, a template or an existing ontology; open, rename, archive, delete, import; open the bundled sample.                                                                                                                                                                                              |
| **Project settings** | Purpose and scope, user stories → competency questions (generate, edit, approve, translate to SPARQL), next step, CQ pass rate, budget, model and grounding settings.                                                                                                                                                                  |
| **Ontology**         | Build from documents (induction), review a draft (contents, pitfalls, reuse, alignment), import modules or standards, author changes by hand or with AI, validate against the committed ontology, commit; revision history with separate T-Box and A-Box versions.                                                                     |
| **Documents**        | Upload (private storage, sha256 identity), parse once with pages, sections and tables, preview, retry, remove.                                                                                                                                                                                                                         |
| **Runs**             | Extraction and induction runs with a cost estimate, options and budget; bounded, checkpointed steps that resume after an interruption (or run on the server with the background worker); proposed ontology additions after each extraction.                                                                                            |
| **Explore**          | Graph, table and Turtle views; the duplicate review; an inspector that traces every claim to its source passage with its entailment score and grounding links.                                                                                                                                                                         |
| **Validate**         | Schema checks, SHACL and competency questions, stored per revision and marked stale when the revision changes.                                                                                                                                                                                                                         |
| **Assistant**        | **Ask** — graph chat: the assistant answers by running SPARQL on the project graph (or a GraphDB repository) and searching the documents, citing queries `[Q1]` and passages `[C1]`, with an evidence window (evidence graph, SPARQL, results, answer, trace). **Propose changes** — a draft revision with diff and validation impact. |
| **Export**           | Turtle of a chosen revision (with `owl:sameAs` grounding links), validation reports, and a portable project archive.                                                                                                                                                                                                                   |

Every change is a **draft → validate → commit** flow: committed revisions are immutable, editing one starts a draft, and committing checks that nobody else committed in between. When a T-Box change renames a term, the individuals using it are migrated; individuals using a removed term are flagged.

### Extraction and evidence

The model is called with **structured output** whose schema is built from the (retrieved part of the) T-Box — class/property URIs and datatypes are enums — one chunk at a time. The server runs a **conformance pass** over every result; terms the T-Box lacks are kept for the improvement loop rather than discarded. Each quoted passage is located in the chunk it came from: evidence is _verified_ (found, with document offsets and page), _unverified_, _vision_ (read from a PDF image) or _legacy_ — locations are never guessed — and then scored for entailment.

## Inspecting research experiments

Inspect evidence directly inside each workflow. Recorded run diagnostics and workflow evidence expose these research views:

- **Documents & chunking** shows the parser, OCR flag, detected sections/tables, source hashes, exact chunk text, offsets, pages and highlighted leading overlap. Compare paragraph packing with section-aware paragraphs or a fixed-character baseline. Set a base size (200–60,000 characters) and overlap (0–30%), preview without a model call, compare statistics, and export. The base size excludes appended overlap; offsets use JavaScript UTF-16 code units, not tokenizer tokens.
- **T-Box pipeline** exposes classes, consolidation, relations, axioms, reuse, pitfalls/repair and the final draft. Inspect topic membership and the actual sampled passages sent to class/property calls, including removed overlap and truncation.
- **A-Box pipeline** exposes summaries, per-chunk extractions, grounding, duplicate candidates, evidence scores and draft assembly. Expand individuals to inspect assertions and quotations. Cached outputs and screened-out chunks are labelled separately.

Each stage shows its implemented method directly. **Technical result tables** record the numerical evidence used at execution: final topic-assignment centroid cosines, evaluated class-merge comparisons, relevance scores, schema top-k and closure decisions, entity pair scores, and raw alignment cosine alongside lexical/structural/combined scores. The tables distinguish uncomputed values from zero, identify thresholds and actual embedding backends, and export stored precision. Detailed run score tables retain up to 2,000 rows per operation/group, explicitly displaying evaluated totals when capped; alignment tables show candidates surviving retrieval, not every pair. Old runs do not gain reconstructed scores.

The chunk step directly names the recorded chunking method and its size/overlap, and shows a table of boundaries and measured lengths. These chunking methods use character/paragraph/section boundaries, not cosine similarity. In A-Box research parameters, choose **Cached extraction results → Recompute with fresh measurements** to bypass summary/extraction caches; this makes new model calls and records fresh screening/retrieval measurements.

Each stage explains its method and tuning choices. Recorded configuration, diagnostics, timing and token counters accompany the artifacts. **Research parameters & ablations** in run setup exposes prompt rendering, schema retrieval/top-k, fact-review policy, competency-question guidance, axiom induction, repair and strict grounding.

Ontology repair sends a bounded neighborhood of statements for a small set of findings, plus a compact vocabulary, rather than the full ontology. Patches can remove only statement IDs supplied in that request; unrelated statements remain in the complete module. Every patch is checked against the full ontology. If automatic repair cannot finish within its input/output budget, the last validated draft and unresolved findings remain available for review. Repair scope and full-request token checks are recorded with the checkpoint.

Saving a chunking experiment creates an **independent document variant**. Existing inputs remain unchanged. Variants are unselected by default in new runs: select a variant **instead of** its source for a controlled comparison. Project archives retain variant chunk settings and ancestry; import reparses originals with those settings. Use **Export research record** separately to preserve exact run snapshots/checkpoints; the ordinary archive does not include run history.

New runs save parsed text, source chunks, metadata, requirements, the base revision and intermediate/final outputs. Later draft edits do not alter the final checkpoint. Older records explicitly mark missing historical metadata. Method descriptions document the current implementation, not necessarily the code used for an older run. Verbatim model prompts/responses are not captured; provider-based NLI token usage is not included in the existing token counters. Inspection records do not establish extraction accuracy or deterministic reproducibility.

### Alignment and validation evidence

Alignment records store the compared modules and revision hash, active matchers, thresholds, actual embedding backend, model choice, candidate scores and rationales, timings and recorded token counts. Retrieved candidates include pairs later classified as unrelated. Each acceptance records requested/accepted mapping IDs, coherence conflicts and generated bridge Turtle. Changed source modules require matching again. The merge preserves source modules and adds an `alignment.ttl` bridge; unverified matches use `skos:closeMatch`, not logical equivalence.

Validation is shared by all three workflows. It separates ontology/A-Box structure, SHACL, logical consistency and competency queries. Expand SHACL details to inspect or download the exact generated shapes, validated data graph (including added ancestor types) and raw constraint results. Empty data and execution failures are distinct from conformance. Reports remain tied to a revision content hash. These checks cover the implemented OWL/SHACL subset; the reasoner reports unsupported constructs, and CQ answer rate is not a gold-standard accuracy metric.

## Measuring quality

`npm run eval` runs the **evaluation harness** (`eval/`) on a gold set of hand-labelled documents in three domains (`eval/gold/`: contracts, clinical notes, technical manuals) with a real model, and reports every stage against the plan's targets: CQ similarity, induction F1 (literal, fuzzy, continuous, graph), extraction precision/recall and Text2KGBench-style hallucination rates, duplicate and wrong-merge rates, verified-evidence share and entailment agreement with human labels, assistant accuracy by question type (routed vs passage-only), and cost per document with estimate error.

```bash
npm run eval -- --provider mock                                   # harness smoke test, no spend
npm run eval -- --provider gemini --model gemini-2.5-flash --yes  # real run (costs money)
npm run eval -- --provider claude --model claude-sonnet-4-6 --domains contracts --stages extraction,evidence --yes
```

Results go to `eval/results/<timestamp>-<model>.{json,md}`. The seed gold set was drafted by AI and **must be reviewed by a person** before its numbers are trusted; the plan targets 10–15 documents per domain (see `eval/gold/README.md`).

## Retrieval, entailment and parsing models

| Setting              | Default                                                                    | Options                                                                             |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `EMBEDDINGS_BACKEND` | `local` (MiniLM via transformers.js, downloaded once to `MODEL_CACHE_DIR`) | `provider` (OpenAI, Gemini or Ollama embeddings), `hash` (lexical, no model), `off` |
| `NLI_BACKEND`        | `local` (DeBERTa-v3 NLI via transformers.js)                               | `provider` (the run's model as a grounded judge), `lexical`, `off`                  |
| `PARSER_URL`         | empty (built-in parsers)                                                   | URL of the Docling sidecar (`sidecar/docling`)                                      |

If a local model cannot load (no network for the first download), the server falls back to the lexical backend and says so in its log. Projects can override the server defaults under Overview → Project settings → Quality.

## Validation

Two independent checks run over every A-Box, both **flag-and-keep** (nothing is silently dropped):

- **Hand validator** — errors for duplicate ids, two ids minting the same IRI, an id colliding with a T-Box term, unknown classes/properties, dangling links and disjoint-class violations; warnings for domain/range mismatches, wrong datatypes, ill-formed literals (`"fast"` is not an `xsd:decimal`), functional properties with several values, and unmet `owl:Restriction`s.
- **SHACL** — shapes induced from the T-Box (class targets, domains, ranges, datatypes, `sh:maxCount` for functional properties, `sh:not` for disjoint classes, restrictions as cardinality constraints), validated with the subclass hierarchy materialised first.

Competency questions are translated to SPARQL and run with Oxigraph against the merged T-Box + A-Box graph, with subsumption materialised so `?x a :Component` also matches `:Actuator` instances.

## Assistant: graph chat

Ask is an agent (ported from the kg_chatbot project). The model is given the graph's schema digest and tools — `sparql_query`, `search_documents`, and `find_individuals` on the project graph, or a read-only database query tool on a connected RDF or Neo4j database — and answers by calling them, for up to `MAX_TOOL_ROUNDS` rounds. Every step streams to the browser as server-sent events. Connected RDF databases use scoped SPARQL HTTP queries; Neo4j uses native read-only Cypher through its HTTP Query API.

- Each query is tagged `Q1`, `Q2`, … and the answer cites the ones it used; passages from the documents are `C1`, `C2`, ….
- The **evidence graph** is rebuilt from the cited queries: each triple pattern filled in with each result row. A query that hides its joins (aggregates, `GROUP BY`, unprojected variables) is re-run as `SELECT DISTINCT *`, pinned with `VALUES` to the rows it returned (`Q2·e`), so the graph shows the triples behind the actual answer.
- The assistant is read-only: updates are refused, and on the project graph only `SELECT` and `ASK` run.
- The queries (first 50 rows each), trace and evidence graph are stored with the answer, so the evidence window works for past answers too.
- Answer from the **project graph**, or add GraphDB, Fuseki, RDF4J, generic SPARQL or Neo4j in **Account & workspace → Graph connections**. In a project, choose **Knowledge graphs → Connect existing graph**. Connected graphs need no saved ontology and remain read-only. **Export → Publish a saved version** writes a fresh named graph to an explicitly enabled RDF publishing connection. See [graph connections and Docker verification](website/docs/guides/graph-connections.md).

Tool calling works with Claude, OpenAI, DeepSeek (`deepseek-chat`), Gemini and Ollama models that support tools.

## Export

The exported Turtle is interoperable with Protégé and GraphDB:

- an `owl:Ontology` header that `owl:imports` the T-Box,
- `owl:NamedIndividual` typing (OWL 2 DL),
- `dcterms:source` provenance carrying the supporting quote for each individual,
- individuals in their **own namespace** (`<tbox-ns>/abox#`), so an individual can never collide with a T-Box term,
- normalised datatypes and language tags, and a lossless round-trip back through the editor.

Requirements are edited in **Ontology → Build & sources → Requirements**. Overview shows a compact summary. Saving changed stories, questions, approvals or SPARQL creates a requirements version; **Version history** compares saved content and restores an earlier set as a new version. New ontology builds pin their requirements version, purpose and scope at creation, including across retries. Earlier builds retain their existing recorded inputs.

## Providers

For local development, **Claude Code**, **Codex** and supported **Antigravity** CLIs can use their own server-side logins for generation, extraction and graph answers. See [Local CLI providers](docs/LOCAL_CLI_PROVIDERS.md) for setup, compatibility, isolation and token/accounting limits.

Extraction runs on any configured provider, each via its native structured-output mechanism: **Claude** (forced tool use, plus PDF vision), **OpenAI** (strict function calling), **DeepSeek** (function calling), **Gemini** (`responseSchema`), **Ollama** (JSON-schema `format`). A provider is enabled by setting its key in `.env`; the server advertises only models it can actually run, and refuses models that cannot do forced tool calls (e.g. `deepseek-reasoner`).

Every provider call has a wall-clock timeout, bounded retries on transient failures, truncation detection (a model that hits its output cap reports that clearly instead of silently returning half an A-Box), and is cancellable from the UI.

## Extraction modes

- **Automatic** — one structured pass; the full A-Box is produced and sent to review.
- **Interactive / Q&A** — a first pass plus clarifying questions; you answer (free text or suggested options) and the A-Box is refined round by round until you click **Finish & review**. Each round folds your prior answers _and the previous A-Box_ back into the prompt, so individual ids stay stable between rounds.

Editing the A-Box with AI applies **patch operations** (`add` / `update` / `remove`), so an edit can never drop individuals it was not asked to touch.

## Local MCP and OntoLab AI

Use **OntoLab AI** from any project to inspect sources, propose drafts and manage activities. In the desktop app, **Settings → AI connections** connects Claude Code or Codex to the same local workspace. External assistants can author ontology and evidence-backed graph drafts without another OntoLab generation provider, or start the existing pipelines. See [local MCP setup and workflows](docs/LOCAL_MCP.md).

## Setup

For the Electron desktop application with local storage and laptop CLI providers,
run `npm ci`, `npm --prefix website ci` and `npm run desktop:dev`. See [Desktop setup and packaging](docs/DESKTOP.md).

Requires **Node 22+**, Docker with Compose, and Make.

```bash
cp .env.example .env      # first setup only; add provider keys as needed
make up                  # install dependencies, start Postgres, migrate, start app
make restart             # restart the app
make logs                # follow the app log
make down                # stop the app and Postgres; retain local data
```

Open http://localhost:5173. The Make commands use Docker Postgres on `127.0.0.1:55432`. Projects and original uploads persist in a named Docker volume. Database URLs are overridden only in local child processes; existing dotenv files keep their configured values. A new local database starts empty. See [local commands and storage](docs/LOCAL.md).

`make dev` runs the app in the foreground; `make status` checks health, and `make test-db` verifies the Postgres adapter. Add `MOCK_LLM=1` for the offline demo model. Running `npm run dev` directly still uses the database settings in the environment. Without a database URL, the fallback is on-disk storage in `DATA_DIR` (default `.data/`).

> **Ports:** the API reads `API_PORT` first, then `PORT`. Set `API_PORT` in `.env` so tooling that injects `PORT` for the web server cannot steal the API's port — the Vite dev proxy reads the same value, so the two can never disagree.

## Run a local build

Run `npm run build`, then `npm start` and open http://127.0.0.1:3000.
The public edition serves a single-user workspace on loopback. It can use
on-disk storage or an optional [Postgres database](docs/NEON.md).

## Try it

- **New project → From a template**: six starter ontologies with user stories and competency questions in `samples/templates/` (contracts, clinical notes, financial filings, HR, research papers, technical manuals). Add documents and run an extraction.
- **New project → From my documents**: write the purpose and user stories, approve the generated questions, upload documents, then **Ontology → From documents** to induce an ontology.
- **Open the sample project**: the technical-manuals ontology committed as revision 1 and a synthetic distributing-station manual uploaded, ready for a run.

Run details check the result’s current state: drafts offer review, saved results open the saved version, and removed results retain their recorded processing details. Creation starts in the relevant workspace. **Pause** is stored on the server for builds, extraction and alignment; an in-flight step may finish saving, but the worker starts no further steps until resume. Budget failures show an **Adjust spending limits** recovery panel. Detailed token allocation, external registries, SPARQL translation and research options remain available in optional sections.

## Scale and cost

- **Estimate first.** Every run shows model calls, tokens and an approximate price before it starts (`PRICING_JSON` overrides the built-in table).
- **Budgets.** A per-run and a per-project limit (configurable project budget limits): a run that would exceed them is refused up front, and a running one stops at the limit with its finished steps kept.
- **Cheap first.** A relevance screen skips chunks unrelated to the ontology without a model call; results are cached by chunk, T-Box and model.
- **Background worker.** `WORKER=1` advances runs on the server without an open tab (`PARALLEL_STEPS` chunk steps at a time).

## Scripts

| Script              | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | Vite dev server + Node API (watch)                           |
| `npm run build`     | Build the SPA to `dist/`                                     |
| `npm run start`     | Serve `dist/` + API from the Node server                     |
| `npm run test`      | Unit tests (vitest)                                          |
| `npm run lint`      | ESLint (TypeScript, react-hooks, jsx-a11y)                   |
| `npm run typecheck` | `tsc --noEmit`                                               |
| `npm run check`     | typecheck + lint + test                                      |
| `npm run eval`      | evaluation harness on the gold set (see _Measuring quality_) |

The automated suite (`npm run test`) includes HTTP-level tests of the project API — ownership, runs with leases and checkpoints, interruption/resume, stale commits, read-only SPARQL, archive round-trips, the full sample workflow and every phase of the update plan (templates, requirements, induction, incremental runs, the improvement loop, merges, structured parsing, estimates and budgets, the worker, routed answers, schema migration) — using the offline mock model. `scripts/*-check.ts` are manual smoke scripts; `MAESTRO_ONTOLOGIES` points `maestro-check.ts` at a local ontology folder.

For Postgres-backed corpus integration checks, inject `CORPUS_TEST_DATABASE_URL` for a migrated, disposable branch and run `npx vitest run tests/corpus.test.ts --testTimeout=600000 --hookTimeout=120000`. Tests use separate temporary owners and clean up their workspaces. Ordinary test runs continue to use local storage.

### Document preparation

Project archives may be imported as gzip or plain JSON. The defaults allow 64 MiB
per upload and 128 MiB of expanded JSON. `MAX_ARCHIVE_BYTES` and
`MAX_ARCHIVE_EXPANDED_BYTES` can be raised for trusted larger backups.

The document workflow is **Upload original → automatic parsing → inspect readable text → configure and save chunks → generate**. Uploads return after durable storage; a separate parsing worker runs automatically for local and Postgres storage, independent of `WORKER=1`. Queued documents and expiring processing leases survive restarts.

Each file shows its upload and parsing status. Failed parsing retains the original and can be retried. Readable-text and original-file views are available before generation. The original can always be downloaded; PDF, image and text originals have an inline preview. No readable text is flagged, and unparsed or unchunked inputs cannot enter generation.

New uploads do not create chunks until you choose a method, base size and overlap, preview the result, and choose **Use these chunks**. The first configuration saves chunks on that parsed document. Unchanged text and settings reuse saved chunks; repeated saves reuse the existing configuration instead of creating duplicates. Recent previews are cached, including when switching back to earlier settings. Changed configurations create independent variants and reuse the extracted text. Sample projects and archive imports retain their existing prepared-input behavior.

The upload step manages original files: upload, view, select or delete. Completed uploads collapse to a count, leaving one row per original. Parsed text is reviewed in **Parsed text**. **Chunks** applies shared model, embedding, size and overlap settings to all selected files through **Generate chunks for all** and **Use these chunks for all**. Each file shows progress and errors; retries retain successful work. The build switches to the prepared configurations after all saves succeed. **Inspect or customize** opens individual previews, saved configurations and per-file settings. Choose one configuration per document for a build; switching configurations replaces that source's previous selection. The document library keeps configurations under their source file, while earlier builds retain their exact recorded inputs.

XML uses a built-in structured extractor: scientific article XML produces headings, paragraphs and simple tables; generic XML retains field paths and attributes in its reading text. XML element paths map back from extracted text spans. Malformed XML reports a parse failure; external/custom entity expansion is unsupported. Inspect complex tables against the original.

Parser versions and source/text hashes are recorded separately from chunk settings. **Reparse original** creates a separate processing version, so earlier text, chunks, run snapshots and evidence remain unchanged. Previously uploaded documents are not automatically reprocessed.
The source picker and document library expose **Original file** directly, including its download. **Reparse original** is available above both the original-file and readable-text views and uses the currently configured parser to create a separate processing version.

Postgres deployments must run `npm run db:migrate` to apply `0002_document_processing.sql` before enabling the new parsing worker. The migration permits the existing worker role to discover pending documents; actual parsing remains scoped to the document owner.

### Token-aware chunking

The Chunks step defaults to token sizing. Select an embedding model and a generation provider/model before previewing. Set independent **embedding passage** and **generation chunk** budgets, a configured generation context cap, and reserves for the prompt/ontology and output. Final generation chunks include overlap inside their token limit; paragraph and section boundaries and source offsets are retained. Character sizing remains available for legacy comparisons.

Local embedding token counts use the selected model's tokenizer, including special tokens. Supported OpenAI models use matching BPE encodings. Other preview counts, and unavailable tokenizer previews, use a labelled conservative UTF-8 byte estimate; they are not exact model token counts. A tokenizer download may occur on first preview, but previewing performs no embedding inference or text generation. Explicitly selected local embedding models fail if their tokenizer/model is unavailable, rather than silently switching vector spaces.

Each generation chunk records token measurements and source spans for its smaller embedding passages. Heading context is included in embedding budgets. All embedding inputs are processed in full through bounded passages; long parent inputs use a normalized token-weighted mean of passage vectors. The former 2,000/6,000-character embedding clipping, 4,000-character vector-index clipping and six-window schema retrieval cap have been removed. Updated vector cache identities prevent reuse of the former clipped vectors.

Saving retains the model choices, tokenizer identity, count accuracy and separate budgets. Runs use those choices instead of later project defaults. Inputs with incompatible embedding models or changed generation models must be reconfigured. Fully assembled structured generation requests are checked before inference, including schema/instructions and reserved output. Gemini and Claude use their token-counting APIs; Gemini also reserves a conservative native-response-schema allowance. Other providers use local counts/estimates with protocol overhead. Request-check measurements are stored with run checkpoints. Output limits use the saved reserve (including provider thinking tokens); configure it accordingly. Context caps are configured limits, not a claim about a provider's maximum supported context. Character offsets remain the authority for evidence locations.

When changing generation models in **Generate**, use **Prepare all selected documents** to save compatible chunk configurations for every affected input, or **Use saved model** to keep the existing configuration. Preparation preserves chunk sizes, embedding choices and token budgets; generation starts separately. Codex CLI models are discovered from the installed CLI's local model catalog (or `ONTOLAB_CODEX_MODELS`), and named models expose their supported **Reasoning effort** choices. Effort is saved with the build and passed to Codex; it does not require rechunking.

### Separate knowledge corpora

After saving an ontology, open **Knowledge graphs** and choose **New knowledge graph** to create a named workspace pinned to that ontology version. Use the sidebar to switch graphs and open Documents, Extract & review, Explore, Validation, Versions and Graph settings. Each corpus starts empty: ontology-building documents and other corpora's facts are never included automatically.

1. Upload corpus documents. Parsing and token-aware preparation run automatically; inspect the original, extracted text and chunks before extraction.
2. The Documents page summarizes new files, replacements and unchanged documents to reuse. Choose **Create knowledge graph** or **Update knowledge graph** to start. Identical uploads are deduplicated by file content; advanced processing options stay expandable.
3. Review a separate draft showing only changed facts, grouped by entity. Compare previous and proposed values with source evidence, inspect conflicts, and accept supported changes together. Facts retain document, chunk and run-snapshot provenance.
4. Accept or reject claims, resolve source-loss decisions, validate and save the knowledge graph or graph update. Corpus queries, graph answers and exports use accepted facts only. The current graph stays available during processing and review.
5. Add documents or choose **Replace document** and repeat. Unchanged source configurations, existing identities and human decisions for identical facts are reused. Removing a source removes its contribution; independent support and manually maintained knowledge survive. Historical files, graph versions and snapshots remain available.

**Versions** supports comparison, downloads and explicit restoration as a new version. Ontology upgrades are explicit draft updates. Corpus graph views, answers, search and exports stay scoped to the chosen corpus. A portable project archive includes its separate corpora; a corpus backup includes only that corpus and its ontology package. Imported active runs are stopped rather than automatically making model calls.

The T-Box evidence explorer also includes an interactive **Graph** view connecting recorded topic groups, chunks, quotes and generated terms. Its selected path distinguishes quoted evidence from passages merely included in a generation call.

## Documentation development

Documentation lives in `website/`, shared by the public site and bundled help. The app's Docs menu opens the relevant local article at `/docs/`, with offline search, sample downloads and a Back to workspace link. Desktop releases include the same articles and assets, matched to the app version.

Install both sets of dependencies before starting or building the app. `make setup` installs missing dependencies automatically. `npm run dev` builds and caches local help before starting; run `npm run docs:bundle` after editing articles while the app is running. Production and desktop builds include help automatically, including deployments under `BASE_PATH`.

```bash
npm --prefix website ci
npm run docs:dev
# Full production build, including local search and link checks:
npm run docs:check
npm run docs:build
npm --prefix website run preview
```

See [website/README.md](website/README.md) for local preview and routing checks. Update guides in the same PR as the behavior they document.

## License

OntoLab's original code uses the [MIT license](LICENSE), including the UI
styles adapted from IndustriAgents GraphMind and the Ask code adapted from
IndustriAgents' knowledge-graph chatbot project.

The Explore graph and paper theme include modified code from
[Helix Foundry](https://github.com/HelixDB/helix-foundry) under
[Apache-2.0](LICENSES/Apache-2.0.txt). The affected files carry an Apache-2.0
header. See the upstream [notice](NOTICE) for attribution.

Desktop builds include these licenses and a generated dependency inventory. See
[third-party notices](THIRD-PARTY-NOTICES.txt), including the native libvips terms
and source-distribution requirements for binary releases.
