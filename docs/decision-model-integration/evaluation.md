# Comparison with the current extraction pipeline

Status: preregistration plan. No arm has been run and no model has been selected as a quality winner. Existing mock/seed results are
plumbing evidence only.

## Questions to answer

1. Does JEV or LAYA improve source-supported type, literal and relation extraction when added to the current pipeline?
2. Does selective CLI/API re-extraction recover valid facts that a verifier would otherwise lose?
3. Can a cheaper proposer or source-candidate pipeline preserve final quality while reducing total cost or review effort?
4. Which provider, checkpoint, domain and decision families can support a calibrated automatic-acceptance policy?
5. How often do confident errors, missing candidates, context overflow or operational failures defeat confidence-based routing?

Run quality comparisons separately from provider conformance and transport checks. A schema-valid response or a fast warm forward pass does
not answer these questions.

## Comparison arms

Freeze `P0` as the selected current generative provider/model, `F` as one explicit fallback provider/model, and `V0` as the current
effective verification backend. Capture all model/runtime/settings identities. Do not replace `P0` with a different model and call the
result the current baseline.

| Arm         | Processing                                                            | Purpose                                                                     |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A0          | Current OntoLab pipeline with P0 and V0.                              | Primary unchanged control.                                                  |
| A1-J        | Same P0 candidates; JEV assessment, no re-extraction.                 | Isolate verifier filtering/review behavior.                                 |
| A1-L        | Same P0 candidates; LAYA assessment, no re-extraction.                | Matched LAYA verifier control.                                              |
| A2-J        | Same P0 candidates; JEV plus bounded F fallback and rechecks.         | Primary JEV cascade comparison with A0.                                     |
| A2-L        | Same P0 candidates; LAYA plus bounded F fallback and rechecks.        | Primary LAYA cascade comparison with A0.                                    |
| B0          | Cheaper proposer P1 with the matched current verification policy.     | Control for the cheaper proposer.                                           |
| B1-J / B1-L | Same P1 candidates; selected decision model plus F.                   | Test cost/quality benefit after A-series feasibility.                       |
| C-J / C-L   | Shared span/mention candidate policy; selected decision model plus F. | Later decision-first experiment, including candidate recall.                |
| F0          | F used on all selected scopes through the matched current workflow.   | Quality/cost reference for always using the fallback model; not gold truth. |

The first live pilot uses A0, A1-J, A1-L, A2-J and A2-L. B/C/F0 are separate, budgeted follow-ups, not an automatic multiplier of the first
study. A missing/failed provider arm remains in the report; it is not silently removed from the comparison.

Use the same captured P0 candidate artifacts for matched verifier/cascade experiments. Capture their original cost once and attribute it to
every end-to-end arm that requires that generation work, even when replay avoids paying again. Also measure at least one fresh full workflow
per arm to include real orchestration behavior. Report replay-attributed cost and newly incurred cost separately.

## Fixed ontology and production behavior controls

Keep the unchanged A0 arm, including its actual proposal/validation behavior. Add a separately labelled matched fixed-ontology control when
the new implementation exposes the proposal policy. New production modes do not revise the T-Box automatically. Unsupported concepts stay
outside the scored in-ontology graph and are reported as coverage issues.

Keep parsing, chunks, source snapshots, base graph, schema-retrieval settings, summaries, grounding, resolution and review policy fixed in
each matched experiment. Capture the actual schema shortlist and known-individual context. A future improvement to chunking or schema
retrieval requires a distinct ablation.

Evaluate raw proposed facts, checked facts, accepted facts and final graph separately. The initial pilot flags every new fact for review.
Estimate proposed automatic-acceptance behavior offline from the frozen threshold policy; do not rewrite the control's review state to
manufacture comparable acceptance counts.

## Data and independent labels

Use three data tiers:

1. **Deterministic fixtures and existing seed gold:** schema/adapter plumbing, pause/resume and known edge cases. Keep existing AI-drafted
   contracts, clinical and manual examples labelled as such.
2. **Public ontology-driven benchmark:** [Text2KGBench](https://arxiv.org/abs/2308.02357) or an explicitly pinned reviewed derivative. Check
   license, source grouping, annotation quality and model-training exposure. Public benchmark results do not establish fresh held-out
   generalization.
3. **Reviewed target documents:** an initial target of 240 source groups across contracts, technical manuals, scientific papers and
   industrial reports, 60 per domain. Use data permitted for every selected transport; a local-only subset is a separate evaluation stratum.
   Extend the target only through a preregistered independent collection rule when statistical precision is insufficient.

The target size is a collection plan, not a power guarantee. Before freezing, estimate label prevalence and required sample size from
development data. If confidence intervals or per-bucket counts cannot support a gate, report that decision as inconclusive and keep the
bucket flag-only.

For each ontology, independently review definitions, units, qualifiers and supported constraints. For each source, label the expected
individuals/types, exact literals, directed relations, relevant qualifiers and source spans. Add hard negatives and valid abstentions:
co-occurrence without relation, negation, hypothetical/proposed actions, reversed arguments, repeated numbers, wrong table column,
homonymous entities, missing ontology terms and genuinely unstated facts.

At least two reviewers independently annotate the final test subset, resolve disagreements and retain original decisions with reasons.
Reviewers see source/ontology context and anonymized candidates, not system names, confidence or rank. Expert adjudication is required for
domain semantics. Agent drafts can assist discovery but remain explicitly attributed and do not become independent human labels.

Label all expected facts for the chosen source scope; pooling only model outputs misses omitted facts. Supplement output-union review with
source-first annotation and explicit negative/coverage review. Keep unsupported but plausible world knowledge separate from source-supported
facts.

## Grouped splits and leakage controls

Proposed allocation for the 240 target source groups:

| Split       | Share | Groups | Use                                                                 |
| ----------- | ----- | ------ | ------------------------------------------------------------------- |
| Training    | 25%   | 60     | Optional candidate model or LAYA specialization only.               |
| Development | 25%   | 60     | Templates, shortlists, caps, model/profile selection and ablations. |
| Calibration | 20%   | 48     | Probability mapping and routing thresholds after templates freeze.  |
| Test        | 30%   | 72     | Final paired evaluation, accessed only after registration/freeze.   |

Allocate 15/15/12/18 groups per domain. Group document versions, paraphrases, overlapping chunks, repeated tables and near-duplicates
together. If original-document grouping is unavailable in a public benchmark, disclose the limitation and use conservative similarity
grouping. Declare a separate held-out ontology/domain challenge if claiming transfer to unseen schemas.

Record split membership, source and ontology hashes, grouping rules and random seed before tuning. Avoid semantic reuse of prior exposed
examples as fresh test data. Fine-tune and calibrate each provider only with permitted groups. Test-derived threshold changes start a new
experiment with new untouched test groups; rescoring the same set is exploratory.

## Exact metrics

| Measurement          | Definition and denominator                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity detection     | Precision/recall/F1 against reviewed identities and mentions; separate span detection from entity linking.                                                      |
| Type assertions      | Exact primary-type and additional-type P/R/F1, with a separate hierarchy-aware diagnostic. Do not count inferred ancestors as extra source-extraction wins.     |
| Literal assertions   | Exact subject/property/value/datatype/unit/qualifier P/R/F1 after declared semantics-preserving canonicalization. Retain a strict original-value audit.         |
| Relation assertions  | Directed subject/predicate/object P/R/F1, with identity and required qualifiers respected.                                                                      |
| Overall graph        | Micro and macro fact P/R/F1; per-domain and per-family results; missing gold facts remain false negatives.                                                      |
| Source support       | Independently judged supported/contradicted/insufficient-evidence rates, exact-span validity and wrong-subject/value-attribution rate.                          |
| Ontology conformance | Permitted vocabulary, implemented constraint findings and unsupported reasoning constructs. Structural conformance is not factual correctness.                  |
| Candidate recall     | Share of gold facts whose participants, values, predicate/type option and necessary evidence were available before decision scoring.                            |
| Decision quality     | Accuracy/precision/recall conditional on available candidates, plus full end-to-end metrics. Never present conditional accuracy as complete extraction quality. |
| Calibration          | Raw/calibrated ECE, Brier, reliability bins, selective risk/coverage and confidently wrong rates, with bucket counts.                                           |
| Fallback recovery    | Gold facts recovered after uncertainty, new errors introduced, unresolved cases, and false negatives never escalated.                                           |
| Review workload      | Candidates per document, independently timed review minutes, decisions changed and adjudication burden.                                                         |
| Operations           | Completion/error/cancellation rate, timeout, overflow, unknown outcomes, retry and duplicate-application counts.                                                |
| Latency              | Full workflow and per-stage p50/p95, cold/warm service state, queue time and model-call time.                                                                   |
| Cost                 | Proposer + decision + fallback + verification + summaries/resolution/retries; known USD, unknown usage, CLI quota units and local compute assumptions.          |

Keep existing `eval/metrics.ts` and `eval/research.ts` outputs for continuity. Add strict fact/evidence metrics alongside them rather than
silently changing historical definitions. In particular, current normalization and fuzzy name matching cannot serve as the only check for
wrong units, different individuals with similar names or unsupported measurements.

Report denominator-zero and unjudged cases as undefined/missing with counts. Do not use a zero-valued ECE from an empty sample as evidence
of calibration. A failed full workflow contributes to operational reliability; do not score its surviving partial facts as an ordinary
complete success.

## Runtime and transport protocol

Keep one approved API fallback profile and one approved CLI fallback profile as separate strata. If their underlying model/version or
reasoning configuration differs, label them separate model comparisons. A transport comparison requires matching model identity/settings;
otherwise measure deployment behavior without attributing quality changes to transport.

For each live study:

1. Validate provider contracts using synthetic allowed text before using target documents. Record any live canary calls and their cost.
2. Freeze dependencies, effective model identities and input/configuration hashes.
3. Run the same case bytes and question options through every matched decision arm. Record any model-specific state packaging and maintain
   the same required evidence and question meaning.
4. Interleave/randomize arm order at the source-group level. Avoid simultaneous ingestion, model downloads and unrelated local inference
   while measuring latency. Respect existing serialized CLI execution.
5. Capture one quality pass for each arm. Use three repeated test captures on a preregistered stratified stability subset if affordable; do
   not choose the best response.
6. Measure at least five warm repetitions on a fixed stratified latency subset, plus separate cold-load trials. Paid repetitions require
   their own budget; cached replay is not live provider latency.
7. Keep decision context-window sizes and question counts visible. Include server and adapter time, network time where applicable and CLI
   queueing in end-to-end latency.
8. Verify before/after source, ontology and candidate manifests. Reject an allegedly matched capture with changed inputs or effective model
   identity.

JEV and LAYA may package evidence differently because of context limits. Use a shared minimal complete evidence representation for the
primary controlled decision comparison. Also report a provider-optimized workflow as a separate arm; do not present changed context as a
model-only comparison.

## Budget and cost integrity

Prepare a manifest-based dry-run estimate before live inference. For each role, list case count, windows, question batches, maximum attempt
count and fallback cap. Reserve both the zero-fallback and worst-permitted-fallback totals. Freeze a study-wide paid-call/token cap plus
per-run caps; per-arm caps alone can conceal an excessive overall budget.

Initial pilot fallback is at most one completed correction round per evidence cluster, two clusters per chunk and an explicitly selected
run-wide cap. The implementation must include transient transport retries in attempt/token reservations. All live traffic, including
diagnostics, warm-ups and failed calls, enters the ledger.

Address the current provider-NLI accounting gap before a USD-savings claim: collect its reported usage through a measurement-only ledger or
label cost incomplete. CLI subscription usage and local LAYA compute cannot be called free. If total cost is not comparable, present
quality, measured latency, known cash cost and resource units separately; the savings gate remains undecided.

## Statistical analysis and release gates

Predeclare A2-J versus A0 and A2-L versus A0 as the two primary contrasts. Use paired source-group resampling for confidence intervals, with
10,000 bootstrap replicates and a fixed seed. Account for clustering of assertions within documents. Apply Holm adjustment to the two
primary inferential tests; label extra arms, buckets and exploratory contrasts. No uncorrected search across templates/test thresholds may
choose a winner.

Proposed quality gates, to be fixed before test access:

| Gate                       | Requirement                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanical integrity       | No out-of-scope write, invalid applied answer, accepted required-evidence truncation or duplicate application in the relevant deterministic/failure suite.                                                                                         |
| End-to-end non-inferiority | For overall F1 and recall, the paired one-sided 95% lower confidence bound on cascade minus A0 is at least -0.02; also pass within each domain advertised as supported.                                                                            |
| Supported acceptance       | For each bucket offered automatic acceptance: at least 100 independently reviewed accepted assertions, observed support precision at least 0.98 and a 95% Wilson lower bound at least 0.95. No failing bucket is hidden by pooling.                |
| Useful efficiency          | At comparable quality, show at least 20% lower complete known cost or 20% lower independently measured review time; report uncertainty. End-to-end p95 must not rise more than 20% for the declared workload without an explicit product tradeoff. |
| Honest operations          | All incomplete, unknown-cost and failed cases included. Effective models and complete source coverage identified.                                                                                                                                  |
| Unqualified buckets        | Flag-only/fallback behavior; no automatic acceptance or broad provider-quality claim.                                                                                                                                                              |

These are proposed product gates, not literature guarantees. They intentionally allow an inconclusive result. Calibration failure, low
candidate recall, unacceptable operational behavior or an unknown cost denominator can block promotion even when a point estimate looks
favorable. The initial flag-only pilot does not need to claim automatic-acceptance qualification.

## Reports and artifacts

The future harness should write a versioned study directory containing:

```text
manifest.json                 code/input/model/configuration identities
splits.json                   group membership and declaration
requests.jsonl                request lifecycle and effective provider metadata
usage.jsonl                   fresh, cached, failed and unknown usage
candidates/                   source-backed candidate manifests
assessments/                  raw and normalized decision records
fallback/                     attempted corrections and post-check outcomes
review/                       blinded labels and adjudication history
metrics.json                  complete per-case and aggregate measurements
report.md                     paired results, limitations and recommendation
```

These are proposed artifacts; this documentation change creates no study data. Keep private text out of Git unless explicitly suitable for
the repository. Store small redacted reports/manifests for review and use authorized storage for full source/evidence artifacts.

The report must show a table for every declared arm, including `not run`, `failed` and `inconclusive` statuses; per-family/domain metrics;
precision/recall tradeoffs; fallback recovery and added errors; risk/coverage; complete known/unknown cost; and concrete source examples of
both gains and regressions.

End with a scoped decision: retain current extraction, enable one provider only in specified buckets, continue flag-only research, or stop
the integration. New results do not rewrite historical run configurations or silently activate project settings.
