---
title: "Evaluate quality"
description: "Separate answerability, structural conformance and measured accuracy."
---

A successful run is not an accuracy evaluation. A graph with no validation errors can still contain unsupported claims or miss required facts.

Source builds with **Evaluate** can compare the current Ask engine on two saved graph versions, review source evidence and save reports. This is an exploratory graph-only check with explicit expected answers. See [Compare graph answers](../guides/evaluate.md) for the workspace flow.

## Choose the question you are measuring

| Measurement | Requires | Does not establish |
| --- | --- | --- |
| Structural/SHACL conformance | Schema and data graph | Real-world factual correctness |
| Competency-query answer rate | Approved questions and inspected queries | Completeness or precision against a gold set |
| Extraction precision/recall | Reviewed expected facts | Quality outside the evaluated sample |
| Quote verification share | Source text and located quotations | That every claim follows from its quote |
| Entailment agreement | Reviewed claim/evidence labels | Calibrated probability of truth |
| Cost and latency | Recorded calls and provider accounting | A complete invoice from partial counters |

## Use the evaluation harness

Developers can run the repository’s `eval/` harness. It includes seed datasets for contracts, clinical notes and technical manuals, with ontology, extraction, evidence, resolution, answering and cost measurements.

```bash
npm run eval -- --provider mock
```

This is a harness smoke test. For a real evaluation, select a configured provider/model and review the cost acknowledgement options shown by the harness. Real runs can incur charges. Outputs are saved under `eval/results/`.

:::warning Review the gold data
The seed gold set was drafted by AI and requires human review before its numbers can be treated as trusted evaluation evidence. Do not report mock-mode scores as real-model accuracy.
:::

## Make a defensible comparison

Use held-out documents, inspect gold labels, keep inputs/options documented, and report missing or capped measurements. Compare cached and fresh calls deliberately. Report domain, sample size, model, actual retrieval/NLI backends and known limitations together with any score.
