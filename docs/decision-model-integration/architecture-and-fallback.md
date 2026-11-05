# Extraction architecture and bounded LLM fallback

Status: proposed implementation. Read [Current pipeline](current-pipeline.md) for existing behavior and
[Providers and calibration](providers-and-calibration.md) for adapter-specific constraints.

## Processing contract

Input is an approved ontology revision, immutable document text/chunks and an optional committed graph used for identity hints. Output is an
A-Box draft with per-assertion evidence, assessment history and review state. The decision provider cannot create ontology terms, execute
tools, change source membership, merge individuals or commit revisions.

Use one orchestration service inside OntoLab's Node backend. JEV is an external adapter; LAYA is initially an optional Python HTTP service.
Existing structured LLM calls remain the only path to generative API or CLI fallback. A new job queue or a second source database is
unnecessary.

## Ontology question compiler

Compile from the selected immutable T-Box, using its existing parsed model and supported reasoning facilities. Treat the following as
explicit compiler output, with a compiler version and content hash:

| Output                | Content                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Class cards           | Stable local choice ID mapped to a URI; label, definition, relevant parent definitions and known disjointness.                            |
| Data-property cards   | Meaning, eligible subject context, declared datatypes, literal handling and unit interpretation where the ontology actually specifies it. |
| Object-property cards | Meaning, direction, relevant domain/range information, inverses and supported restrictions.                                               |
| Question templates    | One narrow question for each type, value attribution, directed relation or support decision.                                              |
| Abstention options    | `none_of_candidates`, `insufficient_evidence` and, where appropriate, `outside_ontology`. These are routing outcomes, not new RDF terms.  |
| Constraint report     | Supported checks, unsupported OWL constructs and ambiguous/missing definitions.                                                           |
| Source requirements   | Which source spans, surrounding sentences, table headers or event qualifiers the question needs.                                          |

Keep each option self-contained. For opaque choice IDs, include the distinguishing definition in the option description. Ontology text and
document text are data, not instructions that can change the execution policy.

Use the current schema retriever for large ontologies, then retain needed ancestors and property context. Capture the actual shortlist in
the run. Measure shortlist recall independently. A low-ranked or unselected class is not proof that it cannot apply; an uncertain shortlist
can trigger a broader schema pass or generative fallback.

Do not equate OWL domain/range with a closed-world type filter. Missing types may be inferred rather than contradicted. Use supported class
closure and actual incompatibilities for pruning; otherwise retain the candidate and surface an ambiguity. Do not reinterpret multiple
domain axioms, unions or restrictions as a simple menu of alternatives. Unsupported semantics remain explicitly unchecked.

For class membership, prefer the most specific supported type without forcing a leaf when the source supports only a parent. Multiple
compatible asserted types require separate questions; superclass facts derived by a reasoner retain derived provenance and are not credited
as directly extracted claims.

## Candidate generation

### Initial verify-cascade mode

Use `extractABox` as the proposer. Its source-backed assertions become candidates. Existing conformance and quote location run before
decisions about acceptance. Preserve the original proposal even if a later assessment requests a correction.

This mode cannot detect every fact the proposer omitted. Add a bounded chunk-level coverage probe and a sampled omission audit. A positive
coverage probe only requests broader extraction; it cannot create a fact without a candidate and evidence.

### Later candidate-cascade mode

Candidate sources are deterministic number/date/identifier parsing, mention detection, existing graph identity candidates and, where needed,
a small generative mention extractor. All candidate sources are versioned and evaluated. A generative proposer is still part of the cost
even when JEV/LAYA makes the subsequent decisions.

Store an exact source span for each mention/value. Construct candidate entity pairs from sentence/paragraph/table context, coreference hints
and ontology compatibility. Enumerating every entity pair against every predicate grows quadratically and is not the default.

Use these initial application caps as pilot proposals, subject to development evaluation:

| Scope                                   | Initial cap             | Behavior at the cap                                                                |
| --------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| Entity mentions per decision window     | 32                      | Partition into source-preserving windows; flag unsupported cross-window scope.     |
| Directed relation candidates per window | 128                     | Keep the shortlist manifest and route overflow for broader extraction.             |
| Candidate assertions per chunk          | 256                     | Checkpoint completed partitions and mark incomplete coverage.                      |
| Choice options per question             | 16 including abstention | Use measured shortlisting or a separate hierarchical decision stage.               |
| Questions per request                   | 16                      | Also enforce actual provider token/body limits; a count cap alone is insufficient. |
| Fallback evidence clusters per chunk    | 2                       | Leave further unresolved work as candidates with a budget reason.                  |

These are OntoLab limits, not provider promises or optimal values. Hitting a cap must be visible in completion and recall reports. Never
claim complete extraction after dropping overflow.

Use the document's text-coordinate convention consistently. Python-side token/code-point spans must be converted and checked against
OntoLab's JavaScript UTF-16 offsets before persistence. Test repeated quotes, combining characters, emoji, OCR text and overlapping chunks.
Identical mention strings at different locations remain distinct occurrences until entity resolution establishes identity.

## Atomic decisions

| Family              | Question shape                                                                                                   | Important distinction                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Primary type        | Choice among relevant class definitions plus abstention.                                                         | Entity identity and class membership are separate.                                  |
| Additional type     | Per-class support question for compatible classes.                                                               | Do not force mutually exclusive selection when multi-typing is valid.               |
| Literal attribution | Choice among exact candidate span IDs for a subject/property.                                                    | Numbers are selected/copied, not generated by a Score primitive.                    |
| Literal support     | Entailed / contradicted / insufficient-evidence classification of the complete subject-property-value assertion. | Correct number, unit, subject and condition must all be supported.                  |
| Object property     | Support classification for an explicit ordered subject/predicate/object candidate.                               | Direction, negation and modality matter; several predicates can hold.               |
| Identity hint       | Choice among existing individual IDs, new individual and uncertain.                                              | This is a proposal for existing resolution machinery, not an automatic merge.       |
| Coverage            | Whether additional relevant source facts or missing candidates warrant another pass.                             | This is a routing signal with a measured miss rate, not a completeness certificate. |

Use `Choice` for exclusive support outcomes; compare that with Noul-based support as a declared ablation. Do not use one Choice over all
possible relations if multiple relations can apply. Do not interpret "not entailed" as "false in the world".

Questions in one request do not consume the answers to sibling questions. Make all referenced candidate assertions explicit in the state. If
relation questions depend on newly assigned types or identities, run a second durable stage or enumerate a bounded set of speculative
combinations and filter in code.

Preserve temporal, conditional and measurement qualifiers. If the ontology represents a treatment as an event, create an event candidate
with linked participants and values. If the ontology cannot represent an n-ary or qualified fact faithfully, mark a coverage issue rather
than flattening away the condition.

## Example

Ontology: `Sample`; `HeatTreatment`; `Quenching` subclass of `HeatTreatment`; `underwent` from Sample to HeatTreatment; `temperatureC` on
HeatTreatment with decimal values in Celsius.

Source: `Sample S1 underwent quenching at 850 °C.`

1. Retain source spans for `Sample S1`, `quenching` and `850 °C`.
2. Create stable candidate IDs for S1 and its described treatment; ask type and support questions.
3. Assess the directed `underwent(S1, treatment)` candidate and the attribution of the temperature to that treatment.
4. Copy/parse the selected literal in code, preserving the original unit-bearing span.
5. Assemble A-Box assertions with individual evidence references and run ontology/source checks.

With `S1 was heated to 850 °C before quenching at 600 °C`, value selection needs enough event context to distinguish the stages. Missing
that context triggers a larger source window or LLM fallback. Neither a high confidence on `850` nor a valid decimal makes its attribution
correct. These examples illustrate expected behavior and are not model measurements.

## Routing state machine

The proposed decision-attempt states are distinct from existing run statuses:

```text
prepared -> assessed -> checked -> ready_for_review
                  \-> escalation_pending -> fallback_completed -> reassessed -> checked
prepared/assessed/checked -> review_required | unsupported | budget_exhausted
any active stage -> operational_failure | cancelled
```

`ready_for_review` at the attempt level means a candidate is structurally ready for the existing fact-review policy; it does not mean an
entire run has finished or a graph has been committed.

| Signal                                                                                           | Route                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Supported assertion, qualified calibration bucket, exact source evidence and no blocking finding | Eligible for the configured review policy; initial pilots still flag every fact.                 |
| Ambiguous class, relation direction, value attribution or competing identities                   | Bounded targeted LLM extraction.                                                                 |
| No suitable candidate, candidate cap reached, coverage warning or uncertain schema shortlist     | Broader bounded source/schema pass, then fallback if permitted.                                  |
| Provider context overflow or evidence truncation                                                 | Repartition without losing necessary evidence; otherwise use a fallback with sufficient context. |
| Failed source, datatype or ontology check and fallback unused                                    | Targeted correction attempt.                                                                     |
| Same failure after fallback, disagreement with the verifier or unsupported qualification         | Human review or explicit abstention.                                                             |
| Missing ontology term                                                                            | Coverage issue outside the A-Box; no ontology change within this run.                            |
| Invalid response, missing key, model mismatch or unavailable service                             | Operational error or a preselected outage route. Never substitute a low semantic confidence.     |
| No permitted fallback, exhausted quota/budget or unresolved unknown call cost                    | Persist unresolved candidates; hold/pause/fail according to the explicit run policy.             |

A confident negative can still be wrong. Sample negative decisions and unprocessed passages for independent review; calibrating only
positive predictions will not measure silent loss.

## Fallback request and result

Reuse `callStructured`/`extractABox` and the provider catalog. Do not execute a CLI binary from a model response. The fallback receives:

- Exact immutable source window, adjacent context and table header/caption context where needed.
- Selected ontology cards and permitted URIs, including ancestor/property definitions.
- Source-backed candidate IDs and relevant committed individual IDs.
- Specific unresolved scopes and machine-readable reasons, such as `ambiguous_value_subject`.
- A response schema scoped to the requested individuals/assertions, with verbatim evidence for each proposed correction.

Exclude evaluator gold labels, held-out judgments and verifier confidence from the extraction prompt unless a separately labelled ablation
tests score visibility. A reason code may identify the ambiguity without leading the fallback toward a preselected answer.

Use at most one completed generative correction round per evidence cluster in the initial policy. The chunk cap above and a separate
run-wide fallback-call budget apply. Low-confidence or failed post-fallback checks do not trigger unbounded provider switching. A user may
explicitly start a new attempt, preserving previous evidence and usage.

Interpret the result as scoped proposals: `add`, `replace` or `leave_unresolved` against stable candidate IDs. Absence from the fallback
response cannot delete facts outside the scope. Recheck quotes, conformance, exact value handling, identity references and source support.
Conflicting candidates remain visible until review. The fallback's confidence statement is not acceptance evidence.

Respect existing CLI behavior: enabled/visible providers only, backend execution, private invocation context, no arbitrary tools, schema
validation and process cancellation. Record the selected model and actual CLI-reported identity/version when available. A provider's
`default` alias that cannot be resolved is labelled unpinned and excluded from strict model-comparison claims.

## Proposed configuration and data contracts

The following describes future types, not an existing API:

```ts
type DecisionMode = "off" | "shadow" | "verify-cascade" | "candidate-cascade";
type DecisionProvider = "jev" | "laya" | "mock";

interface DecisionRunConfig {
  version: 1;
  mode: DecisionMode;
  providerProfileId: string;
  ontologyRevisionId: string;
  ontologyHash: string;
  compilerVersion: string;
  candidatePolicyVersion: string;
  supportPolicyVersion: string;
  calibrationId: string | null;
  routingPolicyId: string;
  fallback: null | {
    provider: string;
    model: string;
    reasoningEffort?: string;
    maxCompletedRoundsPerScope: 1;
    maxCallsPerRun: number;
    maxInputTokensPerRun: number;
  };
}
```

Resolve the profile to a server-held endpoint, credentials and a pinned deployment manifest. Browser requests choose a permitted profile ID,
not a URL, filesystem checkpoint path, executable or API key. The frozen effective config additionally includes provider capabilities,
model/runtime revision, proposer identity, token limits, output reserve, timeouts, source-disclosure policy and price/accounting version.
Reject unrecognized fields.

Use separate immutable records:

| Record           | Required fields                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate set    | Source snapshot hashes, exact spans, entity/value/pair IDs, candidate-generator version, ontology shortlist and coverage limits.                               |
| Assessment       | Assertion/question ID, input hash, raw typed answer, distribution, native confidence semantics, model identity, context/truncation report and usage reference. |
| Routing decision | Policy/calibration identity, normalized decision fields, reason codes, selected next step and remaining budget.                                                |
| Fallback attempt | Scope, request/output hashes, configured and observed model, usage, completion/error, proposed changes and post-check result.                                  |
| Fact provenance  | Original extraction, source membership, supporting evidence, later assessments and supersession/review links.                                                  |

Add an optional assessment reference to evidence/fact metadata rather than overwriting `EvidenceRef.confidence` with a raw class
probability. If an existing review policy needs a scalar support score, populate it only with a named, validated support mapping and retain
the assessment reference. Never multiply unrelated scores into an invented probability of correctness. Existing human review decisions
retain precedence.

## Persistence, caching and recovery

Use the current `UserStore` project namespace and private blobs for bounded assessment artifacts. Keep small indexes/references in typed
run/checkpoint payloads. Do not put entire provider responses in every repeated evidence reference. Extend archive import/export with a
versioned optional manifest; old archives remain readable without inventing missing assessments.

Create independent cache identities for candidate generation, model assessment, routing and fallback. Include owner/project/corpus
namespace; full effective source context and spans; ontology hash and shortlist; relevant known-individual identity;
compiler/candidate/question versions; provider/model/runtime/token settings; and the calibration/routing identity where applicable. Fallback
caching also includes unresolved scope and generative provider settings. A changed threshold can reuse a raw assessment but must recompute
the routing record.

Add durable stages under the existing lease/checkpoint mechanism: prepare, assess partitions, route, fallback scopes, recheck and assemble.
Do not place several serial provider calls inside an existing step without reviewing its lease. Each bounded stage must fit the effective
call plus queue/deadline allowance, or implement tested renewal. Recheck run cancellation, authorization and source/ontology pins before
dispatch and before publishing a result.

Persist a request-start journal entry before a remote call and its result/usage afterward. There is exactly-once application of completed
work, not a promise of exactly-once external billing. A crash after transmission can leave the provider outcome unknown. Reconcile an
available provider receipt; otherwise mark unknown usage and account for it under a configured retry reservation before another call. Never
label an unknown attempt as free or replay it invisibly.

Pause stops new dispatch after the current bounded operation. Cancellation signals local work/process groups and aborts HTTP requests where
possible; a transmitted hosted call may still finish. Preserve completed assessments and uncertain billing. Resuming reuses completed
artifacts with matching identities and does not import a result into a changed run.

The corpus source fingerprint must include the frozen decision/proposer/fallback contract. Source replacement, ontology upgrades, changed
candidate policy or changed decision policy must produce a visible reprocessing plan, while old graph revisions continue referencing their
original evidence.

## Review and commit

The first functional pilot uses `evidenceGate: "flag"` and existing accepted-only corpus graph policy. Source checks, decision assessments,
validation findings and human judgments remain distinguishable. Decisions are shown per assertion with exact source context and routing
reasons.

Human corrections pass applicable datatype/ontology/source checks and retain their explicit user provenance. A user can choose a manual
assertion with its existing review semantics; it must not be relabelled as model-verified evidence. Corrected assertions re-enter the
bounded check stage rather than another automatic extraction loop.

Commit still uses existing revision concurrency and validation rules. Neither an adapter response nor fallback success writes directly to
the committed graph. Optional future automatic acceptance is enabled only for qualified buckets under [Evaluation](evaluation.md), and
cannot clear blocking validation findings.
