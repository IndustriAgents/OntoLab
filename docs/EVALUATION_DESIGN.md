# Evaluation workflow for OntoLab

Design proposal · 3 November 2026 · OntoLab `6b63afd`

Add **Evaluate** to each knowledge graph so users can answer: “Did this update improve the answers I care about, and what evidence explains the difference?” Use results, source review, reusable judgments and immutable reports within OntoLab’s existing React and Node architecture.

The first release should compare saved graph versions using approved competency questions and the **current Ask engine**. Add retrieval experiments once search can read the exact source snapshots pinned by those versions. Extraction and ontology benchmarks can follow through the same workspace.

Phase 1 is now implemented in this worktree: graph-only answer comparisons through the current Ask execution function, source review and saved report versions. See [Graph answer comparisons](EVALUATIONS.md) for behavior, limits and verification. The later retrieval, held-out and extraction slices below remain proposals. The interface concept uses illustrative records; it is not benchmark evidence.

## What exists today

| Area | Verified implementation | Integration implication |
| --- | --- | --- |
| OntoLab evaluation | `eval/harness.ts` runs ontology, extraction, evidence, resolution and assistant measurements over synthetic gold domains in isolated local projects. | Reuse metric functions and adapters; the CLI harness is not a production project evaluation service. |
| OntoLab Ask | The UI streams `/assistant/chat` through `graphChat.prepareChat`. The harness assistant stage calls the older `assistant.ask`. | Add a shared current-engine execution interface before presenting product answer-quality scores. |
| OntoLab revision evidence | `CorpusGraphState.sources` records source checksums, fingerprints and extraction run IDs. `evidenceSnapshot()` serves retained extraction text. | An evaluation can pin source versions independently of current documents. |
| OntoLab search | `hybridPassages()` combines keyword and dense rankings over stored document chunks; corpus graph-chat currently disables document search. | Snapshot retrieval is new work. Do not present dense/sparse/hybrid comparisons as available today. |
| OntoLab inspection and jobs | Research workspace, shared evidence viewer, store interfaces, processing leases, checkpoints and project Activity already exist. | Extend these foundations and expose evaluation activity in the same product shell. |

Sources: [OntoLab harness](../eval/harness.ts), [metrics](../eval/metrics.ts), [current Ask routes](../server/app.ts), [graph chat](../server/services/graphChat.ts), [hybrid passages](../server/services/assistant.ts), [corpus identities](../src/types/corpus.ts), [retained evidence](../server/services/corpora.ts), [evidence viewer](../src/features/evidence/useEvidence.tsx), [store contracts](../server/store/types.ts).

## Product placement

Use `/p/:graphId/evaluate` for a native graph, with stable links containing evaluation, attempt, question and report IDs. Add **Evaluate** beside Explore and Validation in `src/app/navigation.ts`; update navigation selection and graph switching together so switching graphs clears another graph’s evaluation IDs.

Keep these purposes distinct in the interface:

- **Validation:** schema constraints, graph consistency and competency-query execution.
- **Evaluate:** reviewed quality on a declared set of examples, and comparison with a baseline.
- **Research:** parser, chunk, prompt and stage inspection, linked from the relevant failure.
- **Activity:** durable progress across all project work, linking back to the evaluation.

Inside Evaluate, use **Results · Review · Reports**, with questions in the **Setup** disclosure and attempt history under Reports. Put technical settings and reproducibility details in expandable sections. Show the selected graph version, question-set version, baseline and report state persistently. Opening a saved result never starts model calls.

Two entry points should complement the workspace: **Add to evaluation** on an Ask exchange, and **Compare answers with this version** in graph version history. Both open a short editable setup. An existing answer or an approved graph fact is a candidate example, not an independent gold label.

For connected external graphs, expose a capability explanation until immutable graph snapshots or backend-supported versions exist. Do not label a mutable remote endpoint as a reproducible graph revision.

## The primary user journey

1. **Choose the decision.** “Check this graph”, “Compare graph versions”, or, later, “Compare search settings”. Use task names instead of requiring a metric choice.
2. **Choose questions.** Offer approved competency questions, selected Ask questions, manual entry and CSV/JSON import. Let users edit expectations and supporting sources in normal forms. AI-authored suggestions retain an explicit draft origin until reviewed.
3. **Set the expectation.** Record required facts, acceptable answers, relevant source documents or expected query results, as appropriate. Competency questions alone do not define correct answers. Mark questions without reviewed expectations as exploratory.
4. **Review the comparison.** Show baseline/candidate versions, source scope, model, review policy, number of calls, cost estimate or “Unavailable”, and budget. Advanced options cover repetitions, cache policy and split protocol. Creating a definition does not run it.
5. **Run and leave.** Save progress after each question and arm. Show the active phase, completed/total cases, last heartbeat and cancel action. Reopening the app returns to the same attempt.
6. **Start with differences.** Show regressions, improvements, unchanged outcomes, unreviewed cases and errors separately. Select a question to inspect baseline and candidate answers, graph facts, tool/query traces and retained source evidence.
7. **Review the source.** Save a judgment with its reason and source anchor. “Skip” leaves the item unjudged. Saving progress and advancing to the next item should be one action; allow returning to prior items.
8. **Save a report.** Rescore saved captures without rerunning the model. Pin the judgment versions and export the report with evidence. An eligible report can become the baseline for the next comparison.

Offer a small quick check, such as 5–10 user-selected questions, for useful first-time feedback. Label it exploratory; it cannot establish broad accuracy or a reliable winner. Research mode adds declared development/held-out splits, grouped paraphrases and a freeze before held-out exposure. A report can be reviewed without being a fresh held-out result: these are separate properties.

## Results that lead to a next action

Lead with a concrete question such as “Which answers changed?” and a row for each case. Use plain-language outcomes with the technical metric available beside them. Preserve counts and denominators; never compress every stage into one “graph quality” percentage.

| Question | Useful measurement | Interpretation boundary |
| --- | --- | --- |
| Can the graph represent and query this requirement? | Schema answerability, query errors, nonempty results. | A nonempty result is not a correct or complete answer. |
| Did Ask answer correctly? | Reviewed correctness, required-fact coverage, appropriate abstention; exact expected results for suitable queries. | The existing substring answer matcher is a smoke-test heuristic, not sufficient product grading. |
| Does the answer have support? | Source location match, reviewed claim support and citation coverage, as separate fields. | A located quotation does not prove the claim follows from it. |
| Did retrieval find useful evidence? | Document nDCG@10, recall where the relevant set is sufficiently known, passage usefulness, document diversity. | Document grades cannot be reused as passage grades. Retrieval scoring requires the new snapshot service. |
| Did extraction improve? | Reviewed fact precision/recall, unsupported claims, missing expected facts and merge errors. | Recall requires an independently reviewed expected-fact set for the declared sample. |
| What did it cost? | Measured latency, errors, provider usage, reported/estimated cost and cache status. | Unknown cost is not zero; cached and fresh latency are different measurements. |

For retrieval, deduplicate by stable source identity before the cutoff and record empty result slots separately from unjudged hits. If provisional scoring uses zero gain for unjudged hits, disclose that convention without persisting a grade-zero label. A question with no judged relevant documents is “Not yet assessable”; do not present it as established failure. Any aggregate must declare how such questions are handled.

Compare arms on the same tasks and compatible judgments. For search/prompt experiments, hold source eligibility and graph inputs fixed and vary one declared setting. For graph-update checks, source and graph changes are part of the intervention: show them explicitly and avoid attributing the difference to the ranker or model. If a document update changes the correct answer, use expectations scoped to each arm and flag the changed truth rather than automatically calling the new answer a regression.

Show paired per-question differences before claiming an overall winner. Small samples, incomplete review and repeated use of exposed questions should remain visible. In research mode, predeclare the decision rule, uncertainty calculation and any multiple-comparison correction.

## Evidence review and label reuse

Use the existing `useEvidenceViewer()` and `DocumentViewer` to inspect retained sources, with an additional comparison panel for answer/fact/trace context. Avoid a separate source reader that behaves differently from Explore and Ask.

The comparison view may reveal baseline and candidate identities. The **independent review queue** hides system names, ranks, existing grades and model suggestions by default. Pool duplicate source targets across arms so one independent judgment can apply to all compatible results. Keep prior judgments available through an explicit reveal action and record that reveal when independent review matters.

Keep four target types distinct:

| Judgment target | Compatibility required for reuse |
| --- | --- |
| Source document relevance | Same authorized source identity/content and question semantics, rubric and eligibility scope. Chunk changes alone do not invalidate it. |
| Passage usefulness | Same passage text, source anchor and question/rubric. A different chunk needs separate assessment. |
| Extracted claim support | Same normalized claim, source evidence, relevant ontology semantics and rubric. |
| Answer correctness | Same question/expectation version, answer and evidence context, graph/source scope and rubric. A changed answer needs a new judgment. |

Store anchors as source/member identity, original checksum, parsed-text hash, structural locator when available, exact quote, offsets and the offset convention. Cross-language offsets need an explicit contract: Python code-point positions and JavaScript UTF-16 positions cannot be copied interchangeably. Revalidate anchors on read; show “Source unavailable” or “Mapping unavailable” with a repair action when validation fails. Never silently open current text in place of a missing historical source.

Label origin independently from the authenticated account: `human`, `agent` or `import`, with actor, model/version when applicable, timestamp and approval event. Model drafts may prioritize review but cannot create human-review records or satisfy a human-review gate. A user identity alone cannot prove that a person inspected a source.

## Proposed service and persistence design

```text
Evaluate UI ── evaluation API ── evaluation service ── owner-scoped repositories
                                     │
                              durable evaluation worker
                                     │
               ┌─────────────────────┴─────────────────────┐
        current Ask execution                       snapshot retrieval
        graph/query backends                        keyword / dense / hybrid
               │                                           │
        pinned revision content                  retained source/chunk manifests
               └─────────────────────┬─────────────────────┘
                              immutable captures
                                     │
                       judgments → scorer → report versions
```

**Current-engine execution.** Refactor graph chat’s turn execution into a callable service shared by `/assistant/chat` and evaluation. Keep streaming and conversation persistence as adapters around it. Evaluations must not pollute users’ conversation history. Persist answer, citations, source scope, queries, errors, truncation, tool limits, model identity, usage and relevant prompt/runtime versions. Retain the legacy harness stage under an explicit legacy identifier until migrated.

**Snapshot retrieval.** Resolve a selected corpus revision into its source records and their retained run-input blobs. Build an internal read interface that returns exact chunk text, metadata and source identity; `evidenceSnapshot()` is a useful reader-view precedent but strips chunk text in its response. Do not search mutable `documents.chunks()` for a historical graph. Pin draft content by hash or create an immutable evaluation snapshot before capture; a draft revision ID alone is insufficient.

Extract reusable ranking from `hybridPassages()` into a service accepting authorized snapshot scope, query, mode, candidate limits, result limits, filters and an immutable profile. Record the actual embedding backend and any fallback. Use this service in live graph-chat evidence search and retrieval evaluation. Begin with existing storage and ranking; add Qdrant or a reranking sidecar only when a measured experiment warrants it.

**Independent evaluation records.** Add typed repositories to `UserStore` and implementations for local and Postgres. Reuse lease/checkpoint patterns but give evaluations their own worker access and lifecycle; extraction `RunKind` and its step assumptions should not become a container for unrelated state. Extend Activity to aggregate evaluation attempts. Model-calling routes retain the existing LLM request controls.

| Proposed record | Contents |
| --- | --- |
| `EvaluationSuiteVersion` | Question/expectation/rubric versions, provenance, split assignments and protocol. Immutable after use. |
| `EvaluationDefinition` | Decision type, graph/source scopes, suite version, baseline/candidate settings and optional freeze manifest. Editing creates a new definition version. |
| `EvaluationAttempt` | Immutable input manifest; retry parent; durable progress, lease, checkpoints, cancellation and error state. |
| `EvaluationCapture` | Immutable output per question/arm, input/output hashes, runtime traces, usage and measurement context. |
| `EvaluationJudgment` | Target type, compatibility key, grade, reason, anchors, origin and append-only supersession. |
| `EvaluationReport` | Capture references, exact judgment snapshot, metric implementation version, coverage, scores, limitations and export checksums. |

Use compare-and-swap review saves to reject concurrent overwrites, bounded capture/review pagination, per-attempt idempotency, and atomic budget reservation across concurrent work. Exports and every source read enforce the owning graph/project authorization. Source retention and deletion should account for referenced snapshots; an authorized deletion may make evidence unavailable, which must be reflected in the report reader.

Attempt lifecycle: `queued → validating → running → awaiting_review → completed`, with cancellation, interruption and failure states. Review changes produce a new report version from the same capture. Retry creates a linked attempt, preserving the unsuccessful attempt. A resumed attempt reuses completed immutable question/arm checkpoints only when its manifest still matches. Generation, review and report-completeness states should remain independently visible.

Freeze pins graph and source manifests, suite, model/prompt/settings, metric implementation and judgment-library high-water mark. New held-out judgments may be appended under the declared protocol; final reports pin the exact set used. Code/input drift blocks a new frozen capture with an explanation; it does not prevent reading old reports. Once held-out outputs are exposed, tuning on them is exploratory and requires a fresh independent set for another held-out claim.

## Delivery sequence

| Slice | Deliverable | Acceptance |
| --- | --- | --- |
| 1 · Graph answer checks | Shared current-Ask execution, evaluation repositories/worker, saved-revision comparison, question/expectation editor, source review and immutable reports. | Compare two native saved graph versions; leave/reopen; inspect a changed answer; review its retained evidence; export; rescore without provider calls. Corpus graph answers accurately indicate their current graph-only capability. |
| 2 · Retrieval experiments | Snapshot resolver, versioned search profiles, shared live/eval retrieval and document-level scoring. | Current documents may change without changing an old capture. Dense/sparse/hybrid use identical source eligibility and judgment snapshots. New hits remain unjudged until reviewed. |
| 3 · Scientific comparisons | Declared splits, intent-group leakage controls, freeze, blinded pooling, uncertainty and explicit exposure history. | Drift blocks frozen execution; reused questions are labelled exploratory; review completion is independent of machine draft count. |
| 4 · Extraction and ontology quality | Adapters for existing metrics, reviewed expected-fact/ontology sets and failure links into Research. | Quality changes trace to reviewed cases; structural checks and factual accuracy remain separate. |

Prioritize one complete answer-check journey over launching all metric families together. The data contracts should support all four slices, while the first interface stays small. Graph-version regression is the best initial fit because OntoLab already has revisions, competency questions, graph chat and retained evidence; retrieval evaluation has an additional source-search dependency.

## Verification when implementing

- A captured answer uses the same engine/configuration as Ask, with evaluation conversation storage isolated.
- Replacing/rechunking a document, editing a draft, changing defaults or publishing a later label cannot alter an old capture/report.
- Question/rubric/source changes invalidate incompatible label reuse; unchanged document judgments survive rechunking.
- Unjudged, irrelevant, source-unavailable, model-error and not-assessable states remain distinct through UI, scorer and export.
- Review races return a conflict; agent drafts cannot satisfy human review; blind queues do not expose arm labels or ranks.
- Restart, retry and cancel preserve captured cases and prevent duplicate provider calls where completion has been checkpointed. A crash during an unacknowledged provider call remains explicitly uncertain unless that provider supports idempotency.
- Budgets cover all arms and retries with visible accounting; stale estimates cannot silently authorize extra spend.
- Each adapter enforces project scope, source ownership and immutable report references; remote mutable graphs are never advertised as snapshot comparisons.
- Keyboard users can complete setup, select a question, inspect evidence, save/skip a review and return to the same question. Narrow screens stack comparison panels without hiding outcomes.

## Decisions to validate with users

The recommendation is **Results workspace** as the primary destination, with a smaller **Version check** entry point in history. Validate whether most users first ask “Did this graph update help?” or “Which configuration should I use?”, and observe whether they can find the source behind a changed answer without help. Also check whether competency questions contain enough concrete expectations to seed the first suite. These findings should set the default setup template; they do not require changing the underlying capture or judgment contracts.
