import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage, Conversation, RunView, DocumentText } from "../src/types/project.ts";
import type { FactRow } from "../src/lib/ontology/factReview.ts";
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e");
const availableFiles = new Set(await readdir(out));
const read = async <T>(name: string) => JSON.parse(await readFile(join(out, name), "utf8")) as T;
const state = await read<{ corpusId: string; revisionId: string; documents: { id: string; name: string; sha256: string }[] }>("state.json");
const run = await read<RunView>("run.json");
const facts = await read<FactRow[]>("facts.json");
const decisions = await read<{ key: string; reason: string }[]>("decisions.json");
const selected = new Set(decisions.map((d) => d.key));
const answers = await read<{
  model: string;
  results: {
    id: string;
    q: string;
    expected: string;
    answer: ConversationMessage;
    flags: string[];
    checks: { ref: string; exact: boolean; page?: number }[];
  }[];
}>("answers.json");
const browser = await read<{
  passed: boolean;
  coreWorkflowPassed: boolean;
  citationRendering: { expectedSourceLinks: number; actualSourceLinks: number };
  checks: string[];
  errors: string[];
}>("browser-checks.json");
const comparison = await read<{ metric: string; before: string | number; after: string | number }[]>("comparison.json").catch(() => []);
const comparisonBaseline = await read<{ href: string; label: string }>("review-baseline.json").catch(() => ({
  href: "../research-e2e/review.html",
  label: "Preserved baseline review",
}));
const quoteReplay = await read<{ passed: boolean; before: FactRow[]; after: FactRow[] }>("cross-page-replay.json").catch(() => null);
const priorities = await read<{ title: string; detail: string; factKeys?: string[] }[]>("review-priorities.json").catch(() => []);
const notes = await read<Record<string, string>>("review-notes.json").catch(() => ({}) as Record<string, string>);
const science = await read<{
  scope: string;
  represented: number;
  total: number;
  checks: { id: string; expectation: string; represented: boolean; factKeys: string[] }[];
  wrongMappings: string[];
  entailmentScores: Record<string, number>;
}>("scientific-coverage-audit.json").catch(() => null);
const answerReplay = await read<{
  results: {
    id: string;
    text: string;
    passed: boolean;
    sourceCheck: NonNullable<NonNullable<ConversationMessage["agent"]>["sourceCheck"]>;
  }[];
}>("answer-check-replay.json").catch(() => null);
const semanticReplay = await read<{
  results: {
    id: string;
    text: string;
    passed: boolean;
    semanticCheck: NonNullable<NonNullable<ConversationMessage["agent"]>["semanticCheck"]>;
  }[];
}>("semantic-replay.json").catch(() => null);
const priorGuardAttempt = await read("answers-before-expansion-fallback.json").then(
  () => true,
  () => false,
);
const priorAnswerAttempt = await read("answers-before-scope-refinement.json").then(
  () => true,
  () => false,
);
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const scientificArtifacts = [
  ["scientific-coverage-audit.json", "Coverage audit"],
  ["scientific-claim-review.json", "Agent claim-by-claim review"],
  ["assertion-review-audit.json", "Extraction corrections and original values"],
  ["nli-control-probe.json", "Retained entailment controls (see run notes)"],
  ["nli-explanations.json", "Prior judge disagreement"],
  ["provider-switch.json", "Provider change and comparison limits"],
  ["browser-regression-history.json", "Initial browser failure and focus fix"],
  ["validation-summary.json", "Validation summary"],
]
  .filter(([file]) => availableFiles.has(file))
  .map(([file, label]) => `<a href="${esc(file)}">${esc(label)}</a>`)
  .join(" · ");
const answerMarkup = (text: string, id: string) =>
  esc(text).replace(
    /\[((?:[CQ]\d+)(?:\s*[,;]\s*[CQ]\d+)*)\]/g,
    (_match, refs: string) => `[${refs.replace(/[CQ]\d+/g, (ref) => `<a href="#${esc(id)}-${ref}">${ref}</a>`)}]`,
  );
const source = (id?: string, page?: number) => {
  const d = state.documents.find((d) => d.id === id);
  return d ? `<a href="sources/${esc(d.name)}#page=${page || 1}">${esc(d.name)}${page ? ` · page ${page}` : ""}</a>` : "Source unavailable";
};
const documents = new Map(
  await Promise.all(state.documents.map(async (d) => [d.id, await read<DocumentText>(`sources/${d.name}.parsed.json`)] as const)),
);
const extractionSource = (e: FactRow["evidence"][number]) => {
  const actual =
    e.start == null ? undefined : documents.get(e.documentId || "")?.pages.find((p) => p.start <= e.start! && e.start! < p.end)?.page;
  const lastPage =
    e.end == null ? undefined : documents.get(e.documentId || "")?.pages.find((p) => p.start < e.end! && e.end! <= p.end)?.page;
  return (
    source(e.documentId, actual ?? e.page) +
    (lastPage && lastPage !== (actual ?? e.page) ? ` · continues on ${source(e.documentId, lastPage)}` : "") +
    (actual && actual !== e.page
      ? ` <strong>Page metadata mismatch: extraction said ${e.page}, saved offsets locate page ${actual}.</strong>`
      : "")
  );
};
const followupConversation = await read<Conversation>("browser-followup.json");
const scienceCard = science
  ? `<section id="scientific-review"><h2>Scientific accuracy and extraction coverage</h2><p>${esc(science.scope)} ${science.represented}/${science.total} named facets are represented; ${science.wrongMappings.length} non-determinism-as-limitation mappings remain.</p><p>${esc(notes.scientificReview || "These are agent checks against the original sources, not human acceptance.")}</p><p>${scientificArtifacts}</p>${science.checks
      .map(
        (c) =>
          `<details><summary>${c.represented ? "Represented" : "Missing / needs review"} · ${esc(c.id)}</summary><p>${esc(c.expectation)}</p>${c.factKeys
            .map((key) => {
              const f = facts.find((f) => f.key === key);
              return f
                ? `<p>${esc(f.label || f.individualId)} · ${esc(f.propUri)}</p><pre>${esc(f.value)}</pre>${f.evidence.map((e) => `<p>${extractionSource(e)}</p><pre>${esc(e.quote)}</pre>`).join("")}`
                : "";
            })
            .join("")}</details>`,
      )
      .join(
        "",
      )}<p>Provider verdict-to-score counts: ${esc(JSON.stringify(science.entailmentScores))}. These fixed scores are not calibrated truth probabilities.</p></section>`
  : "";
const followupAnswer = followupConversation.messages.at(-1)!;
const followupQuestion = followupConversation.messages.at(-2)!;
const followupCard = `<section id="browser-followup"><h2>Real browser passage follow-up</h2><p>${esc(followupQuestion.content)}</p><pre>${esc(followupAnswer.content)}</pre><p>Completed using ${esc(followupAnswer.agent?.model)}. The selected passage and any additional retrieved evidence are retained below. Review whether the answer respects their scope; human support review remains pending.</p>${(followupAnswer.agent?.passages || []).map((p) => `<details open><summary>${esc(p.ref)} · ${esc(p.title)}</summary><p>${source(p.evidence.documentId, p.evidence.page)}</p><pre>${esc(p.evidence.quote)}</pre></details>`).join("")}</section>`;
const replayCard = quoteReplay
  ? `<section id="quote-repair"><h2>${esc(notes.quoteReplayLabel || "Original cross-page quotation regression")}</h2><p>Real-model replay of both previously failing references: <strong>${quoteReplay.passed ? "passed" : "FAILED"}</strong>. The application copied the model-selected line range directly from the unchanged saved PDF text. Footers and captions inside the range remain visible. This verifies location, not scientific entailment or human acceptance. <a href="cross-page-replay.json">Full replay and original quotations</a>.</p>${quoteReplay.after
      .map(
        (f) =>
          `<details><summary>${esc(f.key)}</summary><h3>Before — unlocated</h3><pre>${esc(
            quoteReplay.before
              .find((b) => b.key === f.key)
              ?.evidence.map((e) => e.quote)
              .join("\n"),
          )}</pre><h3>After — exact saved source range</h3><p><a href="sources/iec61499-portability.pdf#page=2">Original PDF · pages 2–3</a></p>${f.evidence.map((e) => `<p>Offsets ${e.start}–${e.end} · ${esc(e.status)}</p><pre>${esc(e.quote)}</pre>`).join("")}</details>`,
      )
      .join("")}</section>`
  : "";
const answerCheckCard = (answer: ConversationMessage) => {
  const check = answer.agent?.sourceCheck;
  const literal = check
    ? `<details><summary>Source-fidelity check: ${esc(check.status)}</summary><p>${esc(check.scope)}</p>${check.issues.map((i) => `<p><strong>${esc(i.kind)}:</strong> ${esc(i.fragment)} — ${esc(i.reason)}</p>`).join("")}${check.draft ? `<h3>Original draft — withheld from the answer stream</h3><pre>${esc(check.draft)}</pre>` : ""}</details>`
    : "";
  const semantic = answer.agent?.semanticCheck;
  return (
    literal +
    (semantic
      ? `<details><summary>Scientific wording review: ${esc(semantic.status)}</summary><p>${esc(semantic.scope)}</p>${semantic.repairAttempt ? `<h3>Automatic correction-location recovery</h3><p>One bounded repair was attempted. Original rejected edits and validation errors:</p><pre>${esc(JSON.stringify(semantic.repairAttempt, null, 2))}</pre>` : ""}${semantic.edits.map((e) => `<h3>Correction</h3><pre>${esc(e.fragment)}</pre><h3>Replacement</h3><pre>${esc(e.replacement)}</pre><p>${esc(e.reason)}</p>${e.sources.map((s) => `<p>${esc(s.ref)}</p><pre>${esc(s.quote)}</pre>`).join("")}`).join("")}${semantic.draft ? `<h3>Original draft — retained for review, not displayed as the final answer</h3><pre>${esc(semantic.draft)}</pre>` : ""}${semantic.error ? `<p>${esc(semantic.error)}</p>` : ""}</details>`
      : "")
  );
};
const semanticReplayCard = semanticReplay
  ? `<section id="semantic-replay"><h2>Scientific wording regression replay</h2><p>${semanticReplay.results.length} preserved answers were reviewed again with the real model against their original evidence. <a href="semantic-replay.json">Full before/after audit</a>. <a href="semantic-replay-before-ref-normalization.json">Initial withheld attempt</a> · <a href="semantic-replay-before-targeted-checks.json">Model-only repeat failures before targeted checks</a> · <a href="answers-before-final-wording-checks.json">Earlier full answer batch</a>. These are targeted regressions, not a general accuracy score.</p>${semanticReplay.results.map((r) => `<details><summary>${esc(r.id)} · ${r.passed ? "passed" : "FAILED"}</summary>${answerCheckCard({ agent: { semanticCheck: r.semanticCheck } } as ConversationMessage)}<h3>Final replay text</h3><pre>${esc(r.text)}</pre></details>`).join("")}</section>`
  : "";
const answerReplayCard = answerReplay
  ? `<section id="answer-repair"><h2>Real-model replay of preserved failing answers</h2><p>The preserved drafts were checked and repaired against their original saved evidence. <a href="answer-check-replay.json">Full audit and before/after answers</a>. <a href="../research-e2e-title-repair/review.html">Original evidence and prior review</a>. This check covers recognized definitions, notation and recommendation wording, not every scientific inference.</p>${answerReplay.results.map((r) => `<details><summary>${esc(r.id)} · ${r.passed ? "passed" : "FAILED"} · ${r.sourceCheck.issues.length} original issues</summary>${r.sourceCheck.issues.map((i) => `<p>${esc(i.kind)}: ${esc(i.fragment)}</p>`).join("")}<h3>Original draft</h3><pre>${esc(r.sourceCheck.draft)}</pre><h3>Repaired answer</h3><pre>${esc(r.text)}</pre></details>`).join("")}</section>`
  : "";
const decisionReason = new Map(decisions.map((d) => [d.key, d.reason]));
const cards = answers.results
  .map(
    (r) =>
      `<section id="${esc(r.id)}"><h2>${esc(r.id)}</h2><h3>Question</h3><p>${esc(r.q)}</p><p><strong>Expected behavior (prepared from the PDFs before answering):</strong> ${esc(r.expected)}</p><h3>Actual answer — verbatim</h3><pre>${answerMarkup(r.answer.content, r.id)}</pre><aside><strong>Flags and review</strong><p>${esc(r.flags.join("; ") || "Mechanical checks passed. This does not establish claim support.")}</p><p>${esc(notes[r.id] || "Human claim-support review pending.")}</p></aside><p>${esc(r.answer.agent?.completion)} · ${((r.answer.agent?.durationMs || 0) / 1000).toFixed(1)} s · source coverage ${r.answer.agent?.sourceCoverage?.available}/${r.answer.agent?.sourceCoverage?.total}</p>${answerCheckCard(r.answer)}<h3>Captured evidence</h3>${(r.answer.agent?.passages || []).map((p) => `<details id="${esc(r.id)}-${esc(p.ref)}" ${r.checks.some((c) => c.ref === p.ref) ? "open" : ""}><summary>${esc(p.ref)} · ${esc(p.title)} · ${esc(p.where)} · ${r.checks.some((c) => c.ref === p.ref) ? "cited" : "retrieved, not cited"}</summary><p>${source(p.evidence.documentId, p.evidence.page)} · saved offsets ${p.evidence.start}–${p.evidence.end}</p><pre>${esc(p.evidence.quote)}</pre></details>`).join("") || "<p>No source passages; inspect graph evidence below.</p>"}<h3>Graph evidence</h3>${
        (r.answer.agent?.runs || [])
          .filter((q) => q.purpose === "agent")
          .map(
            (q) =>
              `<details id="${esc(r.id)}-${esc(q.id)}"><summary>${esc(q.id)} · ${q.rowCount} rows · ${q.ok ? "succeeded" : "failed"}</summary><pre>${esc(q.query)}</pre><pre>${esc(JSON.stringify(q.rows, null, 2))}</pre></details>`,
          )
          .join("") || "<p>No graph query.</p>"
      }<p><label><input type="checkbox"> Claim supported</label> <label><input type="checkbox"> Scope preserved</label> <label><input type="checkbox"> Useful answer</label></p><textarea aria-label="Review notes for ${esc(r.id)}" placeholder="Your notes — print this page to save"></textarea></section>`,
  )
  .join("");
const extraction = [...facts]
  .sort((a, b) => Number(selected.has(b.key)) - Number(selected.has(a.key)))
  .map(
    (f) =>
      `<details><summary>${selected.has(f.key) ? "Selected for isolated test graph" : "Candidate — excluded from test graph"} · ${esc(f.label || f.individualId)} · ${esc(f.kind)} · ${esc(f.value || f.targetId || f.classUri)}</summary><p>${esc(f.propUri)} · ${esc(f.key)}</p><p>${esc(decisionReason.get(f.key) || "Awaiting human review; not accepted automatically.")}</p>${f.evidence.map((e) => `<p>${extractionSource(e)} · quote status ${esc(e.status)} · model entailment score ${e.confidence ?? "not scored"}</p><pre>${esc(e.quote)}</pre>`).join("") || "<p>No located evidence.</p>"}</details>`,
  )
  .join("");
const extractionReplay = await read<{ passed: boolean; titlePassed: boolean; recommendationPassed: boolean }>(
  "extraction-grounding-replay.json",
).catch(() => null);
const extractionReplayCard = extractionReplay
  ? `<section id="extraction-grounding-replay"><h2>Preserved extraction regressions</h2><p>Original unlocated title: <strong>${extractionReplay.titlePassed ? "passed" : "FAILED"}</strong>. Original omitted recommendation: <strong>${extractionReplay.recommendationPassed ? "passed" : "FAILED"}</strong>. The title check is deterministic; recommendation recovery uses the real model against the original retained chunk. <a href="extraction-grounding-replay.json">Original chunk results, exact sources, retained title and candidate corrections</a>.</p></section>`
  : "";
const testingReplay = await read<{
  passed: boolean;
  original: { answer: ConversationMessage };
  text: string;
  semanticCheck: NonNullable<NonNullable<ConversationMessage["agent"]>["semanticCheck"]>;
}>("testing-coverage-replay.json").catch(() => null);
const testingReplayCard = testingReplay
  ? `<section id="testing-coverage-replay"><h2>Preserved testing-coverage wording regression</h2><p>Real-model replay against the original saved evidence: <strong>${testingReplay.passed ? "passed" : "FAILED"}</strong>. Capability to test a number of functions does not establish observed completed testing. <a href="testing-coverage-replay.json">Original answer, evidence, corrections and usage</a>.</p>${answerCheckCard({ agent: { semanticCheck: testingReplay.semanticCheck } } as ConversationMessage)}<details><summary>Original answer</summary><pre>${esc(testingReplay.original.answer.content)}</pre></details><details><summary>Repaired answer</summary><pre>${esc(testingReplay.text)}</pre></details></section>`
  : "";
const locationReplay = await read<{ results: { id: string; repeat: number; passed: boolean; text?: string; error?: string }[] }>(
  "semantic-location-replay.json",
).catch(() => null);
const locationReplayCard = locationReplay
  ? `<section id="semantic-location-replay"><h2>Original invalid correction regressions</h2><p>The exact rejected model edits from the previous main run were supplied to the production recovery path with their original draft and evidence. Gemini repaired the locations; replacements and reasons were retained unchanged. ${locationReplay.results.filter((r) => r.passed).length}/${locationReplay.results.length} real-model replays passed. <a href="semantic-location-replay.json">Original failures, evidence, recovered locations and usage</a>.</p>${locationReplay.results.map((r) => `<details><summary>${esc(r.id)} · repeat ${r.repeat} · ${r.passed ? "passed" : "FAILED"}</summary><pre>${esc(r.error || r.text)}</pre></details>`).join("")}</section>`
  : "";
const sectionTitleReplay = await read<{ passed: boolean; mode: string; notes: string[] }>("section-title-replay.json").catch(() => null);
const sectionTitleReplayCard = sectionTitleReplay
  ? `<section id="section-title-replay"><h2>Section heading versus publication title</h2><p>Original failing checkpoint replay: <strong>${sectionTitleReplay.passed ? "passed" : "FAILED"}</strong>. ${esc(sectionTitleReplay.mode)}. <a href="section-title-replay.json">Original candidate, prior identity, parsed sections and filtered result</a>.</p><details><summary>Omitted candidate, retained title and source location</summary><pre>${esc(sectionTitleReplay.notes.join("\n"))}</pre></details></section>`
  : "";
await writeFile(
  join(out, "review.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>OntoLab — real research E2E review</title><style>body{font:16px/1.55 system-ui;color:#203027;background:#f4f4ef;max-width:1040px;margin:auto;padding:30px}h1,h2{color:#285d46}section{background:white;border:1px solid #d6ddd4;border-radius:12px;padding:26px;margin:24px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3ed;padding:16px;font:15px/1.6 system-ui}aside{border-left:4px solid #c39439;padding:8px 18px;background:#fff9ec}summary{cursor:pointer;padding:10px;overflow-wrap:anywhere}details{border-bottom:1px solid #e1e5df}textarea{width:96%;min-height:75px}a{color:#205e50}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{overflow-wrap:anywhere;text-align:left;padding:10px;border-bottom:1px solid #ddd}small{overflow-wrap:anywhere}nav a{display:inline-block;margin:5px 15px 5px 0}@media(max-width:600px){body{padding:12px}section{padding:15px}}@media print{section{break-before:page}}</style><h1>Real research documents → extraction → graph → answers</h1><p>${esc(answers.model)} · ${new Date().toISOString()} · Human acceptance pending</p><nav>${sectionTitleReplay ? `<a href="#section-title-replay">Section-title regression</a>` : ""}${locationReplay ? `<a href="#semantic-location-replay">Correction recovery</a>` : ""}${testingReplay ? `<a href="#testing-coverage-replay">Testing coverage replay</a>` : ""}${science ? `<a href="#scientific-review">Scientific review</a>` : ""}<a href="#review-priorities">Review priorities</a>${semanticReplay ? `<a href="#semantic-replay">Wording replay</a>` : ""}${answerReplay ? `<a href="#answer-repair">Answer repair replay</a>` : ""}${quoteReplay ? `<a href="#quote-repair">Cross-page repair</a>` : ""}${answers.results.map((r) => `<a href="#${r.id}">${esc(r.id)}</a>`).join("")}<a href="#browser-followup">Browser follow-up</a><a href="#extraction">Extraction review</a></nav><section><h2>What ran</h2><p>${esc(notes.execution || "Two original research PDFs (eight pages) were uploaded over OntoLab\u2019s HTTP API and parsed with the built-in PDF parser. Mock mode was disabled. Gemini performed extraction, entity resolution, source-grounded entailment scoring and answers. The small research ontology was authored for this test. Retrieval uses keyword ranking and deterministic hash embeddings; this is not a dense-retrieval evaluation.")}</p><p>${esc(notes.extractionLabel || "Extraction")}: ${run.completedSteps}/${run.steps.length} steps completed, ${facts.length} candidate facts. ${selected.size} facts were explicitly selected by the agent after checking source evidence, under the isolated identity <code>research-e2e-agent</code>. These are test decisions, <strong>not human acceptance</strong>. Other candidates remain excluded from the saved graph. No production corpus was modified.</p><p>Answer cases: ${answers.results.length}; mechanical flags: ${answers.results.reduce((n, r) => n + r.flags.length, 0)}. Browser acceptance: ${browser.passed ? "passed" : "FAILED"}. Core workflow ${browser.coreWorkflowPassed ? "passed" : "failed"} — ${esc(browser.checks.join(", "))}. Citation rendering exposed ${browser.citationRendering.actualSourceLinks} clickable source links out of ${browser.citationRendering.expectedSourceLinks} source-reference occurrences in the method answer.</p><aside><strong>Overall findings</strong><p>${esc(notes.overall || "Review the captured claims against the original PDFs. Located quotations and model scores do not establish correctness.")}</p></aside><p><a href="browser-citation.png">Working citation flow</a> · <a href="browser-grouped-citations.png">Grouped citation check</a> · <a href="browser-checks.json">Browser checks</a> · <a href="answers.json">Raw answers and tool events</a> · <a href="run.json">Extraction run</a> · <a href="facts.json">All extracted facts</a> · <a href="extraction-diagnostics.json">Extraction diagnostics</a> · <a href="decisions.json">Agent test decisions</a> · <a href="browser-followup.json">Real browser follow-up</a></p>${priorAnswerAttempt ? `<p><a href="answers-before-scope-refinement.json">Preserved answer attempt before the final scope refinement</a>. This is an iterative diagnostic on the same documents, not a held-out evaluation.</p>` : ""}${priorGuardAttempt ? `<p><a href="answers-before-expansion-fallback.json">Preserved initial guard run</a>: one version answer was withheld before the acronym-only fallback was added. <a href="answer-fidelity-audit.json">Independent final answer audit</a> · <a href="validation-summary.json">Full validation summary</a>.</p>` : ""}<p>Source lineage:</p>${state.documents.map((d) => `<p>${source(d.id)}<br><small>SHA-256: ${esc(d.sha256)}</small></p>`).join("")}<p>Saved graph revision: <code>${esc(state.revisionId)}</code>. The full isolated application state is retained locally under <code>data/</code> for reproduction.</p></section>${comparison.length ? `<section><h2>Comparison with the previous run</h2><p><a href="${esc(comparisonBaseline.href)}">${esc(comparisonBaseline.label)}</a>. ${esc(notes.comparisonContext || "Identical PDF hashes; fresh stochastic extraction, so fact counts are not a recall comparison.")}</p><table><thead><tr><th>Measure</th><th>Before</th><th>Now</th></tr></thead><tbody>${comparison.map((r) => `<tr><td>${esc(r.metric)}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td></tr>`).join("")}</tbody></table></section>` : ""}${
    priorities.length
      ? `<section id="review-priorities"><h2>Start here: human review priorities</h2>${priorities
          .map(
            (r) =>
              `<h3>${esc(r.title)}</h3><p>${esc(r.detail)}</p>${(r.factKeys || [])
                .map((key) => {
                  const f = facts.find((f) => f.key === key);
                  return f
                    ? `<details><summary>${esc(f.label || f.individualId)} · ${esc(f.value || f.targetId || f.classUri)}</summary>${f.evidence.map((e) => `<p>${extractionSource(e)} · ${esc(e.status)}</p><pre>${esc(e.quote)}</pre>`).join("")}</details>`
                    : "";
                })
                .join("")}`,
          )
          .join("")}</section>`
      : ""
  }${sectionTitleReplayCard}${locationReplayCard}${extractionReplayCard}${testingReplayCard}${semanticReplayCard}${answerReplayCard}${replayCard}${scienceCard}${cards}${followupCard}<section id="extraction"><h2>Extraction review</h2><p>Selected facts first. Each assertion includes its original extraction evidence and model score. Review metadata remains distinct from human acceptance.</p>${extraction}</section><script>function revealEvidence(){const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(target&&target.tagName==="DETAILS")target.open=true;}window.addEventListener("hashchange",revealEvidence);revealEvidence();</script></html>`,
);
console.log(`Report: ${out}/review.html`);
