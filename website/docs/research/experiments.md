---
title: "Inspect and compare experiments"
description: "Read recorded inputs, intermediate artifacts and numerical results without mixing run contexts."
---

Open **Method, parameters & research details** in a workflow. Use **Activity** to find a run and open its recorded diagnostics; select a saved run through **Experiment** where available before comparing results.

## Read a historical run

Inspect the recorded source documents, parsed text, chunks, requirements, schema revision, configuration and intermediate/final outputs. New runs keep preprocessing snapshots so later document edits do not silently replace historical inputs. Older runs explicitly mark missing metadata.

The final checkpoint is independent of later edits to its resulting draft. Use that checkpoint when comparing the model’s assembled output with a subsequent manual revision.

## Compare chunking

Choose **Documents & chunking** to preview paragraph packing, section-aware packing and a fixed-character baseline. Set the base size and overlap, inspect the exact chunk text and export statistics. Base size excludes appended overlap. Offsets use JavaScript UTF-16 code units, not token counts.

Save variants and select the variant instead of its original source. Keep the source, parser and model constant if the comparison is intended to isolate chunking.

## Inspect the pipeline

The **T-Box pipeline** shows topic membership, sampled passages, consolidation, relations, axioms, reuse and pitfalls. The **A-Box pipeline** shows summaries, chunk extractions, screening, schema selection, grounding, duplicate comparisons and evidence results.

Use **Cached extraction results → Recompute with fresh measurements** when you need new extraction calls and screening/retrieval measurements. This can incur provider usage. Cache reuse and fresh measurements should not be interpreted as the same experiment.

## Preserve an experiment

Use **Export research record** to preserve run snapshots/checkpoints. A normal project archive does not retain run history. Record the document hashes, selected variants, base revision, actual backend, model, options, thresholds and any missing measurements alongside your comparison.
