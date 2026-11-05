# Sources and research basis

Checked on 2026-11-03. Repository behavior is tied to commit `6b63afdab5c0ad70c5ab6be95018e576c9d256b5`. Provider documentation and upstream
model/runtime behavior can change; freeze actual versions and capability records at implementation/evaluation time.

## OntoLab implementation

| Source                                                                                                                                              | Relevant behavior                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [README](../../README.md)                                                                                                                           | Product workflow: requirements, ontology, evidence-backed extraction, review and saved graph revisions. |
| [Extraction](../../server/extract.ts), [schemas](../../server/schemas.ts), [conformance](../../server/validation.ts)                                | Current structured A-Box extraction against allowed ontology vocabulary.                                |
| [Run service](../../server/services/runs.ts), [run types](../../src/types/project.ts), [worker](../../server/worker.ts)                             | Configuration, steps, leases, checkpoints, cache, budgets and advancement.                              |
| [Schema retrieval](../../server/services/schemaRetrieval.ts)                                                                                        | Term definitions, relevance shortlist and class/property context.                                       |
| [Evidence](../../server/services/evidence.ts), [verification](../../server/services/verification.ts), [NLI](../../server/ml/nli.ts)                 | Quote location, verbalized claims, local/provider/lexical scores and fallback behavior.                 |
| [Research inputs](../../server/services/research.ts), [corpora](../../server/services/corpora.ts)                                                   | Input snapshots, historical evidence and source-processing fingerprints.                                |
| [Fact review](../../src/lib/ontology/factReview.ts), [A-Box types](../../src/types/abox.ts)                                                         | Separate evidence, scores, review decisions and per-fact provenance.                                    |
| [Structured calls](../../server/structured.ts), [CLI guide](../LOCAL_CLI_PROVIDERS.md), [CLI catalog](../../server/cli/catalog.ts)                  | Existing API/CLI dispatch, local access and isolation constraints.                                      |
| [Evaluation harness](../../eval/harness.ts), [metrics](../../eval/metrics.ts), [research metrics](../../eval/research.ts), [CLI](../../eval/run.ts) | Current quality/calibration outputs, source gold limitations and live-run acknowledgement.              |
| [Quality guidance](../../website/docs/research/evaluation.md)                                                                                       | Structural conformance, source support and factual accuracy are separate measurements.                  |

## JEV primary documentation

- [System One API](https://docs.typesafe.ai/api/system-one): state plus typed questions and correlated answers. Supports the hosted adapter
  boundary, not an extraction accuracy claim.
- [Models](https://docs.typesafe.ai/models): current model IDs, model/context policy and versioning. Pin resolved identities rather than
  relying on moving aliases.
- [Confidence](https://docs.typesafe.ai/confidence): native probability/confidence meanings. Thresholds require target-task validation.
- [Request rules and errors](https://docs.typesafe.ai/api/errors): input validation and operational error classes.
- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): candidate spans selected by a
  decision model and normalized in code.
- [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade): generative extraction, per-field JEV checking and selective escalation.
  This is a vendor implementation cookbook, not an independent validation of OntoLab.
- [Knowledge graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment): candidate-pair assessment and review routing.
  Entity alignment is a different task from full graph extraction.

## LAYA upstream sources

- [Author repository](https://github.com/NandhaKishorM/laya): upstream runtime and version history. It is the source of the optional local
  service, rather than an independently branded hosted endpoint.
- [Model card](https://huggingface.co/convaiinnovations/laya): checkpoint families and task-transfer/context/calibration limitations.
  Published benchmark rows do not establish performance on OntoLab ontologies.
- [HTTP API](https://nandhakishorm.github.io/laya/http-api/): served payloads, native confidence fields, actual checkpoint routing and
  input-coverage diagnostics. Preserve those distinctions in the adapter.
- [Schema-driven decisions](https://nandhakishorm.github.io/laya/structured/): supported finite-field schema subset and rejections. It does
  not directly implement arbitrary A-Box JSON generation.
- [Benchmarks and known limits](https://nandhakishorm.github.io/laya/benchmarks/): target-task, runtime and calibration qualification. Use
  controlled paired measurements for provider comparisons.
- [Checkpoint integrity](https://nandhakishorm.github.io/laya/security/): deployment artifact verification considerations. Freeze actual
  model/runtime artifacts before live use.

## Published research and its applicability

| Work                                                                                                                                                           | What it supports                                                                                       | Boundary for this plan                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Sainz et al., Label Verbalization and Entailment, EMNLP 2021](https://aclanthology.org/2021.emnlp-main.92/)                                                   | Relation extraction can be formulated as source/hypothesis entailment with verbalized relation labels. | Does not validate JEV/LAYA, arbitrary OWL semantics or the complete fallback workflow.                                                                                 |
| [Zhang and Soh, Extract Define Canonicalize, EMNLP 2024](https://aclanthology.org/2024.emnlp-main.548/)                                                        | Schema-aware graph extraction and retrieval of relevant schema elements.                               | Candidate extraction, definition and canonicalization are not identical to a direct decision-model extractor.                                                          |
| [Aggarwal et al., AutoMix, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/hash/ecda225cb187b40ea8edc1f46b03ffda-Abstract-Conference.html) | Reliability signals can guide selective escalation to larger models.                                   | Its general-task results do not transfer automatically to per-fact ontology extraction or CLI/API deployment.                                                          |
| [Dalal and McGinty, PERSEUS, ESWC workshop 2026](https://ceur-ws.org/Vol-4246/llms4kgoe-5.pdf)                                                                 | Source-grounded candidate verification through retrieval and lexical/NLI checks.                       | The reported precision gain comes with lower recall/F1. It motivates measuring recovery of valid facts rather than claiming that filtering always improves extraction. |
| [Tiwari et al., Ontology-Aware Prompting for Knowledge Graph Construction from Text, 2026](https://journals.sagepub.com/doi/10.3233/SSW260009)                 | Ontology-guided candidate generation with evidence-oriented post-generation filtering.                 | Its rule-based validator is not full OWL reasoning or a JEV/LAYA uncertainty cascade.                                                                                  |
| [Mihindukulasooriya et al., Text2KGBench, ISWC 2023](https://arxiv.org/abs/2308.02357)                                                                         | Public ontology-driven extraction tasks and metrics for facts, conformance and hallucination.          | Check labels, provenance, exposure and normalization before using benchmark scores as a deployment gate.                                                               |
| [Zaratiana et al., GLiNER, NAACL 2024](https://aclanthology.org/2024.naacl-long.300/)                                                                          | Compact entity extraction with supplied labels is a possible candidate-generation comparison.          | It does not establish event/value/relation completeness or replace target-domain evaluation.                                                                           |
| [Boylan et al., GLiREL, NAACL 2025](https://aclanthology.org/2025.naacl-long.418/)                                                                             | Zero-shot relation classification over entity candidates provides another future specialist baseline.  | It does not establish an end-to-end fact graph or automatic acceptance policy.                                                                                         |

## Exploratory precedent

[Dagfinn Dybvig's Jev Ontology project](https://github.com/dagfinndybvig/Jev_Ontology) explores classification against ontology definitions
and LLM-driven ontology revision. The project labels its root experiments exploratory and distinguishes confidence changes from
generalization evidence. It is useful implementation context; this plan keeps the approved ontology fixed during extraction and evaluates
fallback on facts separately.

## Evidence status

The architecture is a proposed synthesis of existing OntoLab facilities, provider contracts and related research. The planned A-series
provides the direct evidence needed to select JEV, a particular LAYA deployment, a cascade policy or continued use of the current pipeline.
No referenced source establishes that this exact combination will improve OntoLab's final fact quality, cost or review workload.
