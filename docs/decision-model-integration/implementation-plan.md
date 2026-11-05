# Implementation work packages and rollout

Status: future implementation backlog. This documentation-only change authorizes no live evaluation, deployment, model installation or
automatic acceptance. A future implementation task should select a bounded milestone from this plan.

## Delivery boundaries

Keep the work in small reviewed changes. First capture the current behavior and introduce contracts/mock infrastructure; then add adapters,
shadow assessment, fallback and evaluation. Implement candidate-first extraction only after the verifier/cascade comparison identifies a
worthwhile use case.

The implementation owner coordinates Node services, optional Python inference, UI and evaluation. Domain reviewers own reference labels and
acceptance of ontology meanings. The deployment operator owns permitted endpoints, local CLI accounts, model artifacts and resource budgets.
The experiment reviewer verifies the preregistration and reported claims independently of model-generated judgments.

## Milestone 0 Baseline and experiment preparation

### T01 Capture the baseline

Dependencies: none.

- Pin the implementation commit, source/parser/chunk versions, approved ontology, P0/V0 profiles, effective scorer and review settings.
- Capture current candidate outputs and schema/identity context in isolated storage.
- Identify measurement-only accounting changes separately from extraction-semantic changes.
- Preserve a reference execution path and cache identities for the current mode.

Acceptance: an independent run can load the same inputs and explain every relevant current setting. The report identifies any unpinned CLI
alias or runtime NLI degradation. No new provider is required to run the baseline.

### T02 Prepare labels and preregistration

Dependencies: T01.

- Define source groups, ontology meanings, strict fact/evidence matching and data permissions.
- Register train/development/calibration/test membership and the primary A-series contrasts.
- Assign independent reviewers, adjudication rules and study-wide budgets.
- Determine sample-size adequacy before exposing test labels; keep incomplete decisions explicitly unqualified.

Acceptance: [Evaluation](evaluation.md) is converted into an immutable experiment manifest with actual dataset/model IDs, caps and gates.
Existing AI-drafted seed labels are not presented as trusted production evidence.

## Milestone 1 Contracts, provenance and mock execution

### T03 Define typed decision contracts

Dependencies: T01.

- Add proposed `src/types/decisions.ts` and a backend interface under `server/decisions/`.
- Define candidate, question, native answer, assessment, routing, usage and error discriminators.
- Add frozen decision configuration as an optional run field, separate from the existing generative provider and NLI choice.
- Validate selected profile IDs and configuration fields at the HTTP boundary.

Acceptance: legacy JSON without decision fields loads as `off`; unknown modes/fields are rejected; operational failures cannot be
represented as low support scores. Serialized samples and round-trip tests cover every record type.

### T04 Compile ontology questions

Dependencies: T03.

- Build a deterministic compiler from the selected T-Box and relevant retrieved terms.
- Include definitions, property direction, relevant class closure, explicit abstentions and unsupported-construct reports.
- Version question wording, option order/IDs and source requirements.
- Add schema shortlist/candidate completeness records.

Acceptance: stable inputs produce stable hashes. Fixtures cover subclasses, overlapping classes, inherited properties, absent definitions,
uncovered concepts and unsupported OWL constructs. No test treats missing type information as a contradiction.

### T05 Add durable assessment storage and usage ledger

Dependencies: T03.

- Use project-scoped private blobs and checkpoint references.
- Record request start/completion/unknown outcome, per-role usage and price identity.
- Introduce independently keyed caches for candidate sets, assessments, routes and fallback proposals.
- Add optional archive-manifest support without rewriting old records.

Acceptance: another owner cannot read/reuse a cache entry; changed ontology, context, identities, model, token budget or questions
invalidate appropriate work. Changed thresholds reuse only raw assessments. Interrupted requests retain unknown cost instead of zero.

### T06 Run a mock decision lane

Dependencies: T04, T05.

- Implement deterministic fake assessments and queued/error outcomes.
- Add versioned decision substeps to the existing run planner/advancer.
- Account for each stage's queue/call deadline in lease duration or tested renewal.

Acceptance: browser/worker competition applies each completed result once; pause/cancel/restart work at every stage; no real key, network
inference or model weights are needed. A cancelled or stale run cannot publish a late result into a different draft.

## Milestone 2 Provider adapters

### T07 Add the JEV adapter

Dependencies: T03, T05, T06.

- Implement a server-held hosted profile and bounded HTTP adapter.
- Enforce question/answer correlation, finite outputs, model pin, context checks and attempt budgets.
- Capture effective model and all available usage, including error/timeout status.

Acceptance: fixture server tests cover valid responses, missing/extra IDs, wrong primitive, invalid choice, malformed distribution, context
rejection, model mismatch, authentication, throttling, overload, timeout and cancellation. A separately authorized live canary verifies
transport only.

### T08 Add an upstream LAYA service profile

Dependencies: T03, T05, T06.

- Add proposed `sidecar/decision-models/` with locked dependencies and a verified deployment manifest.
- Pin a checkpoint/runtime/tokenizer; retain full routing/truncation diagnostics.
- Add preflight limits and fail on checkpoint drift, lost evidence or collapsed options.
- Keep the service optional for web and desktop. Desktop connection/launch packaging is a separate acceptance item, not an implicit Python
  dependency added to every install.

Acceptance: mocked HTTP tests cover diagnostic normalization; runtime parity checks use the pinned checkpoint; actual CPU/macOS and intended
hosted hardware receive separate smoke evidence. Cold-load/RAM/device observations are recorded. If artifact identity or coverage cannot be
verified, the profile remains experimental and flag-only.

### T09 Qualify provider semantics

Dependencies: T02, T07, T08.

- Compare identical small states and option maps across adapters.
- Exercise question order, option order, abstention, negation, multilingual content and context boundaries.
- Select/pin the relevant LAYA checkpoint; treat any fine-tune as a distinct model and training-data record.

Acceptance: every native confidence/probability field has a documented interpretation. No shared raw threshold is used merely because
payload fields have the same name. Provider quality claims remain blocked until task evaluation.

## Milestone 3 Shadow verification and selective fallback

### T10 Add shadow verification

Dependencies: T04-T09.

- Assess current P0 candidates without changing emitted A-Box or review state.
- Store per-fact assessments and hypothetical routes in run diagnostics.
- Capture non-assessed/overflow candidates, source completeness and actual effective inputs.

Acceptance: with shadow disabled/enabled, the current pipeline's semantic result is unchanged for the same captured proposer output. Shadow
cost is separate, and no fallback extraction occurs by default. Candidate omissions receive a separate audit.

### T11 Add bounded generative fallback

Dependencies: T06, T10.

- Resolve an explicit fallback provider/model through the existing catalog and structured-call path.
- Prepare targeted source/ontology/identity context with one correction round per scope and run/chunk caps.
- Preserve response schema and current CLI isolation, visibility, cancellation and quota behavior.
- Route failed checks from either the initial decision or fallback into the same bounded correction/review policy.

Acceptance: both an allowed API and fixture CLI transport return schema-validated scoped proposals. An unavailable CLI stays unavailable;
unsupported vision input produces a clear route. No response deletes unrelated facts, silently changes provider or repeats until a favorable
score appears.

### T12 Revalidate and integrate provenance

Dependencies: T05, T11.

- Apply exact source checks, datatype/unit handling, ontology conformance and post-fallback support assessment.
- Preserve original candidate, fallback proposal, disagreements and human decisions.
- Extend new-lane corpus fingerprints and portability manifests with decision/fallback identities.
- Keep first functional runs flag-only, feeding the existing fact-review workflow.

Acceptance: stale source/ontology/assessment identity cannot apply; source replacement preserves historical evidence; graph updates retain
existing suppressed facts and manual decisions; a fallback cannot commit a graph. Old projects and archives still open without invented
metadata.

### T13 Add extraction and review controls

Dependencies: T10-T12.

- Extend existing extraction settings with mode, decision profile, fallback profile and known budgets.
- Display effective providers/processing locality before start and reason-coded unresolved facts after execution.
- Add assessment/fallback drill-down to the current run inspector and review queue.
- Clearly distinguish source integrity, support estimates, class decisions and human acceptance.

Acceptance: a user can explain why a specific fact escalated, which model saw which source and why it remains unresolved. Unknown costs and
incomplete coverage are visible. No new top-level navigation is required.

## Milestone 4 Controlled comparison and decision

### T14 Extend the evaluation harness

Dependencies: T02, T09-T12.

- Add decision configuration/profile manifests to the existing harness.
- Retain current metrics and add strict fact/evidence matching, candidate recall, route errors, fallback recovery, calibrated risk/coverage
  and complete per-role accounting.
- Support frozen candidate replay and fresh end-to-end captures as distinct measurement modes.
- Write the study artifacts and paired reports specified in [Evaluation](evaluation.md).

Acceptance: deterministic fixtures recover known denominators and missing/zero-sample cases. A fake arm that discards valid facts loses
recall. A fake arm with unmetered verification cannot report USD savings. A candidate-oracle diagnostic cannot be mistaken for deployed
extraction.

### T15 Calibrate and execute the A-series

Dependencies: T14 and independently reviewed labels.

- Freeze templates/checkpoints on development data, fit calibration on calibration data, then lock the full manifest.
- Execute the registered test once with recorded budgets and model identities.
- Publish paired results, failure counts, source gains/regressions and decisions for each provider/bucket.

Acceptance: an independent reviewer can reproduce scores from retained rankings/facts and labels. Results include all declared arms and no
provider confidence is used as gold correctness. Uncertain gates remain inconclusive.

### T16 Select the supported operating scope

Dependencies: T15.

- Choose retain-current, flag-only, scoped provider/cascade support, or stop.
- Compare the cheaper proposer and always-fallback controls only under a separately approved B/F-series budget.
- Promote automatic acceptance only for buckets meeting all relevant gates; it remains off elsewhere.

Acceptance: the release decision identifies supported ontology/task/language/deployment scope, actual benefits, failure modes, monitoring
and rollback. A provider is not enabled globally based on a pooled average.

## Milestone 5 Optional candidate-first extraction

### T17 Build candidate extraction and coverage diagnostics

Dependencies: T04, T15, T16.

- Add exact span/mention/literal generators and versioned pair shortlisting.
- Add controlled hierarchy/multi-type decisions and event/table-aware attribution.
- Measure candidate recall, including missing values, cross-sentence participants and overflow.

Acceptance: the correct answer's absence is visible and can trigger fallback. A direct decision model cannot fabricate a free string or
arbitrary numeric literal. UTF-16/code-point conversion and repeated source occurrences are verified.

### T18 Evaluate candidate-cascade mode

Dependencies: T17.

- Execute C-J/C-L against the same registered controls using a fresh held-out extension where tuning has already exposed the old test set.
- Include proposer/candidate-generation cost and the full missed-gold denominator.
- Keep local LAYA specialization, provider-native window optimization and model-only comparisons separate.

Acceptance: enable the candidate-first mode only within the evaluated scope. Weak candidate recall or failed total-workflow gates retains
verifier-only or current extraction.

## Proposed source changes

These paths describe future edits; only documentation is added by this change.

| Existing or proposed area                                                                                                                                                                                   | Planned work                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/types/decisions.ts` (new)                                                                                                                                                                              | Typed versioned candidates, questions, assessments, profiles, routing and usage.                                       |
| [project.ts](../../src/types/project.ts), [research.ts](../../src/types/research.ts), [abox.ts](../../src/types/abox.ts)                                                                                    | Optional frozen configuration, stage traces and evidence assessment references with legacy defaults.                   |
| `server/decisions/` (new)                                                                                                                                                                                   | Compiler, adapter interface, mock/JEV/LAYA clients, normalization, calibration and policy.                             |
| [runs.ts](../../server/services/runs.ts)                                                                                                                                                                    | Planner stages, deadlines/leases, estimates, durable routing/fallback, assembly and accounting.                        |
| [extract.ts](../../server/extract.ts), [schemas.ts](../../server/schemas.ts)                                                                                                                                | Explicit fixed-ontology proposal policy and scoped correction output.                                                  |
| [structured.ts](../../server/structured.ts), [cli/invoke.ts](../../server/cli/invoke.ts)                                                                                                                    | Reuse dispatch; propagate separate fallback budget/usage and preserve isolation. Avoid unrelated provider refactoring. |
| [verification.ts](../../server/services/verification.ts), [nli.ts](../../server/ml/nli.ts)                                                                                                                  | Assessment-aware support boundary; snapshot-based input for new lanes; effective-backend reporting.                    |
| [schemaRetrieval.ts](../../server/services/schemaRetrieval.ts), [corpora.ts](../../server/services/corpora.ts)                                                                                              | Recorded shortlist/coverage and complete extraction fingerprints.                                                      |
| [archive.ts](../../server/services/archive.ts), [archiveV2.ts](../../server/services/archiveV2.ts)                                                                                                          | Optional portable decision manifests and historical evidence references.                                               |
| [ExperimentOptions.tsx](../../src/features/research/ExperimentOptions.tsx), [RunInspector.tsx](../../src/features/research/RunInspector.tsx), [ReviewQueue.tsx](../../src/features/explore/ReviewQueue.tsx) | Scoped selection, actual progress/cost, assessment and correction inspection.                                          |
| `sidecar/decision-models/` (new)                                                                                                                                                                            | Optional pinned LAYA runtime/service, deployment manifest and fixtures.                                                |
| [eval/](../../eval/)                                                                                                                                                                                        | Registered comparison runner extensions, strict metrics, cost ledger and report generation.                            |
| [tests/](../../tests/)                                                                                                                                                                                      | Contract, run-recovery, provenance, UI and archive regression coverage.                                                |

Prefer optional JSON-compatible records first because existing stores retain run/content data. Audit every store adapter and wire validator
before deciding that no database migration is needed. Indexes or durable call-ledger tables, if required, need explicit migrations and
ownership tests.

## Verification matrix

| Layer       | Required cases                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiler    | Determinism, definitions, unsupported axioms, subclass/overlap semantics, abstention and URI mapping.                                           |
| Adapter     | Complete/invalid answers, rounding, actual model, context cuts, collapsed choices, timeout and operational failures.                            |
| Routing     | Supported positive/negative, uncertainty, missing candidate, contradiction, failed checks, budget exhausted and unavailable fallback.           |
| Fallback    | API and fixture CLI, exact scoped corrections, schema rejection, wrong relation direction, wrong numeric attribution and no unrelated deletion. |
| Recovery    | Crash before/after transmission, unknown charge, restart after assessment/fallback, lease contention, pause/cancel and late results.            |
| Ownership   | Project/corpus isolation, wrong source scope, forbidden profile, secret redaction and no arbitrary URL/executable selection.                    |
| History     | Source replacement, ontology/settings changes, archive round-trip, old records and manually reviewed facts.                                     |
| Measurement | Empty calibration set, missed gold, false-negative routing, unknown USD, replay/live separation and failed-arm denominator.                     |
| Interface   | Actual selected model, unsupported state, trace inspection, review-only output and unchanged current default.                                   |

Use deterministic provider servers/subprocess fixtures for ordinary CI. Run `npm run check` and `npm run build` for the relevant
implementation changes, plus focused suites for each package. Preserve existing CLI and corpus tests. Live tests are separate, explicit,
budgeted runs; mock accuracy is never a provider quality result.

For this documentation-only change, verify Markdown formatting, relative links, internal anchors, referenced existing symbols and
`git diff --check`. Full model tests or application builds are not needed to validate these prose files.

## Rollout and rollback

1. Ship configuration parsing and mock/shadow support behind an operator feature flag. Old and new projects default to `off`.
2. Allow named local/internal projects to use shadow mode, then explicit flag-only verify-cascade runs.
3. Publish the controlled evaluation and qualify provider buckets before enabling an opt-in supported mode.
4. Add automatic acceptance only as a separate qualified policy. Monitor support errors, negative-route misses, fallback rate, input
   overflow, effective model drift, cost completeness and review time.
5. Keep an immediate new-run switch back to the current extractor. Active runs preserve their frozen config; pause/cancel them explicitly if
   their provider is no longer allowed.
6. Retain historical model assessments and graph evidence after rollback. Do not rewrite a run as if it used the replacement provider or
   delete unresolved candidates to improve reported quality.

Release completion means documented scoped behavior, passing mechanical tests, reproducible quality/cost evidence and an independent review
of the promotion decision. Merging this plan to `main` does not enable any decision-model mode.
