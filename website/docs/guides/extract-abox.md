---
title: Extract ABox
---

A corpus is a separate collection of documents and a knowledge graph that uses a saved version of your ontology. Its files are separate from the sources used to build the ontology and from other corpora.

## Create a knowledge graph

Save an ontology and open **Knowledge graphs** in the project sidebar. Choose **New knowledge graph**, enter a name, select a saved ontology version and an enabled extraction model, then choose **Create knowledge graph**. A new graph workspace starts with no documents or facts.

Use **Knowledge graphs** or the **Selected graph** picker in the sidebar to switch workspaces. The graph navigation includes **Documents**, **Extract & review**, **Explore**, **Validation**, **Versions** and **Graph settings**. The selected ontology is pinned until you explicitly upgrade it.

## Add and prepare sources

Upload corpus files. Parsing and token-aware chunk preparation start automatically. Inspect the original file, extracted text and chunks before extraction. The corpus settings contain the embedding model, generation model and separate token budgets.

Click a document’s filename to inspect it. Each row shows its status, version and chunk count; expand **Details** for preparation settings and source history. The **•••** document actions menu contains **Replace document** and **Remove document**.

Identical file contents are deduplicated even when the filenames differ. Use **Replace document** in the source’s actions menu to upload its next version. Previous file versions, chunks and evidence remain available for history. The saved graph stays available until you review and save the update.

## Review an extraction plan

After preparation, the Documents page summarizes new files, replacements, removals and unchanged documents to reuse, with the estimated cost when available. Choose **Create knowledge graph** for the first extraction, or **Update knowledge graph** for later changes. Normal updates process only new or changed sources and preserve existing entity identities and human decisions for identical facts. Explicit reprocessing and full rebuilds remain under **Advanced processing**.

Starting extraction creates a draft. The published graph remains available while it runs. You can pause, resume or retry an interrupted run and reopen its saved stages through extraction history.

## Review and save the graph

Review opens on changed facts grouped by entity; unchanged facts stay out of the default list. Inspect new facts, added or reduced source support, changed review decisions, updated values, schema conflicts and unresolved relationships. Replaced values show the previous and proposed values with their source evidence. **Use proposed value** accepts the new assertion and confirms loss of the old source contribution together. **Keep previous as manual knowledge** retains the old assertion and any missing relationship target explicitly without claiming support from the replacement document.

Open a fact's source passage to inspect the immutable text snapshot used by that extraction. A located quote confirms the text was found; it does not establish that the claim is correct. **Accept supported changes** groups new assertions with located evidence, an entailment score of at least 0.8 and no reported validation findings or conflicts; other claims still need individual decisions. These scores are model estimates, not calibrated probabilities.

Accept or reject facts, correct entities, review possible duplicates, and resolve missing relationship targets. User identity decisions and manual corrections survive later updates. Only accepted facts enter corpus graph answers, queries and RDF exports.

Validate the draft and **Save knowledge graph** or **Save graph update**. Each save creates a graph version scoped to this corpus; earlier versions stay available in **Versions**. Use its knowledge graph, table, graph answers and download tools to explore the result. Add documents later and repeat the same update workflow.

## Update or remove a source

Removing a source prepares a graph update. Facts with independent support survive; facts losing their only source need a decision to remove them or retain them as manual knowledge. Historical files remain available for inspecting old graph versions.

**Versions** supports comparison, downloading and restoration as a new graph version. Drafts based on earlier versions remain accessible there; prepare an update against the current version before saving them. Changing the pinned ontology is an explicit draft update. A corpus backup includes its ontology package and source history without including sibling corpora.

Provider availability depends on server configuration. Extraction makes provider requests after you start it; document parsing and chunk preparation do not generate ontology or graph claims.

## Larger corpora

Corpora allow up to 1,000 source documents by default (`MAX_SOURCES_PER_CORPUS`). Replacements and preparation variants retain their source slot. The document list supports search and pages of 25. The default per-user storage quota is 10 GiB; configure `STORAGE_QUOTA_BYTES` for the expected originals, extracted text and saved history. The per-file upload limit still applies.

Uploads are sent sequentially, parsing uses a persistent queue, and extraction saves checkpoints after bounded steps. Each model request contains bounded document context rather than the entire corpus. Enable `WORKER=1` to continue extraction without an open browser tab; interrupted runs resume from their saved checkpoints. This does not guarantee a particular throughput for a given model or document size.

The default request context budget is **100,000 tokens for every model**. It includes the input and reserved output; it is separate from the document chunk size. Edit **Context limit** when a different allowance is needed, or use **Reset to default** to restore 100,000. Changing the model keeps your edited limit. Saved configurations remain available for reproducible experiments.

The application respects the saved limit and does not increase it automatically. Requests exceeding it report a limit error; reduce request context or configure a larger budget within the model’s supported capacity. A named Codex model’s reported effective capacity is shown separately as a reference and checked before inference. A 100,000-token planning budget does not increase a model’s actual context window.
