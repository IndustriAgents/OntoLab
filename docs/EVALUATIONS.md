# Graph answer comparisons

Evaluate compares the current Ask engine on two saved native graph versions. It saves graph inputs, captured answers and query traces, source reviews, and report versions independently of chat history. This first phase is an exploratory graph answer check; retrieval experiments and held-out benchmarks remain future work.

## Use the workspace

1. Open a knowledge graph and choose **Evaluate**, or choose **Compare answers on these versions** in Versions.
2. Create a comparison. Select baseline and candidate saved versions, a provider/model, and 1–20 questions. Approved competency questions are offered from the parent ontology project. An Ask question can also be added through its answer's **Add question to evaluation** link.
3. Write the expected answer or required facts for every question. If the correct answer changed with the source material, supply a separate baseline expectation. Expectations are review criteria and are not sent to the answer model.
4. Save the comparison, edit it through **Edit setup** if needed, then explicitly run it. Setup becomes immutable at the first run; **Create edited copy** carries its questions and settings into another comparison. Creating or browsing a comparison makes no model calls. Non-mock attempts require a model-usage acknowledgement.
5. In Results, select a question to inspect the two answers and their query results. Open retained source evidence to inspect the extraction text. A quote's location and its support for the answer are separate checks.
6. In Review, grade correctness and source support separately and supply a reason. Select text in the source viewer and choose **Use selected passage**, or copy a unique exact passage. Selected positions allow repeated text to be distinguished. Version labels are visible by default; optionally hide them and prior judgments. Unsubmitted drafts survive tabs, answer changes and reloads in the same browser tab. They are scoped to the owner, comparison, answer and previous judgment, and cleared after a successful save. Skip leaves the existing saved state unchanged.
7. After reviewing the successfully captured answers, choose **Save report**. Reports pin exact judgment IDs. Later review edits can produce another report without changing an earlier one or calling the model again.
8. Open or export a saved report from **Reports**, or export directly from a saved report. Attempt history and recapture are in **Reports → History**. The JSON export includes scope identities, questions, captures, judgments, report checksum and retained source text when available.

Use **Compare with next version** to copy the questions, candidate expectations and model, with the previous candidate as the new baseline. Update expectations if needed. Results can be filtered to regressions, errors or unreviewed questions; correctness and source-support changes are shown separately. Saved report views open the exact reviewed source and passage. Completed comparisons and reports do not poll continuously.

## Scope and evidence

- Only committed native revisions are eligible. Connected remote graphs need immutable snapshots before they can be evaluated.
- Both arms call `executeGraphAnswer()` in `server/services/graphChat.ts`, the same execution function used by `/assistant/chat`. Evaluation uses a fresh, graph-only turn with no conversation history or mutable document-search tool. This matches corpus graph Ask's current graph-only capability. Ordinary project Ask can additionally search documents, which this comparison explicitly excludes.
- Input snapshots use content-addressed private blobs so a draft edit cannot replace the inputs used by a racing start. Stale setup edits are rejected. The comparison pins its question/expectation set, provider/model and engine fingerprint. Its input snapshots include both complete graph revisions, project settings at setup and source-text hashes. Captures use these snapshots even if the original graph revision is later removed.
- Source review follows references on the queried entities, or the graph's references when no entities were resolved. These references provide context; they do not automatically establish that the answer follows from the text. At most 30 distinct references are retained per answer, with an explicit truncation flag.
- Original extraction text must match the hash pinned at setup. Missing or changed text is marked unavailable; current documents are never substituted. Successfully retained text is copied into the evaluation's private blob namespace and hash checked on access.
- An unreviewed answer has no grade. Not assessable, model/query errors, missing source evidence and an incorrect answer remain distinct states. Questions with different expectations in the two arms are reported as changed expectations, without an improvement/regression verdict.
- Human reviews record the authenticated account and explicit source-review attestation. These records do not independently prove who performed the review. Automated draft origins cannot be submitted as human reviews.

## Runs and costs

The existing background worker discovers evaluation attempts through a separate store contract. It captures one answer at a time using durable leases and checkpoints in the evaluation aggregate. In Desktop, and on servers with `WORKER=1`, it continues when the page is closed. Request-driven installations advance while Evaluate is open and resume saved work when reopened.

Cancellation stops new answers and requests cancellation of an active call. A provider request already sent may incur usage. If a process stops with an unanswered in-flight request, lease recovery marks the attempt interrupted instead of silently replaying it. Explicit retry creates a linked attempt and reuses successful captures and their reviews. Retry is also available when an otherwise finished attempt has individual answer errors; only failed or unfinished answers are captured again. Retries retain uncertainty about unfinished provider usage.

The maximum number of answers is twice the number of questions; each uses Ask's configured `MAX_TOOL_ROUNDS` plus a final answer round. Cost values use recorded tokens and configured prices and are estimates. Unknown or interrupted usage is not zero. Project per-run and total spending limits are checked between answers, matching extraction's existing semantics; an in-flight request may finish over a limit. Models without configured prices cannot be used when a monetary limit needs to be checked. Recorded evaluation cost contributes to project spending checks.

Changing the Ask implementation fingerprint blocks new captures under the old definition. Existing reports stay readable; create a new comparison to use the changed implementation. This fingerprint identifies the current core execution contract, not a reproducible provider-hosted model build.

## Storage and upgrades

Evaluation metadata is an owner-scoped aggregate with compare-and-swap version checks; captures, judgments and reports are append-only inside it. Graph/source snapshots are private blobs beneath `<project>/evaluations/<evaluation>/`. Project deletion removes both metadata and project blobs.

- Local: JSON evaluation records alongside project runs; the local adapter follows the existing single-server concurrency model.
- Postgres: record kind `evaluation`, owner RLS, and a separate worker discovery policy. Apply `migrations/0005_evaluations.sql` through the existing migration runner using `DATABASE_URL_UNPOOLED`.

## Verification

```sh
npm run typecheck
npm run lint
npm test
```

The integration tests exercise the real HTTP routes, current Ask service, worker, snapshot retention, review conflicts, report immutability, cancellation/retry, interrupted calls, source drift and ownership. They default to isolated local storage. To run the same cases against a separately migrated disposable Postgres database:

```sh
EVALUATION_TEST_DATABASE_URL=postgresql://... npm test -- tests/evaluations.test.ts
```

Use an isolated test database: the tests create and delete their own temporary projects under the test owner. No paid provider is used by these checks.
