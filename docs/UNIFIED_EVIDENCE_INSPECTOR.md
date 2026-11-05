# Unified evidence inspector

OntoLab uses one evidence inspector across Explore, corpus review, Assistant citations, ontology terms, documents, Chunk Lab, workflow preparation, and Run Inspector. It combines source checks and structural reading with retained run inputs, assertion review, and graph revisions. The integration uses the existing Node services and storage adapters.

## User experience

Choose **Inspect evidence** beside an assertion, quote, document, or chunk. The inspector opens alongside the workspace on desktop and as a focused drawer on smaller windows. **Expand reader** provides more reading space. Closing, Escape, or browser Back restores the workspace selection; closing restores keyboard focus to the triggering control where it is still present.

In Assistant, legacy source citations open the shared inspector in the answer evidence panel. Retained-source answers first open the exact searchable passage, with **Inspect saved source** opening the shared inspector for its stored citation. **Back to answer evidence** returns to the answer, query selection, and evidence tab. Document dialogs in a corpus suspend while the inspector is open, preserving their local view and chunk configuration.

The inspector separates three questions:

| Signal | Meaning |
| --- | --- |
| Quote location | Exact, normalized, or partial match; not located; mismatched stored offsets; vision only; or no recorded location. |
| Claim support | The recorded support score and review flag for this particular quotation and assertion. A located quote does not establish claim support. |
| Review decision | Awaiting review, automatic acceptance/rejection, a reviewer's acceptance/rejection, or legacy acceptance without a recorded decision. |

Checks that do not apply to a raw document or passage are omitted. Parsed-text integrity, original checksums, structural paths, and technical identities are available in source details. Reading an original file verifies its checksum before returning its bytes.

**Source** is the initial tab. It shows a bounded excerpt with a highlight, a source switcher when several references are attached, and page/section information when recorded. A parsed table keeps its headers and marks the cited rows. For XML, **Original structure** resolves a recorded element path against the verified original and preserves table cell spans, captions, and footnotes. Text and XML render as text nodes.

**Model input** loads stage-specific generation passages, added context, selected schema, recorded retrieval backend identity, and support-check inputs. It distinguishes **Recorded**, **Reconstructed from recorded policy**, **Not recorded**, and **Reused result**. A planned chunk omitted from a saved sample is not shown as an input that the model read. Vision stages identify their retained document rather than substituting parsed text for image input.

**History** links the selected processing version, retained run, producing stage, graph revision, and recorded review state. It does not invent a complete event log for older records.

**Accept in draft**, **Reject in draft**, and **Undo decision** use the existing working-copy editor. Opening an assertion flushes already pending edits first. Reviewing a current saved graph creates a draft; the saved graph remains unchanged. Historical saved versions stay read only until restored through the existing history workflow.

## Historical source identity

The `inspect` URL parameter contains a bounded target descriptor. `evidenceSource`, `evidenceTab`, and `evidenceExpanded` retain the selected source and presentation. Fact targets also select their graph revision through `rev`. Copying a link or reloading preserves this context and continues to require project access.

Run references resolve from the saved `ResearchInputs` snapshot. Source names and parsed text come from that snapshot, including when the current document inventory no longer contains the source. Existing corpus source records and producing revision ancestry resolve older references without an explicit run ID. New ordinary extraction evidence also records its producing run ID.

A missing snapshot gives an explicit unavailable state. Saved chunks can still be displayed when the full historical text was not recorded. Current text is never substituted for missing historical text. An ordinary document target explicitly inspects the selected processing document; an unsaved chunk experiment is labelled **Preview**.

**Open in Documents** retains `run`, document ID, and highlight coordinates. Both ordinary projects and corpus workspaces use the retained reader for these links. Removing an ordinary document can remove its original bytes while leaving run text available. Corpus replacement keeps prior source versions; an earlier graph keeps its earlier evidence.

All existing OntoLab text offsets use UTF-16 units. The detailed quote matcher preserves normalization and first-occurrence behavior, handles PDF line wrapping, and requires every elided quotation segment to occur in source order. A stored location that no longer reproduces its quote is reported as a mismatch instead of being moved to another occurrence.

## Implementation map

| File | Responsibility |
| --- | --- |
| [`src/types/evidence.ts`](../src/types/evidence.ts) | Targets and versioned inspection, input, structure, and retained-text responses. |
| [`server/services/evidenceInspector.ts`](../server/services/evidenceInspector.ts) | Authorization, target/source associations, snapshot resolution, bounded projections, integrity checks, and original XML/table views. |
| [`src/lib/evidenceApi.ts`](../src/lib/evidenceApi.ts) | Inspection, original, structure, and retained-text HTTP calls. |
| [`src/lib/evidence.ts`](../src/lib/evidence.ts) | Quote/review labels and table-row presentation from parsed text. |
| [`src/lib/sourceQuote.ts`](../src/lib/sourceQuote.ts) | Detailed match outcomes while retaining the original locator contract. |
| [`src/features/evidence/useEvidence.tsx`](../src/features/evidence/useEvidence.tsx) | Shared provider, URL state, focus, working-copy integration, and compatibility hook. |
| [`src/features/evidence/EvidenceInspector.tsx`](../src/features/evidence/EvidenceInspector.tsx) | Source, original structure, model input, history, and review presentation. |
| [`src/features/evidence/evidence.css`](../src/features/evidence/evidence.css) | Desktop docking, expanded reader, small-window layout, and source highlights. |
| [`server/services/verification.ts`](../server/services/verification.ts) | Persists premise, hypothesis, actual scorer ID, and threshold on new support checks. |

The existing `useEvidenceViewer` remains the compatibility entry point. Fact, term, passage, document, and answer callers use stored target identities. Compatibility references carry a quotation only as a locator: browser-supplied scores, claims, and review flags do not establish authoritative support.

## HTTP contract

All paths are relative to the application mount prefix and require access to `:pid`.

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/api/projects/:pid/evidence/inspect` | Read-only projection for `{target, sourceIndex?, part?}`. Inputs are loaded only on request. |
| POST | `/api/projects/:pid/evidence/original` | Re-resolve the selected association and return original bytes after checksum verification. |
| POST | `/api/projects/:pid/evidence/structure` | Resolve `elementIndex` from recorded paths, verify the original XML, and return a bounded element/table view. |
| GET | `/api/projects/:pid/runs/:runId/documents/:did/evidence` | Full retained text and chunk metadata for an explicit document-reader request. |

`part` selects `overview` or `input`. The existing corpus evidence endpoint remains compatible. The inspector does not introduce a separate review mutation: working-copy autosave retains the existing revision preconditions and draft behavior.

The server checks project ownership and target membership: revision/assertion, run/document/chunk/stage, and conversation/message/citation. Query evidence can return recorded query/results without manufacturing a document citation. Internal blob paths and owner IDs are excluded from inspection responses. Original XML lookup accepts an index into recorded paths, not a client-supplied XPath or file path.

Default excerpts include nearby context and remain bounded to approximately 10,650 characters. Other limits are 1,000 source references per target, 100 table rows, 5,000 original table cells, 24,000 characters per input block, 32,000 characters of original element text, and 64,000 characters of element XML. Original XML element inspection is limited to 10 MiB files. Truncation and unavailable mappings are visible.

## Verification

Run the application checks and the isolated browser suite:

```sh
npm run check
npx playwright install chromium
npm run test:evidence:e2e
npm run build
```

[`tests/evidenceInspector.test.ts`](../tests/evidenceInspector.test.ts) exercises the real HTTP app with isolated storage: access and association validation, quote/support independence, source switching, removed documents, missing snapshots, normalized/elided/Unicode quotes, mismatched offsets, cache reuse, missing generation recordings, support-check inputs, original integrity, XML/table structure, term builds, and stored answer/query citations.

[`scripts/evidence-e2e.ts`](../scripts/evidence-e2e.ts) builds on the real production SPA and HTTP services with an isolated local store. Generation uses the offline mock provider; controlled assertion fixtures exercise known review states. It checks twelve browser journeys:

- Explore source/claim checks and source/tab persistence after reload.
- Draft creation, saved-graph immutability, review, Undo, and persisted acceptance.
- Copied evidence links and retained document-reader links.
- Preservation of existing editor changes and keyboard focus.
- Chunk Lab navigation and browser Back.
- Exact Run Inspector stage inputs.
- Original XML table structure and cell spans.
- Assistant return navigation, expansion, and small-window reading.
- Ontology term sources from a saved build.
- Corpus review and suspended document dialogs.
- Saved corpus evidence after source replacement.
- Removed originals, desktop/narrow layouts down to 320px, and Escape.

The browser run writes its report and screenshots under `output/evidence-e2e/` and removes its temporary store. It does not write to the user's running application database or call paid providers.

The `evidence-browser` job in `.github/workflows/ci.yml` runs these journeys on every pull request and push to `main`. It installs Chromium with its Linux dependencies and retains reports and screenshots for seven days, including failure artifacts. The job uses offline generation and needs no provider secrets.

## Boundaries and further work

Complete historical provider requests and embedding payloads are not universally recorded. The inspector exposes available artifacts and labels gaps. Parsed Markdown tables are distinguished from original XML tables. PDF/image originals use the native viewer where possible; text overlays require recorded page geometry and are not synthesized.

Source replacement comparison, conflicting-source comparison, evidence coverage across a whole graph, and proposing missing knowledge remain independent extensions. The inspector does not change retrieval ranking, graph-chat passage-search scope, or require Qdrant or a Python sidecar.
