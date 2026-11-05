/** Real built SPA + HTTP API + isolated local storage. Only generation is the offline mock provider. */
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright";
import type { EvidenceRef } from "../src/types/abox.ts";
import type { Conversation, DocumentText, Project, ProjectDocument, RevisionWithContent, RunView } from "../src/types/project.ts";
import type { CorpusPlan } from "../src/types/corpus.ts";
import { listFacts } from "../src/lib/ontology/factReview.ts";

process.env.MOCK_LLM = "1";
process.env.EMBEDDINGS_BACKEND = "hash";
process.env.NLI_BACKEND = "lexical";
process.env.PARSER_URL = "";
const { startApp, driveRun } = await import("../tests/helpers.ts");
const { createLocalStore } = await import("../server/store/local.ts");
const output = resolve("output/evidence-e2e");
await mkdir(output, { recursive: true });
await Promise.all(["failure.json", "failure.png"].map((name) => rm(`${output}/${name}`, { force: true })));
const browser = await chromium.launch({ headless: process.env.EVIDENCE_E2E_HEADED !== "1" });
const app = await startApp({ distDir: resolve("dist") });
const c = app.as("alice");
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  extraHTTPHeaders: { "x-test-user": "alice" },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const steps: string[] = [];
const step = (name: string) => {
  steps.push(name);
  console.info(`PASS ${name}`);
};
const checkText = async (locator: Locator, value: string) => {
  await locator.filter({ hasText: value }).first().waitFor({ state: "visible" });
};
const TBOX = `@prefix ex: <http://example.org/equipment#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . ex:Pump a owl:Class; rdfs:label "Pump" . ex:pressure a owl:DatatypeProperty; rdfs:domain ex:Pump; rdfs:range xsd:decimal; rdfs:label "rated pressure" .`;
const TEXT =
  "# Operating limits\n\n🧪 Pump P-101 is a pump. Pump P-101 has a rated pressure of 16 bar at 20 °C.\n\n| Pump | Pressure | Temperature |\n| --- | --- | --- |\n| P-101 | 16 bar | 20 °C |\n| P-102 | 25 bar | 20 °C |\n\nCompatibility with corrosive media has not been assessed.";
const quote = "Pump P-101 has a rated pressure of 16 bar at 20 °C.";
try {
  const pid = (
    await c.json<{ project: { id: string } }>("POST", "/api/projects", {
      name: "Evidence E2E",
      settings: { provider: "mock", model: "mock-1", models: { embeddings: "hash", nli: "lexical" } },
    })
  ).body.project.id;
  const base = (
    await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
      source: "import",
      content: { modules: [{ name: "equipment.ttl", turtle: TBOX }], abox: null, baseIri: "http://example.org/data#" },
    })
  ).body.revision;
  assert.equal((await c.json("POST", `/api/projects/${pid}/revisions/${base.id}/commit`, { acknowledgedWarnings: true })).status, 200);
  const doc = (await c.upload(`/api/projects/${pid}/documents`, "pump-manual.md", TEXT)).body.document as ProjectDocument;
  const other = (await c.upload(`/api/projects/${pid}/documents`, "installation.md", `${TEXT}\n\nInstallation record.`)).body
    .document as ProjectDocument;
  const parsed = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${doc.id}/text`)).body;
  const otherText = (await c.json<DocumentText>("GET", `/api/projects/${pid}/documents/${other.id}/text`)).body;
  const run = (
    await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      documentIds: [doc.id, other.id],
      provider: "mock",
      model: "mock-1",
      options: { relevanceScreen: false, schemaRetrieval: "off", resolveEntities: false, verifyEvidence: true },
    })
  ).body.run;
  assert.equal((await driveRun(c, pid, run.id)).status, "ready_for_review");
  const ref = (did: string, source: DocumentText): EvidenceRef => ({
    runId: run.id,
    documentId: did,
    chunkId: source.chunks[0].id,
    quote,
    start: source.text.indexOf(quote),
    end: source.text.indexOf(quote) + quote.length,
    status: "verified",
    claim: "Pump P-101 has a rated pressure of 16 bar.",
    confidence: 0.25,
    review: true,
    check: { premise: quote, hypothesis: "Pump P-101 has a rated pressure of 16 bar.", backend: "e2e-fixture", threshold: 0.8 },
  });
  // Controlled assertion fixtures exercise independent trust states; these are not quality benchmark results.
  const graph = (
    await c.json<{ revision: RevisionWithContent }>("POST", `/api/projects/${pid}/revisions`, {
      source: "manual",
      content: {
        modules: [{ name: "equipment.ttl", turtle: TBOX }],
        baseIri: "http://example.org/data#",
        abox: {
          individuals: [
            {
              id: "p101",
              label: "Pump P-101",
              classUri: "http://example.org/equipment#Pump",
              review: { status: "accepted", by: "user" },
              evidence: [ref(doc.id, parsed)],
              dataProperties: [
                {
                  propUri: "http://example.org/equipment#pressure",
                  value: "16",
                  datatype: "http://www.w3.org/2001/XMLSchema#decimal",
                  review: { status: "candidate", by: "auto" },
                  evidence: [ref(doc.id, parsed), ref(other.id, otherText)],
                },
              ],
            },
          ],
        },
      },
    })
  ).body.revision;
  const committed = await c.json("POST", `/api/projects/${pid}/revisions/${graph.id}/commit`, { acknowledgedWarnings: true });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const factKey = "p101#data:http://example.org/equipment#pressure|16|http://www.w3.org/2001/XMLSchema#decimal|";
  const explore = `${app.url}/p/${pid}/explore?view=table&sel=p101`;
  const panel = page.getByRole("complementary", { name: "Evidence inspector panel", exact: true });
  await page.goto(explore);
  const entity = page.getByRole("complementary", { name: "Pump P-101", exact: true });
  await entity.getByRole("button", { name: "Inspect evidence", exact: true }).nth(1).click();
  await checkText(panel.getByRole("list", { name: "Independent evidence checks" }), "Exact quote match");
  await checkText(panel, "Needs review");
  await panel.locator("mark").filter({ hasText: quote }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Accept in draft", exact: true }).isVisible(), true);
  await panel.getByLabel(/Supporting source/).selectOption("1");
  await checkText(panel, other.name);
  await panel.getByRole("tab", { name: "Model input", exact: true }).click();
  await checkText(panel, "Recorded");
  await panel.getByRole("tab", { name: "History", exact: true }).click();
  await checkText(panel, "Retained run inputs");
  await page.reload();
  await panel.getByRole("tab", { name: "History", exact: true }).waitFor();
  assert.equal(await panel.getByRole("tab", { name: "History", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await panel.getByLabel(/Supporting source/).inputValue(), "1");
  step("Explore opens the stored fact with independent checks; source/tab survive reload");

  await panel.getByRole("button", { name: "Reject in draft", exact: true }).click();
  await checkText(panel, "Rejected by reviewer");
  await checkText(panel, "Decision saved to draft");
  const draftId = JSON.parse(new URL(page.url()).searchParams.get("inspect")!).revisionId as string;
  assert.notEqual(draftId, graph.id);
  const savedGraph = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${graph.id}`)).body.revision;
  assert.equal(listFacts(savedGraph.content.abox!).find((f) => f.key === factKey)?.status, "candidate");
  const draft = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${draftId}`)).body.revision;
  assert.equal(listFacts(draft.content.abox!).find((f) => f.key === factKey)?.status, "rejected");
  await panel.getByRole("button", { name: "Undo decision", exact: true }).click();
  await checkText(panel, "Awaiting review");
  await panel.getByRole("button", { name: "Accept in draft", exact: true }).click();
  await checkText(panel, "Accepted by reviewer");
  await checkText(panel, "Decision saved to draft");
  step("Review creates a draft, preserves the saved graph, supports Undo and persists acceptance");

  await panel.getByRole("tab", { name: "Source", exact: true }).click();
  await panel.getByRole("button", { name: "Copy link", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(new URL(copied).searchParams.get("inspect"), new URL(page.url()).searchParams.get("inspect"));
  await panel.getByRole("link", { name: "Open in Documents", exact: false }).click();
  await page.getByRole("heading", { name: other.name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("run"), run.id);
  await page.getByRole("document", { name: "Document text" }).locator("mark").filter({ hasText: quote }).waitFor();
  step("Copied links and Open in Documents preserve the selected run and source version");

  await page.goto(`${explore}&rev=${draftId}`);
  const details = page.getByRole("complementary", { name: "Pump P-101", exact: true });
  await details.getByRole("textbox", { name: "Label", exact: true }).fill("Pump with a working label");
  await details.getByRole("button", { name: "Inspect evidence", exact: true }).nth(1).click();
  await checkText(panel.getByRole("heading"), "Pump with a working label");
  await panel.getByRole("button", { name: "Reject in draft", exact: true }).click();
  await checkText(panel, "Decision saved to draft");
  const edited = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${pid}/revisions/${draftId}`)).body.revision;
  assert.equal(edited.content.abox!.individuals[0].label, "Pump with a working label");
  await panel.getByRole("button", { name: "Close evidence inspector", exact: true }).click();
  await page.getByRole("complementary", { name: "Pump with a working label", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Inspect evidence");
  step("Inspection flushes existing editor changes, preserves them during review and restores focus");

  await page.goto(`${app.url}/p/${pid}/research?view=documents&doc=${doc.id}`);
  await page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await panel.getByRole("tab", { name: "Source", exact: true }).waitFor();
  await page.goBack();
  await panel.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Chunk 1", exact: true }).waitFor();
  step("Chunk Lab uses the shared inspector and browser Back restores the chunk workspace");

  await page.goto(`${app.url}/p/${pid}/research?view=extraction&run=${run.id}`);
  await page
    .getByRole("navigation", { name: "Pipeline stages" })
    .getByRole("button", { name: /Fact extraction/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Inputs & lineage", exact: true }).click();
  await page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await checkText(panel, "Retained run snapshot");
  await panel.getByRole("tab", { name: "Model input", exact: true }).click();
  await panel.getByRole("heading", { name: "Generation passage", exact: true }).waitFor();
  step("Run Inspector opens its exact stage input in the shared inspector");

  const xml = `<article><front><article-meta><title-group><article-title>Pump specifications</article-title></title-group></article-meta></front><body><sec><title>Limits</title><table-wrap><caption>Water service at 20 °C</caption><table><thead><tr><th>Pump</th><th colspan="2">Rating</th></tr></thead><tbody><tr><td>P-101</td><td>16 bar</td><td>20 °C</td></tr></tbody></table><table-wrap-foot>Use clean water only.</table-wrap-foot></table-wrap></sec></body></article>`;
  const xmlDoc = (await c.upload(`/api/projects/${pid}/documents`, "specifications.xml", xml)).body.document as ProjectDocument;
  await page.goto(`${app.url}/p/${pid}/research?view=documents&doc=${xmlDoc.id}`);
  await page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await panel.getByRole("button", { name: "Parsed table", exact: true }).waitFor();
  await panel.getByRole("button", { name: "Original structure", exact: true }).click();
  const originalElement = panel.getByLabel("Original element", { exact: true });
  await originalElement.waitFor();
  const tableOption = await originalElement
    .locator("option")
    .evaluateAll((options) => options.find((option) => option.textContent?.endsWith("/table[1]"))?.getAttribute("value"));
  assert.ok(tableOption);
  await originalElement.selectOption(tableOption);
  await checkText(panel, "Original XML checksum verified");
  await panel.getByRole("table").getByRole("cell", { name: "16 bar", exact: true }).waitFor();
  assert.equal(await panel.getByRole("columnheader", { name: "Rating", exact: true }).getAttribute("colspan"), "2");
  step("Original XML is checksum checked; its table preserves column spans, headers, units and cited rows");

  const store = createLocalStore(app.dataDir).forUser({ id: "alice" });
  const conversation: Conversation = {
    id: "conv_evidence_e2e",
    projectId: pid,
    revisionId: graph.id,
    title: "Pump pressure",
    createdAt: app.clock.now.toISOString(),
    updatedAt: app.clock.now.toISOString(),
    messages: [
      { id: "msg_question", role: "user", mode: "ask", content: "What is the pump pressure?", createdAt: app.clock.now.toISOString() },
      {
        id: "msg_answer",
        role: "assistant",
        mode: "ask",
        content: "The pump is rated to 16 bar [C1].",
        citations: [{ ref: "C1", evidence: ref(doc.id, parsed) }],
        createdAt: app.clock.now.toISOString(),
        agent: { source: "project", sourceLabel: "Graph fixture", runs: [], tools: [], trace: [], model: "mock-1", durationMs: 1 },
      },
    ],
  };
  await store.conversations.put(conversation);
  await page.goto(`${app.url}/p/${pid}/assistant?c=${conversation.id}`);
  await page.locator(".msg-assistant .cite-src").first().click();
  await checkText(panel, "Answer citation C1");
  assert.equal(await page.locator(".gc-panel:visible").count(), 1);
  await panel.getByRole("button", { name: "Back to answer evidence", exact: true }).click();
  await page.locator(".gc-technical summary").click();
  await page.getByRole("button", { name: "Queries", exact: true }).click();
  await page.locator(".gc-technical summary").filter({ hasText: "Queries" }).waitFor();
  await page.locator(".msg-assistant .cite-src").first().click();
  await panel.getByRole("button", { name: "Expand reader", exact: true }).click();
  const expandedPanel = page.getByRole("dialog", { name: "Evidence inspector panel", exact: true });
  await expandedPanel.waitFor();
  const expandedBounds = await expandedPanel.boundingBox();
  assert.ok(expandedBounds && expandedBounds.width > 900);
  await expandedPanel.getByRole("button", { name: "Restore panel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole("dialog", { name: "Evidence inspector panel", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Evidence inspector panel", { exact: true }).evaluate((el) => el.scrollWidth > el.clientWidth + 2),
    false,
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator(".gc-technical summary").filter({ hasText: "Queries" }).waitFor();
  step("Assistant opens the stored citation in its existing panel and returns to answer evidence");

  const induction = (
    await c.json<{ run: RunView }>("POST", `/api/projects/${pid}/runs`, {
      kind: "induction",
      documentIds: [doc.id],
      provider: "mock",
      model: "mock-1",
      options: { repair: false, inductionAxioms: false },
    })
  ).body.run;
  const inductionDone = await driveRun(c, pid, induction.id);
  assert.equal(inductionDone.status, "ready_for_review");
  await page.goto(`${app.url}/p/${pid}/ontology?tab=review&rev=${inductionDone.resultRevisionId}`);
  const supported = page.locator("details").filter({ has: page.getByText(/^Supported terms \(/) });
  await supported.locator("summary").click();
  await supported.getByRole("button", { name: "Inspect evidence", exact: true }).first().click();
  await checkText(panel, "Retained run snapshot");
  step("Ontology term evidence resolves to the saved induction source");

  const corpus = (
    await c.json<{ corpus: Project }>("POST", `/api/projects/${pid}/corpora`, {
      name: "Evidence corpus",
      ontologyRevisionId: graph.id,
      provider: "mock",
      model: "mock-1",
    })
  ).body.corpus;
  assert.ok(corpus?.id);
  const cp = `/api/projects/${corpus.id}/corpus`;
  const uploaded = await c.upload(`${cp}/documents`, "corpus-manual.txt", TEXT);
  assert.equal(uploaded.status, 201);
  const member = uploaded.body.member as { id: string };
  const corpusDoc = uploaded.body.document as ProjectDocument;
  const plan = (await c.json<CorpusPlan>("POST", `${cp}/plan`, {})).body;
  assert.deepEqual(plan.errors, []);
  const corpusRun = (await c.json<{ run: RunView }>("POST", `${cp}/updates`, { hash: plan.hash })).body.run;
  const corpusDone = await driveRun(c, corpus.id, corpusRun.id);
  assert.equal(corpusDone.status, "ready_for_review");
  const corpusRevisionId = corpusDone.resultRevisionId as string;
  await page.goto(`${app.url}/p/${corpus.id}/graph?tab=updates&rev=${corpusRevisionId}&run=${corpusRun.id}`);
  await page
    .getByRole("complementary", { name: "Selected fact and evidence", exact: true })
    .getByRole("button", { name: "Inspect evidence", exact: true })
    .first()
    .click();
  await checkText(panel, "Retained run snapshot");
  const selectedFact = JSON.parse(new URL(page.url()).searchParams.get("inspect")!).factKey as string;
  const corpusBefore = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${corpus.id}/revisions/${corpusRevisionId}`))
    .body.revision;
  await panel.getByRole("button", { name: "Reject in draft", exact: true }).click();
  await checkText(panel, "Decision saved to draft");
  const corpusAfter = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${corpus.id}/revisions/${corpusRevisionId}`))
    .body.revision;
  assert.equal(listFacts(corpusAfter.content.abox!).find((f) => f.key === selectedFact)?.status, "rejected");
  await panel.getByRole("button", { name: "Undo decision", exact: true }).click();
  const previousState = listFacts(corpusBefore.content.abox!).find((f) => f.key === selectedFact)?.status;
  assert.ok(previousState);
  await panel.getByRole("button", { name: "Close evidence inspector", exact: true }).click();
  await page.goto(`${app.url}/p/${corpus.id}/graph?tab=documents`);
  await page.getByRole("button", { name: "corpus-manual.txt", exact: true }).click();
  const sourceModal = page.getByRole("dialog", { name: corpusDoc.name, exact: true });
  await sourceModal.getByRole("button", { name: "Original file", exact: true }).click();
  await sourceModal.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await checkText(panel, corpusDoc.name);
  assert.equal(await page.locator(".modal-scrim:visible").count(), 0);
  await panel.getByRole("button", { name: "Close evidence inspector", exact: true }).click();
  await sourceModal.waitFor();
  assert.equal(await sourceModal.getByRole("button", { name: "Original file", exact: true }).getAttribute("aria-pressed"), "true");
  await sourceModal.getByRole("button", { name: "Close", exact: true }).click();
  step("Corpus review persists decisions; document dialogs suspend and restore their selected view");

  const corpusReady = (await c.json<{ revision: RevisionWithContent }>("GET", `/api/projects/${corpus.id}/revisions/${corpusRevisionId}`))
    .body.revision;
  assert.equal(listFacts(corpusReady.content.abox!).find((f) => f.key === selectedFact)?.status, previousState);
  assert.equal(
    (
      await c.json("POST", `/api/projects/${corpus.id}/revisions/${corpusRevisionId}/facts/review`, {
        decisions: listFacts(corpusReady.content.abox!).map((f) => ({ key: f.key, status: "accepted" })),
      })
    ).status,
    200,
  );
  assert.equal(
    (await c.json("POST", `/api/projects/${corpus.id}/revisions/${corpusRevisionId}/commit`, { acknowledgedWarnings: true })).status,
    200,
  );
  assert.equal(
    (await c.upload(`${cp}/documents?member=${member.id}`, "corpus-manual.txt", TEXT.replaceAll("16 bar", "99 bar"))).status,
    201,
  );
  const oldTarget = encodeURIComponent(JSON.stringify({ kind: "fact", revisionId: corpusRevisionId, factKey: selectedFact }));
  await page.goto(`${app.url}/p/${corpus.id}/explore?view=table&inspect=${oldTarget}`);
  await checkText(panel, "Retained run snapshot");
  assert.equal(new URL(page.url()).searchParams.get("rev"), corpusRevisionId);
  assert.ok((await panel.locator(".ei-excerpt").innerText()).includes("16 bar"));
  assert.equal((await panel.locator(".ei-excerpt").innerText()).includes("99 bar"), false);
  await panel.getByRole("link", { name: "Open in Documents", exact: false }).click();
  assert.equal(new URL(page.url()).searchParams.get("run"), corpusRun.id);
  await page.getByRole("document", { name: "Document text", exact: true }).waitFor();
  assert.equal((await page.getByRole("document", { name: "Document text", exact: true }).innerText()).includes("99 bar"), false);
  step("A replaced corpus file cannot change inspection or document links for a saved graph");

  // Historical inspection must still work when inventory and original bytes are gone.
  assert.equal((await c.json("DELETE", `/api/projects/${pid}/documents/${other.id}`)).status, 200);
  const target = encodeURIComponent(JSON.stringify({ kind: "fact", revisionId: graph.id, factKey }));
  await page.goto(`${explore}&inspect=${target}&evidenceSource=1`);
  await checkText(panel, other.name);
  assert.equal(new URL(page.url()).searchParams.get("rev"), graph.id);
  await panel.locator("mark").filter({ hasText: quote }).waitFor();
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  for (const width of [1440, 1024, 736, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const dock = page.getByLabel("Evidence inspector panel", { exact: true });
    await dock.waitFor();
    const overflow = await dock.evaluate((el) => el.scrollWidth > el.clientWidth + 2);
    assert.equal(overflow, false, `Inspector overflow at ${width}px`);
  }
  await page.screenshot({ path: `${output}/narrow-source.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: `${output}/inspector.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByLabel("Evidence inspector panel", { exact: true }).waitFor({ state: "detached" });
  step("Historical links survive removal; desktop, narrow windows and Escape work");
  assert.deepEqual(errors, [], "Uncaught browser errors");
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      { result: "passed", steps, browserErrors: errors, provider: "offline mock", storage: "isolated local adapter" },
      null,
      2,
    ),
  );
  console.info(`Evidence E2E passed (${steps.length} journeys). Artifacts: ${output}`);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ steps, browserErrors: errors, url: page.url(), error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await app.close();
}
