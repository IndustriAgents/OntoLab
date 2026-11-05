# Current extraction pipeline and integration points

Code inspected at `6b63afdab5c0ad70c5ab6be95018e576c9d256b5`. This is a code-level baseline, not a measurement from a live model run.
Changes after this commit require refreshing the baseline manifest before comparing results.

## Existing processing path

```text
Upload and parse -> prepare chunks -> select saved ontology
  -> create run and input snapshot
  -> document summary and optional relevance screening
  -> full or retrieved ontology schema
  -> structured LLM extraction
  -> conformance and source quote location
  -> entity resolution and optional grounding
  -> claim/evidence verification
  -> fact review, validation and graph draft
  -> explicit commit
```

The existing system is already ontology constrained. The proposed integration changes who makes selected semantic decisions and when to
request another extraction pass; it does not introduce ontology constraints, evidence or run recovery for the first time.

## Verified implementation map

| Concern                                          | Existing implementation                                                                                                                                                                                          | Reuse in the integration                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Original bytes, parse state, processing versions | [documents.ts](../../server/services/documents.ts), [parsing.ts](../../server/services/parsing.ts), [structuredText.ts](../../server/services/structuredText.ts), [xmlText.ts](../../server/services/xmlText.ts) | Preserve file identity, text offsets, sections, tables and source paths.                                  |
| Character and token chunking                     | [chunking.ts](../../server/services/chunking.ts), [tokenChunking.ts](../../server/services/tokenChunking.ts), [research.ts](../../server/services/research.ts)                                                   | Reuse existing variants; build small decision windows without rewriting source text or historical chunks. |
| Ontology-constrained output                      | [schemas.ts](../../server/schemas.ts): `buildExtractSchema`, `individualSchema`                                                                                                                                  | Continue restricting emitted class/property URIs and validating output.                                   |
| Generative extraction                            | [extract.ts](../../server/extract.ts): `extractABox`                                                                                                                                                             | Primary proposer and structured fallback entry point.                                                     |
| Provider calls                                   | [structured.ts](../../server/structured.ts): `callStructured`                                                                                                                                                    | Existing structured API/CLI dispatch and truncation handling.                                             |
| CLI discovery and execution                      | [catalog.ts](../../server/cli/catalog.ts), [invoke.ts](../../server/cli/invoke.ts), [Local CLI providers](../LOCAL_CLI_PROVIDERS.md)                                                                             | Reuse allowlisted models, isolated processes, cancellation, queueing and environment filtering.           |
| Schema retrieval                                 | [schemaRetrieval.ts](../../server/services/schemaRetrieval.ts): `retrieveSchema`, `scoreTermsDetailed`                                                                                                           | Supply term shortlists, ancestor context and property domain/range context.                               |
| Extraction conformance                           | [validation.ts](../../server/validation.ts): `conformAbox`                                                                                                                                                       | Validate model results and preserve unmatched concepts separately.                                        |
| Source quote verification                        | [evidence.ts](../../server/services/evidence.ts)                                                                                                                                                                 | Locate exact evidence before using a confidence score for acceptance.                                     |
| Claim verification                               | [verification.ts](../../server/services/verification.ts): `verifyAbox`, verbalization helpers                                                                                                                    | Reuse the per-assertion boundary, while retaining ontology definitions in the new decision contract.      |
| Existing NLI backends                            | [nli.ts](../../server/ml/nli.ts)                                                                                                                                                                                 | Baseline local/provider/lexical behavior and a small adapter seam for support assessment.                 |
| Entity resolution                                | [resolution.ts](../../server/services/resolution.ts)                                                                                                                                                             | Keep existing IDs and merge decisions; do not treat a relation assessment as permission to merge.         |
| Run planning and execution                       | [runs.ts](../../server/services/runs.ts)                                                                                                                                                                         | Reuse start/estimate/advance, leases, checkpoints, cancellation, pause and resume.                        |
| Background advancement                           | [worker.ts](../../server/worker.ts)                                                                                                                                                                              | Use the same advancement logic as browser-driven runs.                                                    |
| Frozen experiment inputs                         | [research.ts](../../server/services/research.ts): `snapshotRunInputs`, `runResearch`                                                                                                                             | Extend snapshots and traces with decision/fallback identities.                                            |
| Corpus update identity and evidence              | [corpora.ts](../../server/services/corpora.ts): `corpusSourceFingerprint`, `evidenceSnapshot`                                                                                                                    | Include the new extraction contract in source fingerprints and use historical evidence.                   |
| Review and validation                            | [factReview.ts](../../src/lib/ontology/factReview.ts), [validation.ts](../../server/services/validation.ts), [revisions.ts](../../server/services/revisions.ts)                                                  | Preserve human decisions, review policy and immutable commits.                                            |
| Evaluation                                       | [harness.ts](../../eval/harness.ts), [metrics.ts](../../eval/metrics.ts), [research.ts](../../eval/research.ts), [run.ts](../../eval/run.ts)                                                                     | Extend current extraction, evidence, calibration and cost reports.                                        |

## What the current extractor emits

`extractABox` builds a schema from the selected T-Box and invokes the selected structured provider. Its result passes through `conformAbox`.
Individuals carry a class URI, optional literal properties and object-property links, and source evidence. Known individuals from previous
work are offered for identity reuse.

`individualSchema` offers one primary `classUri`. It deliberately does not expose `additionalTypes` in the generative schema, although the
data model supports additional types. The new decision lane must distinguish primary-type selection, additional compatible types and
reasoner-derived superclass membership. A new primary metric must not reward a new multi-typing behavior that the baseline cannot emit
without a separately labelled comparison.

The run's extraction call currently sets `proposeTerms: true`. This supports the existing ontology-improvement loop. Known-ontology
integration should add an explicit frozen policy that can suppress proposals from the extraction result while retaining uncovered concepts
for review. Compare both the unchanged current behavior and a matched fixed-vocabulary control; do not silently redefine the baseline.

## What verification currently means

`verifyAbox` verbalizes type, data-property and object-property assertions, then assesses each quoted claim. A located quote can receive a
context window from the document. Verification and source location are different checks: a quote may occur in the source without supporting
the asserted relation.

The existing `NliScorer` interface returns one numeric score per premise/hypothesis pair. Implementations include a local classifier, a
provider judge and a lexical scorer. Local-model loading can fall back to lexical scoring. The provider judge maps discrete verdicts to
fixed numeric values. These scores are not interchangeable with a JEV Choice confidence or a LAYA confidence field.

The integration can start with a support-scoring adapter, but the full contract needs more information than `NliPair`: ontology definitions,
candidate identity, qualifiers, raw decision distributions, model identity, truncation facts and usage. Do not squeeze those fields into the
current scalar and discard them.

## Existing capabilities to preserve

- Project/corpus ownership and source membership.
- SHA-256 source identity and separate processing/chunk variants.
- Existing ontology revisions, source snapshots and evidence links.
- Incremental runs, preserved human edits, suppressed facts and explicit merge decisions.
- Insert-once checkpoints and per-run leases across browser and worker advancement.
- Pause/cancel semantics, bounded transient retries and visible failures.
- Conformance, SHACL/reasoning where configured, competency queries, review and explicit commit.
- API providers and locally permitted CLI providers through the same structured-call layer.

## Baseline limitations that affect the experiment

| Observation from current code                                                                                                                                   | Required experiment control or planned change                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunConfig` records configured extraction/NLI settings, while runtime local NLI can fall back to lexical scoring.                                               | Record the effective scorer/backend for every measured call. Report degradation and rerun controlled captures if an arm changes backend.                                                |
| The verification step reads the project's current NLI choice and document text at execution time.                                                               | Freeze the evaluation environment and supply immutable text for new decision lanes. For historical records, never claim recorded settings alone prove all effective inputs were frozen. |
| `verifyAbox` skips evidence that already has a confidence and limits scored jobs.                                                                               | Use a separate assessment identity and explicit completeness count. A new provider comparison must not reuse an old provider's score or treat unscored claims as assessed.              |
| Verification checkpoints explicitly note that provider-NLI token usage is not included in their token counters.                                                 | Mark baseline cost incomplete unless independent usage capture fills the gap. Never claim savings against an undercounted baseline.                                                     |
| Extraction cache identity includes prompt/options, provider/model, T-Box, embedder and chunk text/context, but not a future candidate/compiler/router contract. | Introduce separate versioned identities for candidate generation, decisions, fallback and final assembly.                                                                               |
| `corpusSourceFingerprint` has no decision-engine or fallback policy identity.                                                                                   | Add those identities for the new lane so changed decision settings mark the right sources for reprocessing.                                                                             |
| `extractABox` depends on context and known individuals, while the current extraction-cache key does not enumerate those inputs separately.                      | Hash the complete effective context/known-identity scope for new cached work; preserve the unchanged current arm and record cache state explicitly.                                     |
| The evaluation harness includes seed gold data drafted with AI assistance.                                                                                      | Use it for plumbing checks; obtain independent reviewed labels and grouped held-out documents for quality claims.                                                                       |
| Existing matching uses name similarity and literal normalization.                                                                                               | Keep legacy metrics, and add strict evidence-aware metrics so a wrong unit, scope or homonymous entity is not hidden by normalization.                                                  |
| Existing calibration reports operate on scored predicted claims.                                                                                                | Add missed-gold, candidate-recall and abstention metrics; confidence filtering alone must not make omissions disappear.                                                                 |

These are integration/evaluation work items, not corrections included in this documentation-only change. Changes needed to improve baseline
measurement must be separated from semantic changes to baseline extraction.

## Provider and user interface boundaries

The current configured `provider`/`model` identifies the run's generative model. Proposed settings must make three roles explicit: proposer,
decision engine and fallback extractor. Existing API model IDs and CLI model selection remain governed by the provider catalog.

CLI execution occurs on the backend machine under existing local visibility and isolation rules. A decision-engine failure must not make a
normally unavailable CLI accessible. Vision/PDF image input remains subject to the selected generative provider's capabilities; current CLI
providers consume parsed text.

The first UI extension belongs in extraction options, run diagnostics and the existing review queue. It does not require new top-level
navigation. Show the selected ontology, decision engine, fallback model and bounded budget before start; show actual decisions and routing
reasons after execution.
