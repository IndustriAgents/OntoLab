---
title: "Compare graph answers"
description: "Compare saved graph versions, review source evidence and save evaluation reports."
---

In source builds with the Evaluate workspace, open a knowledge graph and choose **Evaluate**. You need two saved graph versions. You can also start from **Versions → Compare answers on these versions**.

1. **Create a comparison.** Choose baseline and candidate versions, a provider/model, and questions. Approved competency questions are offered from your ontology project. Write the facts or answer each question should produce. If a document update changes the correct answer, give a separate baseline expectation.
2. **Run explicitly.** Saving the setup makes no model calls. Use **Edit setup** before running; afterward, use **Create edited copy** to change questions or settings. Review the number of answers and acknowledge model usage before starting a non-mock attempt.
3. **Inspect differences.** Results shows both answers with clickable query citations and retained source references. Filter to regressions, errors or unreviewed questions. Correctness and source-support changes are shown separately. The comparison uses saved graph facts and fresh Ask turns; document search and prior conversations are excluded.
4. **Review evidence.** Record answer correctness, source support and a reason separately. Select a passage in the retained source and choose **Use selected passage**, or copy a unique exact passage. Your unsubmitted review draft survives navigation and reload in the same browser tab. Version labels are visible by default; optionally hide them for blinded review. Skip leaves an answer unreviewed. Use Not assessable or Source support unavailable when appropriate.
5. **Save a report.** After reviewing the successful answers, choose **Save report**. Reports keep their captured answers and exact judgments. Editing a later review creates another report version when saved.
6. **Export.** Open a saved report from **Reports**, or export directly from the report. Its source viewer opens the exact reviewed passage. Attempt history is under **Reports → History**. Reading and rescoring saved captures makes no new model calls.

Use **Compare with next version** to reuse the questions, expectations and model with the previous candidate as the new baseline. Choose a newer saved graph and adjust expectations if necessary.

An existing Ask question can be added using **Add question to evaluation** beneath its saved answer. You still need to define its expected answer; the earlier model answer is not automatically treated as correct.

## Understand the result

This is an exploratory check on your selected questions. Reviewed outcomes are not an overall accuracy estimate or a held-out benchmark. Different expected answers are flagged as changed expectations rather than automatically counted as regressions. A located quote does not establish that an answer follows from it.

Retained source text comes from the extraction snapshot associated with the graph. Missing or changed source text is shown as unavailable; current documents are not substituted. Query results remain inspectable when there is no retained document reference.

## Continue interrupted work

With background processing enabled, attempts continue when you leave Evaluate. On request-driven installations, keep Evaluate open; reopening resumes saved progress. Cancellation may leave a provider request with uncertain usage. Retry explicitly to continue in a linked attempt; successful answers and their reviews are retained. You can also retry individual failed answers without recapturing successful ones.

Costs use recorded usage and configured prices where available. Project spending limits are checked between answers, so an in-flight request can finish over a limit. Unknown cost is shown as unavailable.

Connected external graphs need immutable snapshots before they can be compared. Retrieval experiments, extraction precision/recall and held-out protocols are outside this first workspace release. See [Evaluate quality](../research/evaluation.md) for the distinctions between measurements and the developer evaluation harness.
