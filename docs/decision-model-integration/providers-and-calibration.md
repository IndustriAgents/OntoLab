# Decision providers and uncertainty calibration

Status: proposed adapters and operating policy. External documentation was checked on 2026-11-03. Recheck capabilities and pin identities
when implementation begins; no provider was called for inference while preparing this plan.

## Common adapter boundary

Use a dedicated decision interface rather than registering JEV/LAYA as general text-generation providers. They answer prepared questions;
generative extraction remains behind the current provider abstraction.

Proposed pseudocode:

```ts
interface DecisionEngine {
  describe(): Promise<DecisionCapabilities>;
  assess(request: DecisionRequest, signal: AbortSignal): Promise<DecisionBatch>;
}

interface DecisionCapabilities {
  provider: "jev" | "laya" | "mock";
  deploymentIdentity: string;
  requestedModel: string;
  resolvedModel: string;
  runtimeRevision: string | null;
  questionTypes: ("choice" | "noul" | "score")[];
  tokenLimits: { state: number | null; question: number | null; request: number | null };
  limitsVerified: boolean;
  reportsTruncation: boolean;
  reportsCheckpoint: boolean;
  usageSemantics: string;
}
```

Actual types must distinguish unknown from inapplicable limits instead of substituting a permissive number. `describe` uses a pinned
operator manifest and supported discovery; readiness alone is not an inference or quality check. A missing resolved identity or unverified
context bound blocks controlled evaluation and automatic acceptance until resolved.

The normalized result retains native answers and diagnostic fields. For each question, include its ID and family; selected option; raw
per-option probabilities or Noul probability; native confidence and its meaning; option margin where relevant; model/checkpoint identity;
input-coverage status; usage; errors; and calibration/routing references. `Score` is reserved for genuinely ordered assessment tasks, not
arbitrary numeric property extraction.

## JEV hosted adapter

TypeSafe exposes named questions over shared state at `POST https://api.typesafe.ai/v1/systemone`. Choice, Noul and Score cover the proposed
text decisions. JEV questions in a request are independent. Use the current supported pinned model `jev-1.14.0` as an initial candidate;
aliases may change. The current model documentation describes separate request/question context limits. These are provider facts, not
OntoLab quality results. Sources: [System One API](https://docs.typesafe.ai/api/system-one), [Models](https://docs.typesafe.ai/models).

Implementation policy:

- Keep the provider key on the server in the existing secret/configuration mechanism. Expose a profile ID and readiness state to the
  browser.
- Pin the model and retain the actual returned model. A model mismatch invalidates strict replay/evaluation identity.
- Count the complete serialized state and questions using a verified counting method or conservative bound, with reserved headroom. Reject
  over-budget input before transmission.
- Use natural-language definitions and explicit candidate IDs/spans; do not send unrelated project documents or evaluator labels.
- Validate the complete question-ID set, answer discriminators, allowed choices, finite numeric fields and distributions. Keep raw values
  before any normalized copy.
- Bound concurrency, queue length, deadline, attempts and per-run token/call budget. Provider errors have an operational classification;
  retry policy is independent of semantic uncertainty.
- The existing HTTP helper may be reused only if its timeout, retry and accounting behavior matches this contract. Avoid nested SDK retries
  under run-level retries.
- A paid retry consumes a new budget reservation. Honor documented backoff for transient errors without treating authentication or invalid
  requests as retriable semantic cases.

JEV's Choice/Score confidence summarizes the returned distribution; Noul has no separate confidence field. Gate support on a validated
support decision and calibration profile, not on a generic field named confidence.
[Confidence documentation](https://docs.typesafe.ai/confidence)

No direct model download or customer fine-tuning is part of the hosted adapter. Record provider-reported usage, request timing and
price-version estimates separately from invoices. Token rates and account limits are implementation-time configuration; this plan does not
assume permanent prices.

## Upstream LAYA local adapter

Use the model author's [repository](https://github.com/NandhaKishorM/laya), [HTTP API](https://nandhakishorm.github.io/laya/http-api/) and
[model card](https://huggingface.co/convaiinnovations/laya). Independently operated hosted services using the LAYA name are separate
deployment choices and are not assumed to be upstream or equivalent.

The upstream family includes English, multilingual and typed-decisions checkpoints with different default token budgets. The model card
identifies task-transfer and calibration limits; a benchmark-specific fine-tune is not evidence of known-ontology extraction quality. Pin
the exact checkpoint commit, tokenizer, runtime version and inference settings before evaluation.
[Model card](https://huggingface.co/convaiinnovations/laya)

The upstream HTTP payload has checkpoint routing and truncation metadata. Its native confidence fields differ from JEV's; strict JEV
projection can hide relevant diagnostics. Preserve the full response, check the actual routed checkpoint, and reject decisions made with
dropped evidence or collapsed options. No numerical threshold transfers automatically between providers.
[Upstream HTTP contract](https://nandhakishorm.github.io/laya/http-api/)

Preserve these upstream fields in the adapter's diagnostic record:

| Field                                                            | Interpretation or planned check                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `routing.model`, `routing.repo`                                  | Actual checkpoint selection, checked against the deployment manifest.           |
| `confidence`                                                     | Native entropy-based confidence for Choice/Score; not JEV's statistic.          |
| `answer_confidence`                                              | Probability mass on the selected answer, retained separately.                   |
| `x_jev_confidence`                                               | JEV-style summary of the same probabilities, not evidence of equal calibration. |
| `action.act_probability`                                         | Do not use for this integration's acceptance routing.                           |
| `usage.truncated`, `state_tokens_dropped`, `truncated_questions` | Detect lost state and affected questions; block their application.              |
| `usage.options`                                                  | Detect options that no longer have distinct token spans.                        |

This table describes the full upstream HTTP response; conformance tests must verify it against the pinned runtime.
[Field definitions](https://nandhakishorm.github.io/laya/http-api/)

Implement LAYA behind an optional private service profile under a proposed `sidecar/decision-models/` package:

1. Use the upstream runtime through a small pinned service/manifest boundary. Keep Python/model packages out of OntoLab's base Node runtime.
2. Start with explicit checkpoint selection, rather than automatic language/task routing in the primary experiment. If automatic routing is
   later evaluated, record and separately score each selected checkpoint/language path.
3. Publish a verified deployment manifest containing checkpoint digest, tokenizer digest, package versions, dtype, device/backend and
   supported budgets. Resolve any response alias against this manifest.
4. Preload deliberately when measuring warm latency; record first-load time, memory and idle/unload behavior separately.
5. Use full diagnostic responses. If an upstream mode removes coverage metadata, the local wrapper must provide equivalent verifiable
   coverage or mark the request unsupported.
6. Enforce an application-specific context envelope after measuring actual serialization/tokenization. Partition a long chunk into exact
   sentence/table windows with offsets; preserve context needed by each assertion.
7. Run capability/parity checks on the chosen checkpoint and runtime before task-quality evaluation. A successful HTTP response does not
   prove that the intended checkpoint or complete source was read.
8. Fit any fine-tune/calibration only on the allowed training/calibration groups. Record the new artifact as a separate model identity and
   comparison arm.

Do not feed OntoLab's complete `buildExtractSchema` into LAYA's schema helper. Upstream schema-driven decisions cover a bounded subset,
including enums and booleans; free strings, arrays and nested objects cannot express OntoLab's full A-Box output directly. Compile explicit
candidate questions and assemble the graph in code. [Schema-driven decisions](https://nandhakishorm.github.io/laya/structured/)

## Response conformance and context coverage

Required adapter checks:

| Check                | Expected behavior                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question correlation | Exactly one answer per requested ID, with matching primitive and no unrequested result applied.                                                       |
| Choice values        | Selected label exists in that question's option map; definitions and stable URI mapping retain the same identity.                                     |
| Numeric values       | Probabilities are finite and bounded. Distribution sums use a documented rounding tolerance; preserve raw values and normalize only a copy if needed. |
| Model identity       | Actual provider/checkpoint agrees with the frozen profile and deployment manifest.                                                                    |
| Evidence coverage    | No dropped required state, lost table context, collapsed options or unknown critical coverage.                                                        |
| Completeness         | Missing/partial batches are not published as complete assessments. Completed partitions remain resumable.                                             |
| Unknown extensions   | Preserve allowlisted diagnostics; do not forward raw provider errors, routing text or headers to public logs/UI.                                      |
| Operational failure  | Distinct error type, usage/completion status and next permitted action. No fabricated score.                                                          |

Use complete effective question payloads in hashes. Reordered choices, changed definitions, changed state serialization or different token
settings create different input identities. Test option-order sensitivity explicitly rather than relying on a schema-level equivalence
assumption.

Fit the request to the smallest verified limit in the selected profile: body, state, per-question context, total request, per-option budget
and per-run reservation. If fitting would remove a negation, unit, qualifier, table header or participant, the route is unsupported or
escalated. Silent truncation is never a supported extraction strategy.

## Uncertainty is a policy over several signals

For each candidate, retain:

| Signal                               | Use                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Support outcome/probability          | Whether the exact assertion follows from its supplied source.                   |
| Class/property choice distribution   | Ambiguity among the offered definitions.                                        |
| Native confidence and option count   | Provider diagnostic; do not interpret as measured fact accuracy.                |
| Top-two margin                       | A separate ambiguity feature, useful only after validation.                     |
| Source/ontology findings             | Exact quotes, values, identity constraints and representability.                |
| Coverage and model identity          | Whether the model saw the necessary input through the intended checkpoint.      |
| Candidate and shortlist completeness | Whether the correct answer was available to choose.                             |
| Disagreement                         | Conflicting candidate decisions, verifier results or post-fallback assessments. |

A high-confidence wrong checkpoint, truncated source or missing candidate is not repaired by raising a confidence threshold. These are
independent route conditions.

## Calibration procedure

1. Use the grouped development/training data to choose templates, candidate policy and checkpoint. Freeze those before fitting thresholds.
2. Fit calibration on a separate calibration split, stratified by provider, checkpoint, question family, option-count bucket, language and
   relevant domain. Combine small buckets only under a declared pooling rule.
3. Start with simple temperature scaling on available logits/probabilities, or a documented monotone mapping if justified by sample size.
   Never invent inaccessible provider logits. Preserve raw and calibrated outputs and the transform artifact.
4. Choose routing thresholds against measured correctness and expected review/fallback capacity. Include false-negative decisions, candidate
   omissions and confident errors in the analysis.
5. Keep an intermediate uncertainty band and an abstention route. Unsupported/undersampled buckets use fallback or flag-only review rather
   than borrowing an unrelated threshold.
6. Validate calibration and route error on the untouched test groups. Report ECE, Brier, reliability bins, risk/coverage and
   precision/recall with sample counts and intervals.
7. Requalify after changes to ontology definitions, checkpoint/runtime, question wording, option construction, tokenization, source domain
   or language scope. Minor operational changes require a documented compatibility check before reusing a calibration identity.

Thresholds must be stored in a versioned calibration artifact; no production thresholds are selected by this plan. A value such as 0.9 is
not a universal acceptance rule. Human decisions and source-integrity status remain independent of these scores.

## Deployment and outage policy

Operator-defined profiles determine permitted endpoints and secrets. Local private endpoints require explicit server configuration; browser
input cannot choose arbitrary network destinations. Each run also records whether source content may leave the machine and which fallback
transports are permitted. Local LAYA with a hosted CLI/API fallback is not an entirely local processing mode.

At run creation, choose an explicit outage policy: pause, or use the already configured generative fallback and flag its output for review.
A change from JEV to LAYA, a different checkpoint or a different generative model requires a new frozen attempt/configuration. No silent
provider substitution.

For local service measurements record CPU/GPU, resident memory, dtype, queue depth and competing work. Distinguish startup/device failures
from semantic uncertainty. Quotas, service availability and CLI authentication are operational conditions; preserve them in the attempt log
and comparison denominator.

## Cost and usage contract

Use a per-attempt ledger that can represent model-reported tokens, estimated tokens, provider-billed units when available, local compute
time, unknown usage and estimated USD. Keep proposer, decision, fallback, summaries, resolution and final verification as separate roles.
Their sum, including failed/repeated work, determines end-to-end cost.

JEV and local LAYA token counters need not count identical work. Do not compare raw token counts as if they were invoices. Local inference
includes compute/residency and operator cost assumptions; label those assumptions. CLI usage may be known while its incremental dollar cost
is unknown. Unknown is null, not zero, and cannot support a percentage-savings claim.

Before dispatch, reserve the full bounded attempt, including permitted retries and fallback. Stop new work when a configured
call/token/runtime cap is reached. If USD is unknown, enforce the known unit/time caps and keep dollar-budget status explicitly
indeterminate; do not imply that an unknown price guarantees staying under a monetary ceiling.
