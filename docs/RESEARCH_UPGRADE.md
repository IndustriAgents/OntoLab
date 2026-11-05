# Research upgrade (October 2026)

This change maps the 2024–2026 ontology-engineering literature (ISWC, ESWC,
EMNLP, OAEI) onto each OntoLab section. It runs in research order: a trusted
schema first, then evolution and alignment, then fact quality, then the
feedback loop. Each capability has an ablation switch and an eval metric, so
OntoLab can serve as the testbed for the three studies in the research plan.

## What changed, by section

| Section | What is new | Main code |
| --- | --- | --- |
| Validate | **Reasoning** tab. Clashes and unsatisfiable classes, each with the axioms that explain it. OWL and hand-validator findings are merged, so a root cause is reported once. | `src/lib/ontology/reasoner/` (OWL 2 RL), `server/services/reasoner.ts`, `server/services/validation.ts` |
| Ontology → Modules & changes | Change validation runs the reasoner. A class the change makes unsatisfiable is an error. A changed entailment between two existing terms is a warning, with its explanation. | `src/lib/ontology/validate.ts` |
| Ontology → From documents | Every induced term carries a quote, and unlocatable ones are flagged (or dropped with `strictGrounding`). A new **axioms** step proposes disjointness, restrictions, inverses and characteristics, and only reasoner-safe ones are kept. Repair is a loop of up to three rounds that sees unsatisfiable classes as well as pitfalls. Missing CQ terms are fed to the prompt. | `server/services/induction.ts`, `server/services/inductionAxioms.ts` |
| Ontology → Review | Sources and admitted/rejected axioms are shown. An advisory **semantic review** by the model is added. Alignment has a structural matcher (tiered), `related` and `candidate` relations, per-matcher scores, and coherence repair on accept. | `server/services/semanticReview.ts`, `server/services/alignment.ts`, `server/services/review.ts` |
| Overview → Requirements | CQs are mapped to terms, with schema and data answerability badges, a stale-query chip, and an "update stale queries" action. Questions can be generated from the ontology, and semantic duplicates are marked. A list shows the terms the ontology lacks. | `server/services/answerability.ts`, `server/services/requirements.ts` |
| Runs | Each run freezes its configuration (`run.config`). The cache key includes the ablation switches. Proposals are classified (new / synonym / specialisation / conflict); a synonym becomes `skos:altLabel`. Impact analysis runs before a commit: entailment diff, new unsatisfiable classes, CQ regressions. Facts the ontology cannot express are kept and can be **replayed** after the term is added, or their chunks **re-extracted** (`onlyChunks`). | `server/services/runs.ts`, `server/services/proposals.ts`, `server/services/review.ts` |
| Explore | **Facts to review** queue: least certain first, keys j/k/a/r, accept, reject or reopen. Each claim shows its review state in the inspector. | `src/features/explore/ReviewQueue.tsx`, `src/lib/ontology/factReview.ts` |
| Overview → Settings | Review policy: every fact except rejected (default), accepted only (commits ask first), or all. It applies to export, queries, validation, reasoning and Ask. | `server/services/ontology.ts` (`graphAbox`), `server/services/projects.ts` |
| Export | Provenance mode "Full provenance (PROV-O)": one `rdf:Statement` per claim with a Web Annotation of its quote and offsets, the run, the confidence and the review state. Rejected facts are never exported. | `src/lib/ontology/aboxSerializer.ts` |
| Evidence check | The NLI premise is the quote plus one sentence either side. A "distinct" merge decision is recorded as `owl:differentFrom`. | `server/services/verification.ts` |
| Eval | New stages `extension` and `alignment`. Induction now reports axiom P/R/F1, schema-level CQ coverage, and LLMs4OL tasks B and C. Extraction reports calibration (ECE, Brier, selective accuracy) and auto-accepted precision. There is an OAEI loader, `--ablate`/`--grid`, study presets in `eval/grids/`, and new gates. | `eval/research.ts`, `eval/oaei.ts`, `eval/harness.ts`, `eval/run.ts` |

## Reasoning tiers

- **RL (default, in process).** A hand-written OWL 2 RL forward chainer over the parsed T-Box and A-Box.
  - It records a justification for every derived fact, so it can explain each finding.
  - It covers disjointness through inferred types, sameAs/differentFrom, functional and inverse-functional properties (under the unique-name assumption), irreflexive, asymmetric and disjoint properties, and max cardinality.
  - It finds unsatisfiable classes: disjoint parents, existential fillers that clash with range, domain or allValuesFrom, and min > max.
  - It does not reason over individuals that existentials imply, and it ignores unions, complements and nominals. Reports say so under "Not checked".
- **DL (optional).** `sidecar/reasoner`: Java 17, OWL API 5 and HermiT behind `POST /reason`. It is enabled by `REASONER_URL`. If it fails, the server falls back to RL and says so.

## Ablation switches (`RunOptions`)

| Switch | Applies to | Effect |
| --- | --- | --- |
| `promptStyle` | extraction | `code` or `tree` rendering of the T-Box |
| `schemaRetrieval`, `schemaTopK` | extraction | `auto` / `off` / `force` per-chunk schema retrieval (EDC) |
| `evidenceGate` | extraction | `auto-accept` / `flag` / `off` fact review |
| `onlyChunks` | extraction | re-extract only these chunks |
| `cqGuided` | induction | steer by purpose, scope and CQs |
| `inductionAxioms` | induction | the axioms step |
| `repair` | induction | the reasoner + pitfall repair loop |
| `strictGrounding` | induction | drop terms without a supporting quote |

Each run stores its full configuration in `run.config`. Configurations never share cached chunk results.

## Verification performed

- `npm run check`: typecheck, lint and tests all pass.
- Mock eval smoke runs:
  - `--stages induction,extraction,extension,alignment` completes.
  - `--grid eval/grids/study1-cq-tbox.json` writes one result per configuration.
  - The extension protocol runs end to end: held-out recovery, commit, replay and re-extraction.

## Not done / open

- **The DL sidecar has never been built or run.** There is no JDK on the development machine. The first `docker build sidecar/reasoner` is its first compile. ELK is not bundled.
- **No real-model runs yet.** Nothing has been run against a real model: none of the new prompts (emit_axioms, emit_cq_terms, emit_tbox_cqs, emit_review), and no real eval or study grid. These cost money; run them only when asked.
- **No OAEI tracks are bundled.** See `eval/gold-oaei/README.md`.
- **The gold T-Boxes contain no disjointness or restrictions**, so the axiom metrics can only reward subClassOf, domain and range until the gold set is extended. The pending human review of the gold set still applies.
- **Deferred:**
  - The optional entity-centric "graph judge" pass (GraphJudge).
  - Temporal fact validation.
  - RDF-star export.
  - The LLMs4OL challenge-JSON loader (tasks B and C are computed from the induced ontology instead).
  - Assistant "Propose" producing T-Box change sets.
  - Restoring the advisory T-Box coverage panel (`/api/suggest-tbox`). CQ gaps and proposals now cover most of what it did.
- **Storage.** Research data lives in JSON content and Postgres jsonb columns.
