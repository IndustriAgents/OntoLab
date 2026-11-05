// Real PDFs -> built-in PDF parser -> real provider extraction/NLI -> isolated reviewed graph -> HTTP Ask + browser.
// EVIDENCE_ENV_FILE=/path/.env RESEARCH_PDF_DIR=/path/files npx tsx scripts/research-evidence-e2e.ts extract|answer
// Override RESEARCH_PROVIDER / RESEARCH_MODEL together; CLI providers also require LOCAL_CLI_ENABLED=1.
import { config } from "dotenv";
import http from "node:http";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Project, RevisionWithContent, RunView, Conversation, DocumentText } from "../src/types/project.ts";
import type { CorpusPlan } from "../src/types/corpus.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import type { ProviderId } from "../server/providers.ts";
import { listFacts } from "../src/lib/ontology/factReview.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
process.env.PARSER_URL = "";
process.env.EMBEDDINGS_BACKEND = "hash";
process.env.NLI_BACKEND = "provider";
process.env.REUSE_SOURCES = "";
if (!!process.env.RESEARCH_PROVIDER !== !!process.env.RESEARCH_MODEL) throw new Error("Set RESEARCH_PROVIDER and RESEARCH_MODEL together");
const provider = (process.env.RESEARCH_PROVIDER || "gemini") as ProviderId,
  model = process.env.RESEARCH_MODEL || "gemini-3.8-flash";
const { listProviders } = await import("../server/providers.ts");
const configured = listProviders().find((p) => p.id === provider && p.enabled && p.models.includes(model));
if (!configured || provider === "mock") throw new Error(`Real provider/model unavailable: ${provider}/${model}`);
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e");
await mkdir(join(out, "sources"), { recursive: true });
const { createApp } = await import("../server/app.ts");
const { createLocalStore } = await import("../server/store/local.ts");
const { startDocumentWorker } = await import("../server/documentWorker.ts");
const { silentLogger } = await import("../server/services/context.ts");
const { stopSparqlPool } = await import("../server/services/sparqlPool.ts");
const store = createLocalStore(join(out, "data"));
const worker = startDocumentWorker(store, silentLogger, { autoStart: false });
const server = http.createServer(
  createApp({
    store,
    distDir: resolve("dist"),
    log: silentLogger,
    auth: { mode: "local", authenticate: async () => ({ user: { id: "research-e2e-agent" } }) },
  }),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(url + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(b)}`);
  return b as T;
}
const save = async (name: string, value: unknown) => writeFile(join(out, name), JSON.stringify(value, null, 2));
type State = {
  projectId: string;
  corpusId: string;
  runId: string;
  revisionId?: string;
  documents: { id: string; name: string; sha256: string; original: string }[];
};
try {
  if (process.argv[2] === "extract") {
    if (
      await readFile(join(out, "state.json")).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Existing run: use a fresh EVIDENCE_OUTPUT or resume phase");
    const p = (
      await api<{ project: Project }>("POST", "/api/projects", {
        name: "Research evidence E2E — agent test, human review pending",
        settings: { provider, model, models: { embeddings: "hash", nli: "provider" } },
      })
    ).project;
    const turtle = `@prefix ex:<https://ontolab.example/research#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. @prefix xsd:<http://www.w3.org/2001/XMLSchema#>.
ex:Study a owl:Class; rdfs:label "Research study". ex:Tool a owl:Class; rdfs:label "Software tool". ex:TestCase a owl:Class; rdfs:label "Test case". ex:Finding a owl:Class; rdfs:label "Study finding".
ex:title a owl:DatatypeProperty; rdfs:domain ex:Study; rdfs:range xsd:string.
ex:description a owl:DatatypeProperty; rdfs:range xsd:string.
ex:version a owl:DatatypeProperty; rdfs:domain ex:Tool; rdfs:range xsd:string.
ex:reportedResult a owl:DatatypeProperty; rdfs:range xsd:string.
ex:limitation a owl:DatatypeProperty; rdfs:domain ex:Study; rdfs:range xsd:string.
ex:usesTool a owl:ObjectProperty; rdfs:domain ex:Study; rdfs:range ex:Tool.
ex:hasTest a owl:ObjectProperty; rdfs:domain ex:Study; rdfs:range ex:TestCase.
ex:hasFinding a owl:ObjectProperty; rdfs:domain ex:Study; rdfs:range ex:Finding.`;
    const schema = (
      await api<{ revision: RevisionWithContent }>("POST", `/api/projects/${p.id}/revisions`, {
        source: "import",
        content: { modules: [{ id: "research", name: "research.ttl", turtle }], abox: null, baseIri: "https://ontolab.example/research#" },
      })
    ).revision;
    await api("POST", `/api/projects/${p.id}/revisions/${schema.id}/commit`, { acknowledgedWarnings: true });
    const corpus = (
      await api<{ corpus: Project }>("POST", `/api/projects/${p.id}/corpora`, {
        name: "Two IEC 61499 papers — real extraction",
        ontologyRevisionId: schema.id,
        provider,
        model,
      })
    ).corpus;
    await api("PUT", `/api/projects/${corpus.id}/corpus/settings`, { chunking: { method: "section", maxChars: 12000, overlap: 0.12 } });
    const documents: State["documents"] = [];
    for (const [file, name] of [
      ["paper4.pdf", "plant-model-prom.pdf"],
      ["paper7.pdf", "iec61499-portability.pdf"],
    ]) {
      const original = join(process.env.RESEARCH_PDF_DIR || "", file);
      const bytes = await readFile(original);
      await copyFile(original, join(out, "sources", name));
      const r = await fetch(url + `/api/projects/${corpus.id}/corpus/documents`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": name },
        body: bytes,
      });
      const b = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(b));
      documents.push({ id: b.document.id, name, original, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await worker!.tick();
    for (const d of documents) {
      const text = await api<DocumentText>("GET", `/api/projects/${corpus.id}/documents/${d.id}/text`);
      await save(`sources/${d.name}.parsed.json`, text);
      console.log(`Parsed ${d.name}: ${text.pages.length} pages, ${text.text.length} chars`);
    }
    const plan = await api<CorpusPlan>("POST", `/api/projects/${corpus.id}/corpus/plan`, {});
    await save("plan.json", plan);
    console.log(`Extraction plan: ${plan.calls} estimated calls; ${plan.inputTokens} input tokens; errors ${JSON.stringify(plan.errors)}`);
    if (plan.errors.length) throw new Error("Plan errors");
    const run = (await api<{ run: RunView }>("POST", `/api/projects/${corpus.id}/corpus/updates`, { hash: plan.hash })).run;
    await save("state.json", { projectId: p.id, corpusId: corpus.id, runId: run.id, documents });
  }
  const state = JSON.parse(await readFile(join(out, "state.json"), "utf8")) as State;
  const root = `/api/projects/${state.corpusId}`;
  if (["extract", "resume"].includes(process.argv[2])) {
    let run = (await api<{ run: RunView }>("GET", `${root}/runs/${state.runId}`)).run;
    for (let i = 0; i < 150 && !["ready_for_review", "failed", "cancelled"].includes(run.status); i++) {
      console.log(`Extraction ${run.completedSteps}/${run.steps.length}: ${run.nextStep?.label || run.status}`);
      run = (await api<{ run: RunView }>("POST", `${root}/runs/${state.runId}/advance`)).run;
      await save("run.json", run);
    }
    if (run.status !== "ready_for_review" || !run.resultRevisionId) throw new Error(`Extraction ${run.status}: ${run.error}`);
    state.revisionId = run.resultRevisionId;
    await save("state.json", state);
    const revision = (await api<{ revision: RevisionWithContent }>("GET", `${root}/revisions/${state.revisionId}`)).revision;
    await save("extraction.json", revision);
    await save("facts.json", listFacts(revision.content.abox!));
    console.log(
      `Extraction complete: ${revision.content.abox?.individuals.length} individuals; ${listFacts(revision.content.abox!).length} facts. Review facts.json before answer phase.`,
    );
  } else if (process.argv[2] === "answer") {
    const decisions = JSON.parse(await readFile(join(out, "decisions.json"), "utf8"));
    let rev = (await api<{ revision: RevisionWithContent }>("GET", `${root}/revisions/${state.revisionId}`)).revision;
    if (rev.status !== "committed") {
      if (decisions.length) await api("POST", `${root}/revisions/${state.revisionId}/facts/review`, { decisions });
      await api("POST", `${root}/revisions/${state.revisionId}/commit`, { acknowledged: true, acknowledgedWarnings: true });
    }
    rev = (await api<{ revision: RevisionWithContent }>("GET", `${root}/revisions/${state.revisionId}`)).revision;
    await save("saved-revision.json", rev);
    const cases = [
      {
        id: "graph-tools",
        q: "Which software tools are linked to the plant-model-generation study in the saved graph? Cite the graph evidence.",
        expected: "Accepted usesTool links only; distinguish graph incompleteness from document absence.",
      },
      {
        id: "plant-method",
        q: "In the plant model generation paper, how are event logs converted into an IEC 61499 plant model, and which tools are used? Cite the source.",
        expected:
          "ProM alpha algorithm -> Petri net -> PIPE reachability/FSM -> ECC; OPC UA/UaExpert log collection, fb2smv and NuSMV verification. Preserve sequence.",
      },
      {
        id: "numerical-mux",
        q: "In the portability paper's MUX example, what input index and time values are given, and what output is expected? Cite the passage containing the output.",
        expected: "int1=2; time1=1m30s, time2=15s, time3=2m30s; output=2m30s. Text spans pp3–4; do not mistake 15s for output.",
      },
      {
        id: "version-scope",
        q: "Which versions of 4DIAC and EAE were compared in the portability paper, and what CDATA import issue was reported? Can this establish how the current versions behave?",
        expected:
          "4DIAC V2.0.1, EAE V21.2; EAE does not accept CDATA algorithm contents. Historical finding cannot establish current behavior.",
      },
      {
        id: "two-paper-comparison",
        q: "Compare how the two papers assess IEC 61499 systems. Does passing the portability tests establish the HOME/END safety property of the cylinder model? Cite both papers.",
        expected:
          "Portability tests vs model checking; no equivalence between passing portability tests and proving the cylinder property.",
      },
      {
        id: "missing-performance",
        q: "What measured percentage speedup on large industrial systems does the plant model generation paper report? Cite the measured result or state the limitation.",
        expected: "No quantified large-system speedup; conclusion says scalability/fastness on real examples needs analysis.",
      },
      {
        id: "testing-coverage",
        q: "How many standard functions does the portability paper say the StandardFunctionTest block can test, and what does the paper establish about how many were actually tested? Cite the evidence.",
        expected:
          "Capable of testing over 75 standard functions; capability does not establish that all those functions were actually tested. Do not invent observed coverage.",
      },
      {
        id: "scientific-qualifiers",
        q: "Does the plant model paper require removing Start and End states? Is its non-determinism a reported failure of the method? Explain the authors' wording and distinguish modeling choices from stated limitations, with sources.",
        expected:
          "Removal is recommended ('it is better'), not required. Spontaneous transitions deliberately represent timing and wider behavior. Trace coverage and scalability remain future evaluation; do not call non-determinism a demonstrated failure.",
      },
      {
        id: "graph-limitations",
        q: "What limitations of the plant model generation study are recorded in the saved graph? Check them against the source and distinguish them from its modeling choices.",
        expected:
          "The saved graph should contain the conclusion's untested real-example scalability/speed and incomplete trace coverage. Non-determinism belongs to the method description, not a reported defect. Cite both graph and source.",
      },
    ];
    const onlyCase = process.env.RESEARCH_CASE;
    if (onlyCase && !cases.some((c) => c.id === onlyCase)) throw new Error(`Unknown case: ${onlyCase}`);
    const results = onlyCase
      ? JSON.parse(await readFile(join(out, "answers.json"), "utf8")).results.filter((r: { id: string }) => r.id !== onlyCase)
      : [];
    for (const t of cases.filter((c) => !onlyCase || c.id === onlyCase)) {
      console.log(`Answering ${t.id}`);
      const response = await fetch(url + root + "/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: t.q, revisionId: state.revisionId, provider, model }),
        signal: AbortSignal.timeout(240000),
      });
      const raw = await response.text();
      const events = raw
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
      const saved = events.find((e) => e.type === "saved");
      if (!response.ok || saved?.type !== "saved") throw new Error(`Answer failed: ${response.status}`);
      const conversation = (await api<{ conversation: Conversation }>("GET", `${root}/conversations/${saved.conversationId}`)).conversation;
      const answer = conversation.messages.find((m) => m.id === saved.messageId)!;
      const flags: string[] = [];
      const checks = [];
      if (answer.agent?.completion !== "complete") flags.push(`Completion: ${answer.agent?.completion}`);
      const refs = [...new Set([...answer.content.matchAll(/\bC\d+\b/g)].map((m) => m[0]))];
      if (t.id !== "graph-tools" && !refs.length) flags.push("No source citation");
      for (const ref of refs) {
        const p = answer.agent?.passages?.find((p) => p.ref === ref);
        if (!p) {
          flags.push(`Unknown ${ref}`);
          continue;
        }
        const context = await api<DocumentText>("GET", `${root}/revisions/${state.revisionId}/evidence/passages/${p.key}`);
        const exact = context.text.slice(p.evidence.start, p.evidence.end) === p.evidence.quote;
        checks.push({ ref, exact, page: p.evidence.page });
        if (!exact) flags.push(`Quote mismatch ${ref}`);
      }
      const qrefs = [...new Set([...answer.content.matchAll(/\bQ\d+\b/g)].map((m) => m[0]))];
      for (const ref of qrefs) if (!answer.agent?.runs.some((r) => r.id === ref && r.ok)) flags.push(`Graph citation ${ref} unavailable`);
      if (t.id === "graph-tools" && !qrefs.length) flags.push("No graph citation");
      if (/\$[^$\n]+\$/.test(answer.content)) flags.push("Raw math markup");
      results.push({ ...t, answer, conversationId: saved.conversationId, checks, flags, events });
      results.sort((a: { id: string }, b: { id: string }) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
      await save("answers.json", { provider, model, results });
      console.log(`${t.id}: ${flags.join("; ") || "mechanical checks passed"}`);
    }
  } else if (process.argv[2] === "browser") {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((selection) => localStorage.setItem("ontolab-model", JSON.stringify(selection)), { provider, model });
      const answers = JSON.parse(await readFile(join(out, "answers.json"), "utf8"));
      const methodAnswer = answers.results.find((r: { id: string }) => r.id === "plant-method");
      await page.goto(`${url}/p/${state.corpusId}/assistant?c=${methodAnswer.conversationId}`);
      await page.locator(".msg-assistant .md").waitFor();
      const expectedSourceLinks = [...String(methodAnswer.answer.content).matchAll(/\[((?:[CQ]\d+)(?:\s*[,;]\s*[CQ]\d+)*)\]/g)].flatMap(
        (m) => m[1].match(/C\d+/g) ?? [],
      ).length;
      const actualSourceLinks = await page.locator(".msg-assistant .md .cite-src").count();
      const citationRendering = { expectedSourceLinks, actualSourceLinks, passed: expectedSourceLinks === actualSourceLinks };
      await page.screenshot({ path: join(out, "browser-grouped-citations.png"), fullPage: true });
      for (const ref of new Set([...String(methodAnswer.answer.content).matchAll(/\bC\d+\b/g)].map((m) => m[0]))) {
        const button = page.locator(`.msg-assistant .md [data-citation-ref="${ref}"]`).first();
        await button.click();
        await page.getByRole("region", { name: "Selected source passage" }).waitFor();
        const passage = methodAnswer.answer.agent.passages.find((p: { ref: string }) => p.ref === ref);
        if ((await page.locator(".source-excerpt").innerText()).trim() !== passage.evidence.quote.trim())
          throw new Error(`Citation ${ref} opened the wrong passage`);
        await page.getByRole("button", { name: "Back to answer", exact: true }).click();
      }
      const item = answers.results.find((r: { id: string }) => r.id === "numerical-mux");
      await page.goto(`${url}/p/${state.corpusId}/assistant?c=${item.conversationId}`);
      await page.locator(".msg-assistant .md .cite-src").first().click();
      await page.getByRole("region", { name: "Selected source passage" }).waitFor();
      const quote = await page.locator(".source-excerpt").innerText();
      await page.reload();
      await page.getByRole("region", { name: "Selected source passage" }).waitFor();
      if ((await page.locator(".source-excerpt").innerText()) !== quote) throw new Error("Citation changed on refresh");
      await page.getByRole("button", { name: "More context", exact: true }).click();
      await page.locator(".source-inspector .doc-viewer").waitFor();
      await page.screenshot({ path: join(out, "browser-citation.png"), fullPage: true });
      await page.getByRole("button", { name: "Back to sources", exact: true }).click();
      await page.getByRole("textbox", { name: "Search saved sources", exact: true }).fill("MUX");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.locator(".source-hit").first().click();
      await page.getByRole("button", { name: "Ask using this passage", exact: true }).click();
      await page.getByRole("button", { name: "Send question", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".msg-assistant .md").length >= 2, undefined, { timeout: 240000 });
      await page.getByRole("button", { name: "Send question", exact: true }).waitFor({ timeout: 240000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".msg-assistant .md .cite-src").first().click();
      await page.getByRole("region", { name: "Selected source passage" }).waitFor();
      const bounds = await page.locator(".gc-panel").boundingBox();
      if (!bounds || bounds.width > 390 || bounds.x < 0) throw new Error("Mobile overflow");
      await page.getByRole("button", { name: "Back to answer", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".msg-assistant .md .cite-src") === document.activeElement);
      const conv = (await api<{ conversation: Conversation }>("GET", `${root}/conversations/${item.conversationId}`)).conversation;
      if (conv.messages.length < 4 || conv.messages.at(-1)?.agent?.completion !== "complete")
        throw new Error("Real follow-up did not complete");
      await save("browser-followup.json", conv);
      await save("browser-checks.json", {
        passed: !errors.length && citationRendering.passed,
        coreWorkflowPassed: !errors.length,
        citationRendering,
        errors,
        checks: [
          "real saved answer",
          "citation",
          "every method-answer citation opens its matching saved passage",
          "refresh/deep link",
          "saved context",
          "source search",
          "real-model passage follow-up",
          "mobile bounds",
          "focus restoration",
        ],
      });
      if (errors.length) throw new Error(errors.join("; "));
      console.log(`Core browser workflow passed; grouped citation rendering ${citationRendering.passed ? "passed" : "FAILED"}`);
      if (!citationRendering.passed) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  }
} finally {
  await worker?.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await stopSparqlPool();
}
