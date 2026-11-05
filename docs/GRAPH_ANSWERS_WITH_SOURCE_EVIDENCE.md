# Graph answers with searchable source evidence

OntoLab should extend **Ask** so a user can ask about a saved graph version,
read an answer, and inspect both its graph facts and the original source
passages. Search should also reveal useful source material that extraction
has not represented in the graph. Those passages can become proposals for
review, without changing the graph during a question.

The first release should make **answer → claim → exact evidence** reliable.
Keep the answer central, open the selected passage directly, and offer broader
source search as a separate action within Ask. Reuse OntoLab's React and Node
architecture with explicit source-inspection and retrieval contracts. Deliver the
source-backed graph-update workflow after the read-only journey is dependable.

This revised plan follows a code and prototype review on 3 November 2026.
The recommendations are design hypotheses to validate with users. The earlier
interactive preview is exploratory: its always-open result list, answer-mode
selector and immediate proposal action are superseded by the decisions below.

## Implementation status in this branch

### Section headings and publication titles

A later chunk proposed the page-2 heading “Plant modelling and Closed-loop
verification of the system” as a second title of the plant-model study. Its
quotation was correctly located, so location validation alone could not catch
the semantic error.

The chunk pipeline now checks titles after extraction and assertion review,
before caching. It omits an unreviewed section-heading title only when the same
identity already has a source-grounded root publication title from that document
and all evidence for the new title consists of that parsed section heading.
The original candidate, retained title and heading offsets are logged. Section
entities, alternate-title evidence, other documents, descriptions and existing
review decisions are preserved. Missing or ambiguous structural evidence leaves
the candidate for review. Extraction/review prompts explicitly distinguish
section titles from publication titles. Cache version is
`2026-11-publication-section-titles-v10`.

The evidence audit independently flags study titles matching body-section
headings. It detects the one original bad candidate, which the previous
location/identity audit missed. `scripts/replay-section-title.ts` applies the
production guard to the original saved pre-review checkpoint and prior identities;
only the offending title is removed and the inputs remain unchanged. This replay
is deterministic, not a new model extraction.

The fresh rerun uses the existing Codex CLI provider with `gpt-6.1-sol`, after
Gemini's monthly project spending cap blocked extraction and the user authorized
a CLI alternative. The harness accepts `RESEARCH_PROVIDER` and `RESEARCH_MODEL`
together; CLI execution also requires `LOCAL_CLI_ENABLED=1`. Mock mode stays off.
Both original PDF hashes are unchanged. This provider change prevents a controlled
comparison of model quality with the preceding Gemini run.

The identity audit distinguishes the two uploaded studies from additional
bibliography-only study mentions, requiring all evidence for those extra entities
to locate within References/Bibliography. It still fails on other extra identities.
The MUX coverage audit accepts source-grounded inputs on a named MUX entity and
an expected-output description as well as a result property; numeric values must
remain actual assertions, and the expected output must locate on page 4.

The fresh extraction completes 15/15 stages with 266 candidate facts and 290/290
located references. The two source titles are correct and no section-heading
titles remain. All 14 named coverage facets and nine answer cases pass; semantic
review corrects two drafts before display (full formula paths and ECC wording).
These are automated checks, not human scientific acceptance. The isolated graph
contains 39 agent source-reviewed facts. An earlier chunk-relative MUX statement,
source-vendor spelling corrections and bibliography-only studies remain excluded
and visible in the review set at
`output/research-e2e-section-titles-codex/review.html`.

The first browser attempt exposed a focus-restoration defect: citation rerendering
could leave the connected page body as the recorded origin. The Markdown link
renderer now has a stable component identity, keeping citation buttons mounted
while reading current callbacks and passage data from context. Closing evidence now
checks that the origin matches the saved citation selector and otherwise resolves
that citation again. Opening a whole answer's evidence clears any stale citation
selector. The browser regression suite explicitly checks that the citation stays
mounted and exercises activation with body focus; the initial failed attempt and
real follow-up are retained in the review artifacts rather than counted as a
first-attempt pass.

After the focus fix, the real browser journey passes: 9/9 method-answer citation
links, refresh, source search, a real Codex passage follow-up, mobile bounds and
focus restoration. Both browser regression suites pass. Final typecheck, lint,
918 tests (9 skipped), production build and documentation checks pass. The review
page retains both automatically corrected answer drafts, the initial browser
failure, source evidence, excluded candidates and the provider-change caveat.

### Recovery of invalid answer corrections

Semantic review v3 addresses two withheld answers from the `9b7c915` live-main
verification: a supporting quote was shorter than the required 20 characters,
and a proposed draft fragment used different capitalization from the actual
answer. A rejected location now receives at most one focused model repair.

The repair can only replace invalid location fields on the existing corrections.
Replacement text, reasons, valid fields and edit count stay unchanged. A draft
fragment may correct case/whitespace transcription only, and must then match a
unique exact substring. Every supporting quote must still be 20–2500 characters
and locate in its supplied source. Unavailable citations, changed target text,
overlap, omitted edits or a failed recovery still withhold the answer. The
original rejected edits and errors are retained in `repairAttempt`; usage includes
the recovery call. Only the fully checked answer is streamed and persisted.

`scripts/replay-semantic-locations.ts` replays each original failure three times
against its original draft and evidence with real Gemini calls. Set
`EVIDENCE_BASELINE` to the previous merged-main review directory,
`EVIDENCE_ENV_FILE` to the local credential file, and `EVIDENCE_OUTPUT` to the
new artifact directory. The report includes these original failures and their
recovered locations alongside fresh answers and extraction evidence.

Validation on the same PDF hashes: all six original-failure recovery replays
pass, and all nine fresh answer cases pass on their first attempt without
withholding or manual regeneration. Fresh extraction completes 15/15 stages
with 116 candidates, 127 located references and 14/14 named coverage facets.
The real browser follow-up and 24/24 method-answer citation links pass, along
with both browser regression suites. Typecheck, lint, 910 tests (9 skipped) and
the production build pass.

The new review set is `output/research-e2e-semantic-recovery/review.html`.
It flags a separate extraction error: the located page-2 section heading
“Plant modelling and Closed-loop verification of the system” was proposed as
an additional study title. This candidate is excluded from the 35-fact test
graph; the automated equivalent-title audit does not detect that semantic
misclassification. Human scientific acceptance and exhaustive recall remain
unestablished. The nine fresh answers did not need locator recovery; the six
preserved-failure replays specifically exercise that path with the real model.

### Scientific follow-up after merged-main validation

The follow-up on `71b3af8` addresses three findings from the main-checkout run:

- Later chunks omit an unlocated, unreviewed duplicate title only when the same
  subject already has an equivalent located title from that document. Whitespace
  and trailing footnote markers do not create a second title. Other titles and
  existing review decisions remain unchanged; the omitted assertion is logged.
- Assertion review receives explicit recommendation cues from the current source.
  A missing recommended action triggers at most one focused follow-up, using the
  same subject, property and source-line validation. Unresolved cues remain visible
  in run notes; a generic method description does not count as the recommendation.
- The answer checks preserve numeric testing capability instead of presenting it
  as observed completed coverage. This includes graph literals alongside document
  citations. A graph claim cannot override a document's capability qualifier.
  Literal check v4 and semantic review v2 retain drafts, evidence and corrections.

Extraction cache version is `2026-11-title-recommendation-coverage-v9`. The new
review set is `output/research-e2e-scientific-followup/review.html`; the original
main-checkout report remains preserved separately. Fresh extraction from the same
two PDFs produces 101 candidates with 117 located references, zero unlocated
quotations, zero equivalent duplicate titles, and 14/14 named coverage facets.
These are fixture checks, not exhaustive recall or human scientific acceptance.
The agent selected 33 source-reviewed facts solely for the isolated test graph.

Original-failure replays independently verify title deduplication, recovery of the
omitted recommendation, and real-model correction of “over 75 functions tested”
to “capable of testing over 75 standard functions.” The review set includes the
original chunks/answer, exact evidence, corrections and model usage. Reproduce
the answer replay with `EVIDENCE_BASELINE` pointing to the preserved review
directory and `scripts/replay-research-coverage.ts`; `EVIDENCE_ENV_FILE` supplies
local provider credentials and `EVIDENCE_OUTPUT` selects the artifact directory.

Validation: 900 tests pass (9 skipped), with typecheck, lint, production build and
five documentation checks passing. Both browser regression suites pass. All nine
fresh answer cases pass the fixture/source-fidelity audit, including the added
testing-capability question; the real-model browser follow-up passes as well.
The review includes 23 correctly rendered source links in the method answer,
exact passage navigation, refresh/deep links, search, mobile bounds and focus
restoration.

### Integration with current main

This branch was rebased onto `ade7529`, retaining the unified evidence inspector
and saved graph-version evaluations. The shared Ask executor preserves
`graphOnly` evaluation behavior and propagates evaluation failures for retry;
HTTP Ask separately retains interrupted or failed turns and their available
evidence. Retained search spans use their own keys and source offsets rather
than claiming to be extraction-input chunks. **Inspect saved source** opens the
shared inspector and returns to the selected passage; legacy citations retain
the existing inspector path. Ordinary document reading remains available.

The rebased validation passes 885 tests (9 skipped), the production app/docs
build, all five documentation checks, and the ontology check. The unified
inspector's 12 browser journeys and the source-search browser workflow pass,
including shared-inspector navigation, replacement/deletion history, mobile
bounds and focus restoration. CI now runs both browser suites using installed
Playwright Chromium and retains both sets of screenshots.

Live-model integration results are retained under
`output/research-e2e-main-integration/`. This run uses an isolated copy of the
same PDFs and the previously reviewed extraction; it regenerates answers
through the rebased shared service rather than claiming a new extraction run.
All eight final answers pass the fixture/source-fidelity audit, and the real-model
browser follow-up passes. The first batch is preserved separately: a review
confirmation with identical before/after text unnecessarily withheld one answer.
No-op proposals are now ignored; actual edits still require every evidence check,
and the affected case was regenerated successfully. Human scientific acceptance
remains pending. The earlier complete scientific review remains available below.

### Scientific validation before integration

The latest completion/wording review is in
`output/research-e2e-completeness/review.html`. The same two original PDFs were
uploaded, parsed and extracted again with real Gemini calls (mock mode disabled).
The unchanged hashes, full application state, raw answers and earlier failed
attempts are retained. The fresh run contains 104 candidate facts and 116 located
references, with no missing quotations, invalid offsets, page mismatches or
duplicate study identities. The agent selected 32 facts for the isolated test
graph; those test decisions are explicitly not human acceptance.

The MUX expected output is now a `reportedResult` literal on the existing
StandardFunctionTest identity: with index 2 and the stated time inputs, the
expected result is `2m30s`. Its evidence is copied from a contiguous source range
spanning pages 3–4. The assertion-review pass can now add missing properties to
up to 40 earlier identities from the same document, even when the current chunk
does not re-emit them. Earlier facts supply orientation only; new assertions need
current source lines. Prior assertions cannot be replaced, and earlier type
quotes or review decisions are not copied into the new chunk. Current extraction
quote repair precedes this pass. The fresh output retains the original type
location and adds the output with its own located evidence.

A deterministic label check retains a source-present acronym when a generated
parenthesized expansion is absent from the current source. This reduced
`EcoStruxure Automation Expert (EAE)` to `EAE`, preserving identity and `V21.2`.
The original label and correction remain in the run notes. This is a narrow
acronym-label check, not a universal entity-name verifier. Extraction prompt/cache
version is now `2026-11-continuations-source-names-v8`.

Answers with source passages receive one bounded semantic review before the
final literal check and before display. The semantic review proposes exact local
edits supported by located source quotations. Unknown citations, overlapping
edits, invented quotes and ambiguous draft fragments withhold the answer rather
than apply an unverifiable correction. The draft, edits, evidence, reasons and
review status persist with the answer; usage includes the additional call. The
review addresses names, transformation roles, scope, transition order and
expected-versus-observed distinctions, but remains fallible model judgment.

The literal guard is v3. In addition to prior PIPE/formula/recommendation checks,
it recognizes version-qualified product expansions (preserving the version when
falling back to an acronym), the observed real-examples-to-large-scale scope
substitution, and qualitative-speed-to-proof strengthening. These narrow checks
were added because repeated model-only replays missed known issues. Earlier
failed replays are preserved rather than hidden.

The final method answer distinguishes the RCM interface transformation from
FSM/ECC behavior and preserves sensor output after the non-deterministic
transition. The qualifier answer attributes the speed claim to the authors.
All eight final answers pass the independent fixture/source-fidelity audit;
the method and qualifier cases were regenerated after refinement. Four preserved
scientific-wording replays and two earlier PIPE/G-formula replays pass with the
real model. The fixed extraction checklist now covers 14/14 named facets,
including the actual MUX output value; it is not exhaustive recall.

Validation: `npm run check` passes 855 tests (9 skipped), the production build
passes, and the real browser workflow passes all 29 method-answer source citation
occurrences, refresh/deep links, context, source search, a real-model passage
follow-up, mobile bounds and focus restoration. Two final mock browser runs also
pass. An initial mock run timed out on focus restoration; the log is retained as
an intermittent UX observation, with no product fix claimed for it.

Remaining review limits: the paper itself labels its printed `G` formula as CTL;
that terminology is preserved for human interpretation. NLI verdict scores are
uncalibrated (96 at 0.1 and 20 at 0.95 in this extraction). The 14 named facets and
32 selected facts do not validate every candidate, every scientific claim, or
held-out documents. The report retains earlier NLI controls as historical
checks, clearly distinguished from this fresh run. Answer latencies on this small
corpus are recorded in `validation-summary.json`; broader production performance
and scientific acceptance remain to be evaluated.

### Previous scientific-accuracy iteration (preserved history)

The scientific-accuracy follow-up is retained in
`output/research-e2e-scientific-review/review.html`. Both original PDFs were
uploaded and parsed again with unchanged SHA-256 hashes, then extracted with
real Gemini calls and mock mode disabled. The fresh run produced 113 candidate
facts and 125 located references, with no missing evidence, invalid offsets,
page mismatches or duplicate study identities. Twenty-six source-reviewed facts
were selected by the agent for the isolated test graph; this is not human acceptance.

Extraction now requires explicit property arrays, so entity discovery does not
silently stand in for value extraction. A bounded second pass checks literal
coverage and semantic property mapping against original source lines. It checks
values/formulas, methods/recommendations, limitations and future work, allowing
at most 40 candidate additions or replacements per nonempty text chunk. It cannot
create identities, change types/links, or delete an assertion without a validated
replacement. Unknown properties, incompatible domain/range, invalid line ranges
and conflicting replacements retain the original candidate. Source ranges are
copied exactly; original assertions, reasons and model coverage assessments are
retained in the extraction notes. This adds one model call per eligible chunk;
estimates and extraction usage include that call. Prompt/cache version is v7.
The pass is a model judgment, not a guarantee of completeness or semantic truth.

The fresh output corrects non-determinism to a method description, recovers the
scalability limitation and trace/automation future work, retains recommended
Start/End removal, and extracts tested versions, formal notation and portability
findings with their stated roles. A fixed source-derived checklist finds 13 of
14 facets represented. The missing facet is the cross-page MUX expected output
as a literal value; source retrieval still exposes it. An unsupported EAE full
name remains in a candidate entity label and was excluded from the test graph.
The coverage pass currently operates on entities emitted in the current chunk;
it does not guarantee recovery of omitted assertions on earlier-chunk entities.

Answer instructions preserve recommendation strength, expected-versus-observed
results, model scope and source names, including avoiding bare externally known
product-name expansions. The first eight-case answer attempt exposed that bare-name
gap and is preserved separately. The fixture audit explicitly checks for it;
the production guard checks recognized definition patterns, temporal formulas
and matched 'it is better to' recommendations. The recommendation check was
added after another fresh answer regressed its wording, and was tested with
both repair and withholding. Earlier failed generations are retained. The two original PIPE/G-to-AG drafts still pass real-model
repair. Scientific judgments remain distinct from lexical and citation checks.

The NLI diagnostic passed simple positive/negative controls, but repeated the
prior 71 low verdicts; explanatory probes objected to ontology labels and missing
subject identity. The fresh run returned 32 verdicts mapped to 0.95 and 93 to 0.1.
These context-sensitive, variable label mappings are not calibrated truth
probabilities, and no review threshold was relaxed. Unit/integration validation:
839 passed, 9 skipped. See the latest packet's validation summary for final
answer and browser checks, plus remaining human-review priorities.

Previous iterations are preserved below for comparison.

The latest answer-fidelity follow-up is retained in
`output/research-e2e-answer-grounding/review.html`. It reuses the exact PDFs,
real extraction, twelve selected facts and saved revision from the preceding
run. Six new real-model answers, a real browser follow-up and separate replays
of the two failing drafts now pass the targeted regression checks. The final
method answer does not expand PIPE, and the comparison retains the source's
printed `G` formula. Both original failures also passed real-model repair.

`server/graphchat/sourceCheck.ts` checks recognized acronym-definition patterns
and parenthesized temporal formulas against the cited evidence, preferring
source passages when both source and graph references are present. Formula
matching ignores whitespace only, preserving operators, operands and case.
This is a narrow literal check, not a semantic-entailment or completeness gate.
The final answer round is buffered before display. A flagged draft receives one
bounded repair call; still-unsupported name expansions can be reduced to the
acronym without inventing a definition, then checked again. Unresolved formulas,
unknown repair citations or unusable repairs withhold the answer. Provider
failure and cancellation cannot release the unchecked final draft. Tool progress
notes remain separate from final answers.

Original drafts, repair drafts, removed expansions and issues are retained in
`agent.sourceCheck`, distinct from review decisions. Repair usage is included
in the answer's token usage. The streamed answer, persisted answer, copied text
and citation membership all derive from the checked final text. Two answers in
the final six-case run required definition repairs; none was withheld. An earlier
attempt that withheld the version answer is preserved for comparison.

Validation: 823 tests passed, 9 skipped; build and deterministic browser
regression passed. The real browser verified 22/22 method-answer source links,
each unique citation's saved excerpt, refresh, source search, context, a real
follow-up, mobile bounds and focus. The independent answer audit confirms no
unsupported PIPE expansion, the printed `G` HOME/END formula and equality of
streamed/persisted text in all six cases. The unchanged extraction still passes
its 71-reference location and two-study/title audit. Human review remains
necessary for broader wording (including recommended versus mandatory
Start/End removal), PDF spelling ("Schinder"), entailment-judge disagreement
and extraction completeness. The review packet distinguishes these issues from
the two resolved literal-answer defects.


The latest quotation/title follow-up uses the same two original PDFs and is
retained in `output/research-e2e-title-repair/`. PDF heading detection now keeps
adjacent title lines together and excludes email/keyword lines from heading
candidates. Chunk extraction budgets the compact identity index it actually
sends, so large evidence records no longer evict existing subjects. Same-source
identity hints preserve continuity across methods, results and conclusion.

Quote repair makes one bounded model call to select original source line
ranges. The application copies those ranges exactly, including intervening
footers/captions; it does not treat omitted text as an exact quote. This is
location repair, separate from the existing entailment and review gates.
Invalid coordinates, duplicate instructions and abstentions retain the
unverified reference. Notes preserve the previous quotation and selected range.
Complete title preservation applies only to a missing title on one eligible
entity already grounded in the complete source heading. It cannot merge
entities, guess between subjects or overwrite an existing title.

Fresh extraction completed 15/15 steps with 27 entities, 59 candidate facts and
71 located evidence records. The strict source audit passes: no missing or
unlocated quotations, invalid spans, or page mismatches. It also confirms two
study identities and both complete title properties. A separate real-model
replay repaired both original cross-page failures. Twelve facts (the core tool
links/types, two paper identities and titles) were source-checked by the agent
for the isolated graph; 47 remain candidates. This is not human acceptance.
The provider entailment judge marked all 71 references not entailed (mapped to
0.1); this disagreement remains visible. The fresh extraction omitted the
scalability limitation and classifies a non-determinism statement as a
limitation, so quotation/identity success is not a claim of complete or correct
semantic extraction. Source search retains the omitted conclusion.

The final six research questions and a real browser passage follow-up completed.
Citation/completion checks passed; the browser verified 21/21 clickable source
references, each unique method citation's exact saved excerpt, refresh/deep
links, context, source search, mobile bounds and focus restoration. Scientific
review flags remain: the method answer again expands PIPE beyond its cited
source, and the comparison changes printed `G` to `AG` and adds unsupported
exhaustive-state-space wording. These answers are retained unchanged in the
review packet. Mechanical checks are not semantic acceptance.

`npm run check` passed with 813 tests passed and 9 skipped. The review packet
preserves the development attempts and flags scientific wording separately
from the source-location and identity gates. Original PDFs and previous reports
remain unchanged. Reproduce the strict fixture audit with
`EVIDENCE_OUTPUT=output/research-e2e-title-repair npx tsx scripts/audit-research-evidence.ts`.

The Ask flow now includes saved-corpus source search, streamed citation
references, persisted excerpts and interrupted/failed attempts, an inspector
with saved-text context, passage-backed follow-up questions, citation links
that survive refresh, copy-with-sources and citation-issue recording. Version
switches cannot reuse conversation history from another graph scope. Existing
project Ask remains available; external graphs do not receive unrelated local
source passages.

Saved-source retrieval uses the recorded `saved-text-bm25-section-1200-v1`
keyword profile. It derives search passages from complete retained parsed
text, including text outside extraction chunks, and records coverage, source
manifest hash and revision hash. It currently loads/chunks snapshots per
request; materialized background indexes, dense retrieval, table-grid
reconstruction and production-scale performance measurement remain follow-up
work. Tables retain their saved parsed text and can be inspected in context.

Source-backed graph proposals remain phase 4. The existing general Propose
changes mode remains separate from this read-only evidence workflow. Human
usability testing and representative real-document answer-quality evaluation
remain required. The deterministic browser regression uses the offline mock provider; the research diagnostic below also exercises a real-model browser follow-up.
An additional seven-case diagnostic uses Gemini 3.8 Flash through the HTTP Ask
API, with mock extraction of a controlled synthetic source. It checks exact
citation offsets, source replacement, missing measurements and unavailable
snapshots; it does not establish production answer quality.

The real-model review led to concise, answer-first presentation guidance,
plain-text quantities, and verification limitations before graph details.
Source questions can search passages directly, and source search is not offered
when no saved documents are available. The real-model runner also flags raw
LaTeX, implementation jargon and a buried verification limitation.
Run it with `EVIDENCE_ENV_FILE=/path/to/.env EVIDENCE_OUTPUT=output/review-run
npx tsx scripts/evidence-real-review.ts` (real provider usage). Each run writes
verbatim answers, source excerpts, graph evidence and flags to `review.html`
and `results.json` in the selected output directory. Use a separate directory
to preserve baseline comparisons. Human claim-support review remains pending.

The preserved baseline real-document diagnostic uploaded two original four-page IEC 61499
research PDFs, parsed them, and ran Gemini extraction, entity resolution and
provider entailment scoring with mock mode disabled. It produced 35 entities
and 84 candidate facts; an agent checked and selected ten facts for an isolated
test graph, leaving 74 pending. Six research questions and a real browser
follow-up completed. This is not a release acceptance: grouped/mixed citations
failed navigation (one clickable source link for 23 occurrences in the method
answer); extraction included 21 facts without evidence and 16 unlocated quote
records; 41 extraction page labels disagreed with the quote offsets. Some
answers also elaborated beyond their cited evidence. These findings, original
PDFs, raw extraction, decisions and answers are retained in
`output/research-e2e/review.html`. The reproducible runner is
`scripts/research-evidence-e2e.ts` (extract/resume, answer and browser phases),
with `scripts/render-research-review.ts` for the local review packet. Test graph
decisions are explicitly agent decisions, not human acceptance. The browser
phase returns a failure exit code for the citation-rendering defect.

The follow-up fixes unify individual, grouped and mixed citation parsing across
rendering, copy-with-sources, saved citation membership, feedback and graph
references. Extraction now requires a quotation on each assertion, checks it
against current source blocks (excluding generated orientation), and makes one
bounded repair attempt. Unrepaired evidence remains visible and unverified.
Page labels come from the original document spans at the located offset.
PDF line-wrap matching preserves original offsets and numeric separators;
ellided quotations must match every retained segment. Scientific answer
guidance prohibits unsupported acronym expansion, unmarked generalization and
rewriting the source's formal notation.

A fresh run on byte-identical PDFs is retained in
`output/research-e2e-final/`. Extraction completed with 33 entities and 79
candidate facts: zero missing quotations, zero wrong page labels and zero
invalid located spans. Two quotation records remain unverified because the
model joined text across a footer and figure caption without marking an
omission. Ten assertions were source-checked by the agent for the isolated
test graph, with 69 left pending. Split titles, duplicate study identities and
provider entailment judgments remain explicit human-review items. Changed
fact counts are stochastic extraction outputs, not a measured recall gain.
The diagnostic audit intentionally fails its strict all-quotes-located gate
for those two records; they have not been silently accepted. Run it with
`EVIDENCE_OUTPUT=output/research-e2e-final npx tsx scripts/audit-research-evidence.ts`.

The final six-question answer rerun and one real-model browser follow-up
completed with no citation-resolution or completion flags. All 21 source
reference occurrences in the method answer were clickable; every unique
method citation opened its matching retained passage. Refresh/deep links,
saved context, search, mobile bounds and keyboard focus passed. The final
comparison labels its inference, retains the printed `G` notation and explicitly
limits verification to the model and modeled assumptions. Remaining wording
and extraction issues are listed in the updated review packet. The intermediate
answer attempt is preserved as `answers-before-scope-refinement.json`.

Verification: `npm run check` passed (803 tests passed, 9 skipped); the Vite build
and deterministic browser regression passed. After the final prompt refinement,
typecheck/lint and seven focused tests passed. The review HTML itself was checked
for working citation jumps, local source links, narrow-screen overflow and
browser errors. See `output/research-e2e-final/review.html` and
`validation-summary.json`. These checks do not replace human scientific review.

Run `npm run check` and `npm run test:evidence:e2e`. The latter builds the app
and documentation, then drives the actual UI against an isolated local server
and temporary corpus using installed Chrome. It saves a screenshot under
`output/playwright/evidence-inspector.png` and removes the temporary data.

## Current implementation and gaps

Analysis baseline: OntoLab `6b63afd` (3 November 2026). The following
integration decisions use OntoLab's existing services and retained-source model.

| Existing capability | Integration implication |
| --- | --- |
| [Graph chat](../server/services/graphChat.ts), `answer()`, supplies `searchDocuments` only when the revision has no corpus graph state. | Corpus graphs need a search path over retained inputs. Removing this condition would search current chunks and lose historical consistency. |
| [Corpus graph state](../src/types/corpus.ts), `CorpusSourceRecord`, records member, document, checksum, fingerprint and run. | Resolve eligible sources from the selected revision, including runs reused from earlier versions. |
| [Input snapshots](../server/services/research.ts), `snapshotRunInputs()`, retain full parsed text, document metadata and extraction chunks. [evidenceSnapshot()](../server/services/corpora.ts) exposes saved text after corpus access checks. | Build an internal snapshot loader that returns passage text and identity. The existing viewer response deliberately strips chunk text. Load each run once, then select its pinned documents. |
| [Hybrid search](../server/services/assistant.ts), `hybridPassages()`, combines keyword ranking and dense vectors with reciprocal rank fusion. | Reuse its ranking concepts, but accept an explicitly resolved snapshot collection rather than loading current project documents. |
| [Vector index](../server/services/vectorIndex.ts), `chunkVectors()`, keys entries by chunk ID and text hash within an embedder namespace. | Snapshot indexes need run/source identity and processing contracts; a mutable chunk ID alone cannot address two historical occurrences. |
| [Graph backend](../server/graphchat/backend.ts), `projectBackend()`, queries the effective graph. [graphAbox()](../server/services/ontology.ts) enforces corpus accepted-only behavior. | Preserve this policy. Source search can surface unrepresented text, but it does not promote that text into accepted facts. |
| [Evidence panel](../src/features/assistant/EvidencePanel.tsx) already provides graph, queries, results, answer and trace. [Source viewer](../src/features/evidence/useEvidence.tsx) opens retained inputs when a reference contains a run. | Add a Sources view and an inline inspector. Retain technical query/result views behind progressive disclosure. |
| [Turn execution](../server/graphchat/turn.ts) assigns passage markers, deduplicates by chunk ID, shows at most 1,500 characters per passage, and keeps only short tool previews. [Citation persistence](../server/services/graphChat.ts) stores the first 160 characters of cited chunks. | Retain exact visible excerpts, full passage identity and selected supporting spans. The first 160 characters may not include the material supporting the answer. Stream references before saving the final message. |
| [Conversation loading](../server/services/assistant.ts), `loadConversation()`, returns an existing conversation without checking the requested local revision. `prepareChat()` resolves the backend separately. | Enforce one answer scope before constructing either retrieval branch. A revision switch must start a new scoped conversation or explicitly fork the old one. |
| [Assistant evaluation](../eval/harness.ts) currently invokes `assistant.ask()`, not graph-chat `prepareChat()` / `runTurn()`. | Add evaluation of the production graph-chat path. Existing assistant scores cannot establish the new feature's quality. |
| [Live answer rendering](../src/features/assistant/AssistantPage.tsx) supplies no `onSource` callback to `Markdown`; source buttons can render before they have an action. | A streamed citation must resolve to a usable reference or visibly say it is still loading. Test before the message is saved. |
| [Source viewer](../src/features/evidence/useEvidence.tsx) resolves titles from current documents and offers an ordinary Documents link even for saved evidence. | Use retained document metadata and a snapshot-aware reader route, preserving historical offsets and identity. |
| [Proposal service](../server/services/assistant.ts), `propose()`, edits an A-Box from instructions and history. [Corpus editing](../src/lib/corpusGraph.ts), `corpusUserEdit()`, preserves trusted evidence and treats new unmatched claims as manual. | Pasting a quote into the existing Propose mode is insufficient to create trusted source provenance. A dedicated validated handoff is required. |

## Critical review and design decisions

The primary user is a domain specialist checking a finding and its conditions.
Graph engineers also need query diagnostics, but those details should follow
the evidence. The current proposal has useful versioning foundations; the
main weaknesses are interaction overhead and overstated evidence semantics.

| Priority | Problem in the initial design | Revised decision |
| --- | --- | --- |
| P0 | “Quote located” can look like a verdict that the answer is correct. | Show quote location beside the passage; show assertion review separately. Never display a single green “verified answer” status. |
| P0 | “Source only” or “not yet recorded” can turn a failed match into a claim that a fact is absent. | Default to “From source”; say “No linked graph fact” when no provenance link exists. Claim absence only after a defined, adequate graph lookup. |
| P0 | The mockup's mode selector changes a displayed answer immediately, while the stored citations and scope could remain unchanged. | Remove the mode selector from the primary flow. Advanced scope choices affect a new request; a new answer retains its own evidence and configuration. |
| P0 | Search results and citations are mixed, making a newly found passage appear to support a saved answer. | Keep “Used in this answer” distinct from “Search saved sources”. Explicitly using new evidence creates a new answer. |
| P0 | A source passage about test conditions can be attached to the wrong treatment, material or experiment. | Preserve specimen, material, test identity, units and conditions; unresolved identity remains visible before any graph proposal. |
| P1 | A search box, three tabs and a result list precede the selected quote; a citation click still requires hunting. | Open the selected claim and its exact passage first. Put other evidence and search behind deliberate actions. |
| P1 | The preview offers two mostly rearranged layouts without evidence that users need a separate source workbench. | Ship one Ask workspace with an on-demand inspector. Treat a source workbench as a later hypothesis for sustained comparison work. |
| P1 | The initial journey promises source-backed proposals before defining the additional provenance work they require. | Ship saved-source search and inspection with a small production-path benchmark. Follow with validated review handoff; keep the full evaluation UI and retrieval tuning later. |
| P1 | The preview has no working follow-up composer and stacks the inspector below the answer on small screens. | Keep follow-up questions available; on narrow layouts replace the content with a focused inspector and restore the exact answer position on Back. |
| P1 | Happy-path checks do not establish whether users understand missing sources or conflicting studies. | Prototype unavailable, partial, ambiguous and contrasting evidence before implementation; evaluate comprehension as well as task completion. |

## Recommended user experience

### Ask with one clear context

Keep **Ask** as the main entry point and default to graph plus saved sources.
Use one visible context control: “Graph v3 · sources saved with this version”.
Reuse [CorpusScopeBar](../src/features/corpora/CorpusScopeBar.tsx) and the Ask
header so they cannot show contradictory scope or duplicate version pickers.
When inspecting an older answer, its context comes from that answer. A newer
workspace selection must not relabel it.

Keep model selection and graph-only answering under existing settings. Source
search is a browsing action and does not require choosing an answering mode.
Starter questions should reflect available data and operations, including a
conditions question; avoid promising evidence that the scope cannot provide.

When the user chooses a different graph version during a conversation, offer
one explicit “Ask in v4” action that opens a new conversation with their draft
question preserved. Returning to the old answer restores v3. Carrying a question
forward must not treat old answers as evidence for the new version.

For this feature's first release, use saved graph versions. If a draft is
selected, offer “Ask about saved v3” or the existing save/review action; do not
silently substitute it. If no saved graph exists, provide the existing graph
creation path and explain when saved-source answering becomes available.
Preserve existing legacy project/connected-graph Ask behavior outside this scope.

### Read the answer before opening evidence

For the example question “Which heat treatments improved fatigue performance,
and under what test conditions?”, the answer should identify treatments from
graph results, attach conditions from source passages, and name any missing
conditions. This is an illustrative journey, not a finding about bundled data.

Lead with a short conclusion. Use a comparison table only when the question
needs one, with treatment/material, outcome, conditions and evidence columns.
Cite the individual finding or condition, rather than applying one citation
to a whole row containing claims from several sources. Avoid universal claims
such as “Treatment A improves fatigue” when the source reports one test group.

Keep the inspector closed until a citation or “View evidence” is selected.
Use compact citations with useful accessible names such as “Fatigue study,
page 5”; internal `Q1` and `C2` identifiers belong in Details. Graph-only
results can say “Graph result” and open the assertion or aggregate scope.
A citation by itself says where a claim came from, not that a reviewer approved
the answer. Display only material limitations next to the affected statement.

Keep a small answer footer with “View evidence” and “Search saved sources”.
If counts are shown, distinguish documents from passages; ten overlapping
chunks from one document are one source, not ten corroborating sources.
Keep the follow-up composer in the same workflow, with its scoped context.

### Inspect the selected claim directly

A citation opens a side inspector, with the selected claim at the top, followed
by the supporting quote or table rows. Do not put search results ahead of the
selected passage. Show, in this order:

1. The claim or condition being inspected, and its answer context.
2. Retained document title, saved version and page/section; the exact span with
   enough surrounding text to interpret pronouns, exclusions and conditions.
3. Table headers, caption, units, footnotes and relevant rows when available.
4. The linked graph assertion and its actual review origin, if a link exists.
5. “More context”, other evidence for this claim, and “Search saved sources”.

Queries, raw rows, ranking inputs and model assessments remain in a collapsed
Details disclosure. A graph view is a contextual action for a relation or path,
not a compulsory tab. Do not duplicate the answer in a separate Answer tab.
For claims without source provenance, show the graph assertion and explain
that its document evidence is unavailable; search hits are only related
material until an actual supporting link is established.

Open saved parsed text by default. An original PDF or original table is an
optional view only when retained bytes and mapping are available; label parsed
text and reconstructed tables accurately. An “Open current document” action
must visibly change source version and must not reuse old offsets.

On narrow layouts use a full-width evidence view with “Back to answer”. Keep
the selected claim visible, restore scroll and focus to its citation, and make
browser Back behave consistently. Close/Escape restores focus on desktop.
Do not auto-scroll or change the active inspector when new tokens or evidence
arrive. Announce completed stages and loading failures, not every streamed token.

### Search beyond the answer

“Search saved sources” opens a distinct search state within the inspector.
It uses the same pinned source collection as the answer, while “Used in this
answer” remains a stable list. Prefill an editable search from the selected
claim, or the original question when no claim is selected. Submit a search
explicitly; local filtering of already loaded hits may be immediate.

Group hits by document, with a relevant excerpt, location and further passages
available on expansion. Deduplicate overlapping passages and preserve table
context. Show bounded counts such as “8 passages from 3 documents”; do not
imply an exhaustive match count from a top-k response. Add document and section
filters only where metadata supports them. Preserve the query, filters and
result position when opening a hit and returning.

Label new results “Not used in this answer”. An explicit “Ask using this
passage” action sends a new question/turn with validated passage references
and the same scope; it does not edit the old answer or silently add citations.
Keep an easy path back to the selected claim. Broader search must never widen
to current documents or another corpus automatically.

### Handle uncertainty and interruption

| State | User-facing behavior | Recovery |
| --- | --- | --- |
| Answer is streaming | Show only actual stages, keep Stop available, and make each citation usable as its reference arrives. | A pending reference says “Loading source”; an invalid one is explicitly unavailable, never a dead button. |
| Some saved sources are not searchable | Show “Searched 8 of 12 saved documents” only when measured; otherwise say coverage is incomplete. Separate index coverage from retrieval relevance. | View affected sources or retry readiness; a later answer uses a newly recorded manifest. |
| Search completes with no hits | Say “No matching passages found in these saved sources”. | Edit query or clear filters in the same scope. Do not infer that the underlying fact is false or absent. |
| Source or index service fails | Keep usable graph results, and label the answer as based on graph results only for this attempt. | Retry source search; incorporating recovered evidence produces a new answer. |
| Old snapshot is missing | Show any retained excerpt as “Saved excerpt; full source unavailable”. | Explain which context is unavailable; offer current documents only as a separate, explicit scope. |
| Quote is located but support is uncertain | Show the passage and the claim together, without a correctness badge. | Let the user report “Does not support this claim” or inspect more context. |
| Sources differ | Keep both findings and their material/test conditions visible; say when comparability is unresolved. | Inspect each source. Do not average outcomes or label disagreement as contradiction without matching context. |
| User stops or connection drops | Preserve the typed question and available answer/evidence, marked incomplete. | Retry as a separate attempt; retain the previous attempt and prevent duplicate saved messages. |
| A newer graph version exists | Keep the old answer explicitly attached to its version. | “Ask in latest version” creates a new scoped conversation. |

Use plain-language source availability messages and report actual coverage.
Do not make users diagnose embedding models or retrieval services. Technical
causes and timings remain available in Details.

### Evidence labels

| Label | Meaning |
| --- | --- |
| In graph | The assertion is present in the selected effective graph. Show human acceptance, automatic acceptance or unavailable review history when inspected. Older facts without review metadata must not be described as human-reviewed. |
| From source | The statement was drawn from a cited passage. This does not establish whether an equivalent fact exists elsewhere in the graph. |
| No linked graph fact | No validated claim-to-assertion link is available. This is a provenance limitation, not proof of absence. |
| Quote located | The displayed quote maps to the saved parsed text. This is the existing viewer's useful terminology. |
| Model assessed | An optional model estimate of relevance or claim support, with scorer/version and explanation available. |
| Needs review | A proposed assertion awaits the normal review process. |
| Source unavailable | Retained text or mapping is missing. Do not replace it with the latest document. |

Keep source integrity, retrieval relevance, claim support and fact review in
separate fields. A relevant hit can be accurately located and still fail to
support a particular claim. Two studies with different materials or conditions
are not automatically contradictory.

### Introduce review handoff after evidence inspection

In the next phase, offer “Prepare graph proposal” from a selected passage.
First resolve the subject, experiment/material context and ontology property;
show ambiguous candidates or missing schema terms explicitly. In the heat
treatment example, a load ratio belongs to the correct fatigue test, not
automatically to the treatment entity. Then show the small candidate change,
its source spans and differences from existing assertions before adding it to
the review queue. Keep accept/reject decisions in the existing review surface.

The handoff must be a dedicated server operation that resolves evidence from
trusted passage IDs. It must preserve location, source version and originating
answer, check duplicates and rejected claims, and initially mark new assertions
as candidates. Reuse review and commit infrastructure, but do not rely on
`propose()` plus an instruction containing a quote to establish provenance.
If the graph changes while preparing a proposal, show the new diff and require
review against the new base. A retry must reuse the same proposal operation.

Add “Copy answer with sources” and “Report citation issue” as compact answer
actions once answer bundles are stable. Copied references retain title,
location and version; links retain normal access checks. Feedback identifies
the answer, claim and passage so it can become an evaluation case without
changing the answer or its source text.

## Evidence and retrieval capabilities

| Capability | Implementation in OntoLab | Sequence |
| --- | --- | --- |
| Source inspection | Exact source-span inspection, structural context, table rows and explicit unavailable mappings. Keep model input inside Details. | First release |
| Shared search service | One bounded search path for Ask, manual evidence search and evaluation; record candidates, selection, timing and shortfalls. | First release |
| Versioned retrieval settings | Immutable settings with preview, history and optimistic activation. Begin with one recorded default profile; expose tuning after the feature works. | Internal contract first; settings UI later |
| Evaluation and review | Source-based judgments, blinded comparisons, immutable reports and development/held-out separation. | Small baseline first; workspace later |
| Indexed retrieval | Optional indexing behind OntoLab's service contract, with snapshot filters applied before ranking. | Conditional on measured scale |
| Reranking | Optional reranking with bounded candidates and explicit failures, inputs and provider costs. | After a controlled comparison |

Implement these capabilities within OntoLab's existing API, identity system and
ingestion workflow. Keep physical index collection names and document-specific
assumptions behind service contracts. Table-aware chunks and reranking remain
experiments requiring controlled measurements on OntoLab documents; do not
assume they improve ranking or extraction quality.

## Integration architecture

Resolve a single authorized `AnswerScope` before loading the graph, history or
source index. It should contain corpus/project ID, revision ID and content
hash, effective review policy, pinned source tuples, and retrieval profile ID.
For a corpus, check both corpus access and access to its parent ontology.
The server derives source membership from the revision; clients cannot supply
arbitrary run IDs, storage paths or index filters.

The graph branch queries the effective revision. The source branch searches
only its pinned snapshots. They meet at an evidence bundle containing query
records, assertion references, passages and claim-to-evidence links. A graph
query is evidence of what the graph says; link it to source evidence through
the existing fact keys and `EvidenceRef`s where present. Manual facts may have
no document evidence. Aggregates need their query, scope and contributing
assertions; property paths and aggregate results should not be represented as
a single source-verified edge.

For known graph assertions, resolve their existing provenance first. Run
retrieval to discover additional relevant material or fill information gaps.
Finding a similar sentence about the same entity does not establish a causal,
numeric or experimental relationship. Persist the method of each link:
existing assertion provenance, model-proposed association, or human review.
Only a validated exact assertion match may appear as a linked graph fact;
semantic suggestions stay suggestions until resolved.

### Snapshot passage identity and coverage

Use a stable identity such as:

```text
passageKey = hash(corpusId, documentId, runId, parsedTextHash,
                  passagePolicyHash, start, end)
```

Keep revision membership separately so identical passages can be reused across
versions. A run may contain several documents, and a revision can reuse sources
from several runs. A passage must match the pinned document/run pair, not just
belong to any run visible to the user.

Retained extraction chunks are useful for an internal prototype; `onlyChunks`
can restrict the inputs captured by a run. Product search requires a complete
passage manifest for each searchable saved document, generated from retained
full text and structural spans under a versioned search policy. Record
missing/unreadable documents separately, and disclose partial document coverage
when applicable. Keep derived search passages distinct from the chunks actually
seen during extraction. Indexing all available text does not make ranked search
exhaustive or prove that every relevant passage was returned.

Store displayed source text separately from dense embedding input and lexical
input. Record parser, chunking, embedding and tokenizer contracts. Validate
source offsets and text hashes; use UTF-16 offsets consistently with OntoLab's
JavaScript slicing. An adapter that supplies code-point offsets must convert
them explicitly and test non-BMP characters.

### Proposed service contract

Add `server/services/sourceRetrieval.ts` with an entry point equivalent to
`searchEvidence(ctx, resolvedScope, query, filters, profile, signal)`. Both the
model's `search_documents` tool and the user-facing evidence search call it.
Start with a local adapter using keyword ranking and the existing embedding
machinery; build per-snapshot derived indexes that survive changes in current
files. Persist an index manifest with completeness and contract state.

Proposed API routes, not existing endpoints:

```text
POST /api/projects/:pid/revisions/:revisionId/evidence/search
GET  /api/projects/:pid/revisions/:revisionId/evidence/passages/:passageKey
```

A hit should return passage identity, source title, pinned source version,
location, exact displayed text, context/structure references and explicit
`factRefs` when a real match exists. Search responses also return resolved
scope, profile/contract hashes, candidate counts, result shortfall, coverage,
timings and any degraded mode. Do not present rank-fusion scores as confidence
percentages or compare raw graph and passage scores directly.

Record the retrieved set separately from the passages cited in the answer.
Persist exact model-visible excerpts and claim references in an evidence
bundle; extend `AgentTrace`, `Citation`, `Passage` and `ChatEvent` compatibly.
Marker deduplication must use passage keys, not chunk IDs. A citation should
locate the relevant supporting span within the visible excerpt, with the whole
passage and its context available for inspection.

The minimum bundle needs the following fields so the UI can implement the
revised journey without guessing:

| Record | Required behavior |
| --- | --- |
| Answer context | Resolve scope once before backend/history construction. Store revision/content hash, effective review policy, manifest ID, retrieval profile and actual degraded mode per attempt. |
| Answer claim | Stable claim ID or persisted answer-segment address, text, query/assertion references and passage references. Validate reference existence and scope on the server; this validation does not itself prove entailment. |
| Evidence passage | Stable passage key, retained document title/version, text hash, exact shown excerpt and its offsets, claimed supporting span, structural context and source availability. Display the full shown passage when an exact supporting span is not available. |
| Graph link | Revision-scoped assertion identity, link method and review origin, including an explicit unknown/unresolved state. A query citation alone cannot establish every contributing assertion. |
| Retrieval record | Query, filters, manifest/coverage, selected/candidate counts, timings and captured results. Keep manual search results out of the existing answer's citation set. |
| Attempt state | Preparing, answering, complete, interrupted or failed, plus a stable request ID and save status. Retrying cannot duplicate or overwrite an earlier answer. |

Stream citation references with loading/resolved/unavailable states before
they become active controls. Keep citation identity scoped to the answer,
since different turns can both use `C1`. Ignore stale search responses after
the user changes query or answer; cancellation should stop outstanding work
where supported. An answer/evidence deep link resolves its saved scope and
rechecks access before opening. Old messages without these fields keep their
existing viewer, with a clear limitation where only a short excerpt survives;
do not fabricate claim mappings for historical answers.

Warm indexes after a graph version is saved, through resumable derived work.
During cold indexing show progress and offer explicitly labelled keyword-only
results where available. Bound candidates, context expansion and concurrent
embedding calls; propagate cancellation. A partial manifest must report
partial coverage. Avoid synchronous whole-corpus embedding during the first
question, and retain a usable graph answer if source indexing fails.

External connected graphs need a separate, explicit source binding. Do not
attach unrelated local project documents to a live GraphDB or Neo4j query.
Where no source binding or upstream provenance exists, show graph/query
evidence and state that document evidence is unavailable.

## Delivery sequence and acceptance

The first release is phases 0–3 below. Phase 0 is a bounded prototype review,
not a dependency on a large research study. Phases 1 and 2 establish contracts
that phase 3 must use; production-path evaluation begins with phase 1. Phase 4
extends the feature into graph editing. Do not put its button into the shipped
UI until the source-backed handoff works.

| Phase | Deliverable and main code | Completion gate |
| --- | --- | --- |
| 0 · Validate the journey | Revise the preview to one Ask layout with a composer, citation-first inspector, separate search state and representative failure states. | A pilot can verify a condition and return to the answer without navigating technical tabs. Confirm the terminology does not overstate trust. |
| 1 · Resolve context and persist evidence | `server/services/graphChat.ts`, `server/graphchat/turn.ts`, `src/types/graphChat.ts`, `src/types/project.ts`, conversation loading. Add revision-switch guards, answer-scoped references and captured attempt/bundle state. | Graph, history and sources use one authorized scope. Streamed citations work before save. Wrong-scope references, duplicate retries and missing historical fields are handled. |
| 2 · Search saved sources | New `server/services/sourceRetrieval.ts` and snapshot loader/index adapter; reuse `research.ts`, `corpora.ts` and ranking primitives. Add saved metadata, manifests and keyword/dense retrieval with explicit availability. | Source replacement, removal and rechunking leave old snapshots intact. Full available text is covered even after an `onlyChunks` extraction. Missing documents are visible; ranking cannot cross scope. |
| 3 · Ship Ask and inspection together | `AssistantPage.tsx`, `Markdown.tsx`, `EvidencePanel.tsx`, `graphChat.ts`, `useEvidence.tsx` and `DocumentViewer.tsx`; add a source-search/claim-inspector component. | One citation action exposes the selected evidence. Search/back preserves context. Follow-up questions, interrupted attempts and small-screen focus work. Include copy-with-sources and citation feedback using stable references. |
| 4 · Add review handoff | Dedicated validated proposal operation using the passage loader, plus existing draft/review/commit infrastructure. | Correct subject/test identity, units, ontology mapping, candidate status and retained provenance survive the handoff. Duplicate/rejected claims and stale bases have explicit outcomes. |
| 5 · Improve retrieval and expert workflows | Full evaluation workspace, tuning controls, source comparison, optional reranking or Qdrant. | Add each component only after measured quality, latency, capacity or observed workflow needs justify it. |

Within phases 1–3, add meaningful tests for revision switching, immutable
source resolution, permissions, offset handling and citation binding. Test
non-BMP characters, overlapping passages, tables with footnotes, multiple runs
for the same document, known assertions without provenance, and old answers.
Use browser checks for live citation clicks, back/focus restoration, late
search responses, refresh/deep links, cancellation and narrow layouts. Run the
relevant existing repository checks before declaring implementation complete.

## Quality and usability gates

Start with a proposed 30-question set across graph facts, table conditions,
multi-hop relations, aggregates, missing knowledge and misleading evidence.
Keep paraphrase families together; declare development and held-out splits
before tuning. Include an old source version and a replaced current document.
The set is a starting design, not a statistically sufficient universal benchmark.

Compare graph-only, passage-only and combined answers with the same pinned
sources and declared model/configuration budgets. Evaluate document ranking
and passage usefulness separately. Grade factual correctness, citation
precision and coverage, appropriate abstention, graph/source separation and
source-version consistency. Review pooled evidence with system names hidden;
keep machine judgments separate from human decisions. Track unjudged results.

Measure time to first useful answer, first clickable evidence, total p50/p95
latency, search failures, model cost and cold-index time. Measure warm and cold
behavior separately and include failures. Set numeric performance targets from
the baseline and representative corpus sizes; do not display speculative ETAs.

Use a small pilot with five representative users as an initial formative test,
not proof of general usability. Proposed acceptance targets:

| Task | Observable target |
| --- | --- |
| Verify a condition | At least four of five users find the correct supporting span and test context within 30 seconds, without help. |
| Find additional evidence | At least four of five search, inspect a hit and return within 60 seconds, understanding that it was not part of the saved answer. |
| Interpret trust | Every participant can distinguish quote location from claim correctness and identify whether review was human, automatic or unknown. Any observed conflation requires a design revision. |
| Handle an old or incomplete source set | At least four of five identify which version was used and which sources were unavailable before judging the answer. |
| Use keyboard or a narrow screen | Verify a citation, navigate back and continue the question with no lost focus, content or answer context. |
| Prepare a proposal in phase 4 | Resolve the correct test/material identity and understand the proposal is pending review, without assuming it changed the graph. |

The 30/60-second targets are provisional task targets, not achieved results.
Run the same tasks against current Ask and the revised prototype to detect
whether the added evidence workflow helps. Record errors and explanations, not
just completion time. Prioritize the first confusing interaction before adding
more controls or building the source workbench.

All historical-scope and authorization fixtures must pass. Citation references
must resolve to the exact saved excerpt or explicitly report unavailability;
unsupported claims, absent review history and partial search must not receive
a correctness badge. Judge answer support through source review in the
production graph-chat evaluation. Internal contract tests alone cannot prove
that an answer is supported.

## Remaining decisions and working defaults

Proceed with domain specialists as the primary audience, graph plus saved
sources as the default, and one Ask workspace. Validate these assumptions in
phase 0. Use the current user-selected model/provider settings; expose any
additional paid model step before the action that starts it. Build lexical
search independently of answer generation so evidence browsing remains useful
when a generation provider is unavailable. If this feature attracts sustained
multi-document comparison work, evaluate the source workbench in phase 5.

The updated first release prioritizes finding and checking evidence. A faithful
review handoff then completes the question → evidence → proposed fact → reviewed
graph loop without conflating any of those states.
