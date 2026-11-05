---
title: "Align & merge"
description: "Compare ontology modules, review mappings and save an aligned ontology."
---

Open **Ontology → Align & merge** to connect your ontology with a standard or compare imported ontologies. You can also enter from the Ontology overview. The output preserves the source modules and adds an `alignment.ttl` bridge containing accepted mappings.

## Choose the comparison

1. Open **Align & merge**. Choose an ontology version or an existing draft, or import files in a [supported format](../reference/formats.md).
2. At **Inspect terms**, check classes, properties, definitions and parse errors. Referenced imports are not fetched automatically.
3. At **Find matches**, assign modules to the **Source**, **Target** or **Exclude** group. The source and target must be disjoint.
4. Choose matching methods and, optionally, a model to classify candidate relations. The groups, methods, model selection and source coverage are saved to the draft as you change them. Reloading restores the saved setup.
5. Review the comparison plan and choose **Find matches**. The saved run shows its progress; when it finishes, choose **Review mappings** to open the result draft.

The revision picker lets you return to a saved alignment draft. Changing a committed current version creates a separate draft; the saved version is unchanged.

## Understand coverage

The default limit is 150 source terms. The plan shows how many terms will be processed and warns when the comparison is partial. Choose a larger limit or **Every source term** to include the whole source ontology. Full comparisons can take longer, especially with model classification. Before starting, the plan estimates candidate pairs, model calls, token usage and generation cost using the same pricing configuration as TBOX and ABOX runs. Unknown model prices stay unknown; subscription-backed models are not presented as free API usage. Embedding API charges and retry costs are excluded and identified separately. Estimates are planning allowances, not spending guarantees.

**Last comparison coverage** distinguishes terms that were not processed, processed terms without a retrieved candidate, terms whose candidates the model classified as unrelated, and terms with candidates to review. No retrieved candidate does not prove that no valid mapping exists. Older comparisons may have counts without per-term coverage; rerun to capture it.

Retrieval compares compatible term kinds, keeps up to two candidates per source and proposes the best candidate for each source/relation. Object properties are not matched to datatype properties.

## Background execution, pause and resume

Each run freezes the selected ontology inputs, settings and existing human decisions. It checkpoints candidate retrieval, each model-classification batch (up to 20 pairs), and the result draft. After retrieval, progress updates to the actual number of classification batches.

With a background worker, the run continues when you leave the page or close the browser tab. The server or desktop app must remain running. Without a worker, the UI says to keep the project tab open and offers **Continue processing** after reopening. A server operator can enable the shared worker with `WORKER=1`; the desktop app starts it automatically.

**Pause** is saved on the server. An in-flight step can finish and save its checkpoint before the run stops; pausing does not retract a model request already sent. **Resume** continues with the next unsaved batch. **Cancel run** stops further processing, while **Retry from last checkpoint** can recover cancelled or failed runs. A failed or interrupted model request without a checkpoint may be billed again on retry. Finished batches are not deliberately repeated. **Run history** restores previous progress and results after reloading.

Results go into a separate review draft. The original draft and edits made after starting remain untouched; these later edits are not silently merged into the result. Starting again from the reviewed result includes its saved decisions. Generation usage and estimated spend appear beside progress, and the existing project budget checks apply. Unknown prices and embedding API charges cannot be included in these dollar budget checks.

The project’s **Activity** page includes alignment runs alongside builds and graph extractions. Filter by **Alignment** to see source-term coverage and saved progress. Open a paused run to resume it, or a completed run to review its own result draft. The sidebar keeps paused work accessible, and the Ontology overview links to the latest unfinished alignment. Choosing a different run in **Run history** also selects that run’s source or result revision.


## Review mappings

Use the status filter and search to work through **Needs review**, **Accepted**, **Rejected**, **Deferred**, conflicts or changed inputs. These view choices are retained in the page URL.

Select a pair to inspect its terms side by side: definitions, module names, parents, children, property domains and ranges, and supported constraints. Read the relation as **source → target**. For example, “Electric motor is narrower than Motor” adds an `rdfs:subClassOf` statement from Electric motor to Motor.

- **Accept mapping** applies its statement to the draft bridge after the coherence check.
- **Reject** or **Defer** records the decision and removes any previously accepted statement for that mapping.
- **Return to review** reopens a decision and removes its statement from the bridge.
- **Correct relation or add a review note** saves a human correction for review. Accept the corrected mapping to apply it.
- **Undo last decision** reverses the most recent human action for that mapping, including its bridge change. Undo cannot restore acceptance against changed inputs; restored logical mappings are checked for coherence.
- Select multiple queue rows to accept, reject or defer them together.

Other retrieved targets appear under **Other retrieved targets**. Add an alternative to review or open its existing mapping. **Add a mapping manually** lets you select compatible terms from the last comparison, choose a relation and record a note. Adding a mapping does not accept it.

Similarity scores, model classification, human review and logical checking are separate signals. A high similarity score is not a calibrated probability. Uncorrected similarity suggestions add `skos:closeMatch`; related mappings add `skos:relatedMatch`. Neither asserts logical equivalence. Human-reviewed or model-classified equivalence and broader/narrower relations add logical axioms.

The coherence check holds back mappings that introduce newly unsatisfiable classes under the supported in-process reasoner. Read the affected classes and explanation before reconsidering the relation. A successful check does not establish semantic correctness or complete OWL coverage.

## Rerun without losing decisions

**Adjust comparison** returns to saved settings. **Run comparison again** retains reviewed mappings and manual corrections whose recorded ontology inputs are unchanged, even when retrieval no longer proposes them. Stable mapping identities prevent repeated acceptance from duplicating bridge statements.

When recorded modules change, a rerun returns affected decisions to review and removes their old accepted statements from the draft bridge. Mappings without a fresh candidate remain marked as stale when retained for review. Saving a version is blocked while accepted mappings still refer to changed inputs.

## Save and continue

At **Validate & save version**, inspect structure, constraints, logical consistency and saved competency queries. Save the aligned ontology, then choose **Create knowledge graph** to create a graph workspace pinned to that version. You can also open or download the ontology.

**Inspect comparison history** changes the read-only technical trace; it does not replace current human decisions. Expand **Recorded matcher scores** or **Research trace** for exact inputs, settings and candidate scores. **Export comparison & review history** downloads the setup, comparison records, current mappings and human decision audit.
