# OntoLab domain-neutral update — implementation status

This records how the seven-phase *OntoLab Update Plan* (workstream A:
domain-neutral onboarding; workstream B: structural fixes) was implemented,
where each change lives, how it is tested, and what is still open. Decisions
taken with the plan's owner on 2026-10-13: implement all seven phases; add the
Docling sidecar; local models by default with a provider option; gold-set
domains contracts, clinical notes and technical manuals.

## Phase 0 — evaluation harness ✅ (gold set needs review)

| Item | Where |
|---|---|
| Metrics: extraction P/R/F1, typing accuracy, Text2KGBench-style hallucination and conformance; duplicate and wrong-merge rates; verified-evidence share; entailment agreement (accuracy, Cohen's kappa); OLLM-style literal/fuzzy/continuous F1 and graph F1; CQ similarity; answer accuracy | `eval/metrics.ts` (tested in `tests/eval.test.ts`) |
| Harness: runs the real services per domain and stage, writes JSON + Markdown with the plan's gates | `eval/harness.ts`, CLI `eval/run.ts`, `npm run eval` |
| Seed gold set: 4 synthetic documents per domain, gold T-Box, ~45–50 labelled individuals, 8 CQs with SPARQL, 12 assistant questions, 15 entailment labels | `eval/gold/` |

**Open:** the gold set was drafted by AI and must be reviewed by a person; the
plan targets 10–15 documents per domain. No real-model run has been made yet
(the harness asks for `--yes` before spending).

## Phase 1 — from my documents ✅

| Item | Where |
|---|---|
| A1 CQ-first requirements: stories → generated CQs → edit/approve; SPARQL stored with each CQ; pass rate on every commit | `server/services/requirements.ts`, `src/features/overview/RequirementsCard.tsx`, commit route in `server/app.ts`, `cqPassRate` in `server/services/validation.ts` |
| A2 induction from stored documents: topic clusters (k-means on chunk embeddings) → term typing + taxonomy → merge → relations → reuse → pitfalls → draft | `server/services/induction.ts` (a run `kind: "induction"`), `src/features/ontology/InducePanel.tsx` |
| A3 reuse before minting: LOV, schema.org, BioPortal; accept adds `owl:equivalentClass/Property` | `server/services/reuse.ts`, `server/services/review.ts`, `OntologyReview.tsx` |
| A4 pitfall scanner (OOPS! P02, P04, P06, P08, P10, P11, P13, P19, redundant subclassing; LLM-specific: instance-as-class, attribute-should-be-relation, class/property clash) and one repair pass that is kept only if it reduces serious findings | `src/lib/ontology/pitfalls.ts`, pitfalls step in `induction.ts` |
| B2 code-style schema rendering (typed Python-like classes) | `describeTBoxCode` in `server/prompts.ts`; `PROMPT_STYLE` |
| A8 rebrand | README, UI copy, prompts, sample naming |

The old browser-side "Build with AI" tab was replaced by **From documents**;
the component `BuildWithAiPage.tsx` and its hook state remain but are unused.

## Phase 2 — incremental graph ✅

| Item | Where |
|---|---|
| B1 runs merge into the base revision's A-Box; known individuals seeded from the committed graph, filtered to the chunk's classes and names | `assemble` / `knownFor` in `server/services/runs.ts`; `incremental` run option |
| A7 improvement loop: the conformance pass keeps unknown terms; the extractor may propose terms; grouped by meaning; accepting commits a T-Box revision (extensions.ttl) when it validates | `conformAbox` in `server/validation.ts`, `PROPOSED_TERMS_SCHEMA`, `server/services/proposals.ts`, Runs page |
| B2 schema retriever: top-k terms per chunk by embedding + lexical match, closed under ancestors and domain/range | `server/services/schemaRetrieval.ts` |

## Phase 3 — quality ✅

| Item | Where |
|---|---|
| B3 entity resolution: blocking by name similarity and embeddings within compatible classes, certain matches decided without a model, select-style LLM prompt on ambiguous pairs, union-find clusters, merge review UI | `server/services/resolution.ts`, `src/lib/ontology/resolution.ts`, `src/features/explore/MergePanel.tsx` |
| Grounding to Wikidata / GeoNames / UMLS as `owl:sameAs` (exact, unambiguous matches only) | `server/services/grounding.ts`; exported and re-imported by the Turtle serializer/reader |
| B4 evidence gate: `requireEvidence`, verbalised claims, entailment score per quote, review flag below the threshold | `server/services/verification.ts`, `server/ml/nli.ts` |

## Phase 4 — structure and standards ✅ (sidecar not run live)

| Item | Where |
|---|---|
| B6 Docling sidecar (FastAPI, UTF-16 offsets, sections, tables, OCR) and client with span validation | `sidecar/docling/`, `parseWithDocling` in `server/services/parsing.ts` |
| Built-in parsing keeps headings and tables (DOCX via mammoth HTML, HTML, Markdown; PDF headings from font size) | `server/services/structuredText.ts`, `server/services/parsing.ts` |
| Chunk overlap (12%), section path per chunk, document summary per run | `server/services/chunking.ts`, `summary` step in `runs.ts` |
| A5 template library (contracts, clinical notes, financial filings, HR, research papers, technical manuals) | `samples/templates/`, `server/services/templates.ts`, New project dialog |
| A6 RDF/XML and JSON-LD import (Oxigraph), alignment with retrieve-then-verify | `server/services/rdfConvert.ts`, `server/services/alignment.ts`, review panel |

**Open:** the sidecar's unit tests pass but it has not been run against real
Docling (the image is several GB).

## Phase 5 — scale and cost ✅

| Item | Where |
|---|---|
| B7 background worker (local and Postgres stores) and parallel chunk steps | `server/worker.ts`, `WorkerAccess` in `server/store/types.ts`, `PARALLEL_STEPS` |
| B9 estimate before a run, per-run and per-project budgets, relevance screen, result cache keyed by chunk + T-Box + model + prompt version | `estimateRun`, cache helpers and `relevant` in `runs.ts`, `server/services/pricing.ts` |

## Phase 6 — assistant and versioning ✅

| Item | Where |
|---|---|
| B8 routed retrieval: hybrid passages (BM25 + dense, RRF), Personalized PageRank for multi-hop, iterative Text2SPARQL with repair for aggregates | `server/services/assistant.ts` |
| Oxigraph stores per revision in an LRU on a worker thread; runaway queries are cancelled | `server/services/sparqlPool.ts` |
| B5 T-Box and A-Box versioned separately (hashes, derived version numbers, scope per revision); renamed terms migrate individuals, removed ones are flagged | `withVersions` in `server/services/revisions.ts`, `server/services/migration.ts` |

## Verification

`npm run check`: typecheck, lint and the test suite — 272 tests before the
update, 323 after, including `tests/quality.test.ts` (unit level),
`tests/phases.test.ts` (each phase over HTTP with the mock model) and
`tests/eval.test.ts`. `npm run eval -- --provider mock` exercises the harness end
to end. The Docling serializer has its own `python -m unittest` suite.

## Still open

- Review and extend the gold set, then run the harness with a real model and
  use its gates to decide when each phase is done.
- The public edition uses a local single-user workspace. Background extraction
  requires the local process to remain running.
- Graph store: stays RDF (Oxigraph) as recommended.
- First live run of the local transformers.js models (downloaded on first use)
  and of the Docling image.
