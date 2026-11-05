---
title: "Methods and limitations"
description: "Understand the implemented pipeline and the boundaries of its measurements."
---

OntoLab exposes the methods used by each workflow. These pages describe implementation behavior; they are not a claim that every stage has been validated against an independent benchmark.

## Preprocessing and induction

Native or optional Docling parsing produces text with available sections, pages and tables. Chunking uses paragraph, section or fixed-character boundaries with overlap. These chunking strategies do not use cosine similarity to choose every boundary.

Induction can group topics, propose classes, consolidate terms, generate relations and supported axioms, retrieve reusable vocabulary and scan modelling pitfalls. Inspect sampled passages and intermediate artifacts to see what a run used.

## Extraction

Each extraction step can use a document summary, section context, a retrieved part of the schema and existing individuals. A relevance screen can skip inputs, and cache hits can reuse earlier outputs. Schema retrieval uses scored candidates plus supported ancestor/domain/range closure.

## Resolution and evidence

Entity-resolution candidates combine available lexical, semantic and grounding signals. Ambiguous pairs can be reviewed by a model and then a person. Quote location verifies whether supporting text can be found. NLI or a lexical fallback estimates support for the verbalized claim.

## Interpret numerical tables

Recorded cosine scores, relevance values, thresholds and merge comparisons explain decisions. They are not calibrated confidence or accuracy values. An uncomputed field must not be treated as zero. A configured embedding model can fall back; use the recorded actual backend.

Run score tables retain up to 2,000 rows per operation/group and display evaluated totals when capped. Alignment tables show retrieved candidates rather than the full Cartesian product.

## Reproducibility boundaries

Provider output can vary. Verbatim model prompts/responses are not captured by the existing inspection records. Provider-based NLI usage is not included in the existing token counters. Historical records can lack inputs or measurements added later. See [experiment inspection](./experiments.md) and [evaluation](./evaluation.md).
