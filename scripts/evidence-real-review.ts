// Real-provider acceptance through the HTTP Ask API; only corpus setup uses the mock.
// EVIDENCE_ENV_FILE=/path/to/.env npx tsx scripts/evidence-real-review.ts
import { config } from "dotenv";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Client } from "../tests/helpers.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import type { Conversation, DocumentText } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "1"; // enables deterministic fixture extraction; answers explicitly select Gemini
process.env.EMBEDDINGS_BACKEND = "hash";
process.env.NLI_BACKEND = "lexical";
const provider = "gemini";
const model = process.env.EVIDENCE_MODEL || "gemini-3.8-flash";
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");
const { createApp } = await import("../server/app.ts");
const { createLocalStore } = await import("../server/store/local.ts");
const { startDocumentWorker } = await import("../server/documentWorker.ts");
const { silentLogger } = await import("../server/services/context.ts");
const { stopSparqlPool } = await import("../server/services/sparqlPool.ts");
const { seedEvidenceCorpus } = await import("../tests/sourceEvidenceFixture.ts");
const data = await mkdtemp(join(tmpdir(), "ontolab-real-evidence-"));
const store = createLocalStore(data);
const worker = startDocumentWorker(store, silentLogger, { autoStart: false });
const server = http.createServer(
  createApp({ store, log: silentLogger, auth: { mode: "local", authenticate: async () => ({ user: { id: "real-review" } }) } }),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const c: Client = {
  get: (path) => fetch(url + path),
  async json(method, path, body) {
    const r = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  },
  async upload(path, name, bytes) {
    const r = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      body: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
    });
    return { status: r.status, body: await r.json() };
  },
};
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/real-model-review");
const results: unknown[] = [];
let issueCount = 0;
const cards: string[] = [];
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
try {
  await mkdir(out, { recursive: true });
  const f = await seedEvidenceCorpus(c, () => worker!.tick());
  await writeFile(join(out, "source.txt"), f.text);
  const root = `/api/projects/${f.corpus.id}`;
  const cases = [
    {
      id: "ratio",
      q: "What load ratio was used in the fatigue test? Cite the source and state which material it applies to.",
      expected: "R = 0.1; only the fatigue test for Material A.",
      required: /0\.1/,
    },
    {
      id: "temperature",
      q: "What was the test temperature? Give a numerical temperature only if the source reports one.",
      expected: "Room temperature; no numerical temperature is reported.",
      required: /room temperature/i,
    },
    {
      id: "scope",
      q: "Can I use R = 0.1 as the reported load ratio for Material B? Explain using the saved source.",
      expected: "No evidence for Material B. The statement is explicitly scoped to Material A.",
    },
    {
      id: "missing-measurement",
      q: "By exactly what percentage did Treatment A improve fatigue performance? Cite the measurement.",
      expected: "No percentage is supplied; refuse to invent a value.",
    },
    {
      id: "selected-passage",
      q: "Using this selected passage, summarize the test conditions and their scope.",
      expected: "Room temperature; R = 0.1 only for Material A; retain qualifiers.",
      selected: true,
    },
    {
      id: "replaced-source",
      q: "What load ratio is reported in this saved graph version? Cite it.",
      expected: "R = 0.1 from the original saved snapshot, never the replacement value 0.9.",
      required: /0\.1/,
      replace: true,
    },
    {
      id: "missing-snapshot",
      q: "What load ratio is reported? Can you verify it from the saved source?",
      expected: "Explicitly unable to verify because 0/1 snapshots are available; no confident source claim.",
      missing: true,
    },
  ];
  for (const test of cases) {
    if (test.replace) {
      const detail = await c.json<{ corpus: { settings: { corpus: { members: { id: string }[] } } } }>("GET", `${root}/corpus`);
      const uploaded = await c.upload(
        `${root}/corpus/documents?member=${detail.body.corpus.settings.corpus.members[0].id}`,
        "replacement.txt",
        "The NEW current document reports a load ratio R = 0.9 for Material A.",
        false,
      );
      if (uploaded.status !== 201) throw new Error("Replacement failed");
      await worker!.tick();
    }
    if (test.missing) await store.forUser({ id: "real-review" }).blobs.delete(`${f.corpus.id}/research/${f.runId}/inputs.json`);
    let passageKey: string | undefined;
    if (test.selected) {
      const found = await c.json<{ passages: { key: string }[] }>("POST", `${root}/revisions/${f.revision.id}/evidence/search`, {
        query: "load ratio",
      });
      passageKey = found.body.passages[0].key;
    }
    console.log(`Running ${test.id} with ${provider}/${model}`);
    const r = await fetch(url + root + "/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: test.q, revisionId: f.revision.id, provider, model, passageKey }),
      signal: AbortSignal.timeout(240000),
    });
    const raw = await r.text();
    const events = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
    const saved = events.find((e) => e.type === "saved");
    if (!r.ok || !saved || saved.type !== "saved") throw new Error(`Case ${test.id}: HTTP ${r.status}; no saved answer`);
    const conv = await c.json<{ conversation: Conversation }>("GET", `${root}/conversations/${saved.conversationId}`);
    const answer = conv.body.conversation.messages.find((m) => m.id === saved.messageId)!;
    const passages = answer.agent?.passages || [];
    const refs = [...new Set([...answer.content.matchAll(/\bC\d+\b/g)].map((m) => m[0]))];
    const flags: string[] = [];
    if (answer.agent?.completion !== "complete") flags.push(`Completion: ${answer.agent?.completion}; ${answer.agent?.error || ""}`);
    if (answer.agent?.model !== model) flags.push(`Unexpected model: ${answer.agent?.model}`);
    if (test.required && !test.required.test(answer.content)) flags.push("Expected factual value missing (heuristic).");
    if (!test.missing && !refs.length) flags.push("No source citation in answer.");
    if (test.replace && /0\.9/.test(answer.content)) flags.push("Replacement value leaked into saved-version answer.");
    const evidenceChecks = [];
    for (const ref of refs) {
      const p = passages.find((p) => p.ref === ref);
      if (!p) {
        flags.push(`Unresolved reference ${ref}`);
        continue;
      }
      const context = await c.json<DocumentText>("GET", `${root}/revisions/${f.revision.id}/evidence/passages/${p.key}`);
      const exact = context.status === 200 && context.body.text.slice(p.evidence.start, p.evidence.end) === p.evidence.quote;
      evidenceChecks.push({ ref, exact, status: context.status });
      if (!exact) flags.push(`${ref}: captured quote does not resolve exactly to snapshot offsets.`);
    }
    for (const ref of new Set([...answer.content.matchAll(/\bQ\d+\b/g)].map((m) => m[0]))) {
      const run = answer.agent?.runs.find((r) => r.id === ref);
      if (!run?.ok) flags.push(`Unresolved or failed graph citation ${ref}`);
    }
    if (answer.agent?.sourceCoverage?.revisionId !== f.revision.id) flags.push("Wrong source revision");
    const words = answer.content.trim().split(/\s+/).length;
    const toolCalls = answer.agent?.tools.length ?? 0;
    if (/\$[^$\n]+\$|\\(?:frac|text|mathrm)\b/.test(answer.content)) flags.push("UX: raw LaTeX in answer.");
    if (/SPARQL|ex:pump|triples|search index/i.test(answer.content)) flags.push("UX: unnecessary implementation terminology.");
    if (words > 140) flags.push("UX: long answer for a simple question (>140 words; heuristic).");
    if (test.missing) {
      const opening = answer.content.split(/\n/).find((line) => line.trim()) ?? "";
      if (!/cannot|can't|unable|unavailable|could not|couldn't|not (?:possible|available)/i.test(opening))
        flags.push("UX: source verification limitation is not in the opening line.");
      if (answer.agent?.tools.some((t) => t.name === "search_documents")) flags.push("Unavailable source search tool was invoked.");
    }
    issueCount += flags.length;
    const result = {
      id: test.id,
      question: test.q,
      expected: test.expected,
      answer,
      refs,
      evidenceChecks,
      flags,
      metrics: { words, toolCalls },
      events,
    };
    results.push(result);
    await writeFile(
      join(out, "results.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          provider,
          model,
          fixture: "Synthetic fatigue study; mock extraction, real model answering; one independent conversation per case",
          results,
        },
        null,
        2,
      ),
    );
    cards.push(
      `<section><h2>${esc(test.id)}</h2><h3>Question</h3><p>${esc(test.q)}</p><h3>Expected behavior</h3><p>${esc(test.expected)}</p><h3>Actual answer (verbatim)</h3><pre>${esc(answer.content)}</pre><h3>Automated flags</h3><p>${esc(flags.join("\n") || "No mechanical issues detected. Claim support still requires human review.")}</p><p>Completion: ${esc(answer.agent?.completion || "unknown")} · Coverage: ${answer.agent?.sourceCoverage?.available}/${answer.agent?.sourceCoverage?.total} · ${answer.agent?.durationMs} ms</p><h3>Source evidence</h3>${passages.map((p) => `<details ${refs.includes(p.ref) ? "open" : ""}><summary>${esc(p.ref + " · " + p.title + " · " + p.where)} — ${refs.includes(p.ref) ? "cited" : "retrieved, not cited"}</summary><pre>${esc(p.evidence.quote || "")}</pre><small>Offsets ${p.evidence.start}–${p.evidence.end} · key ${esc(p.key)}</small></details>`).join("") || "<p>No source passages available.</p>"}<h3>Graph evidence</h3>${
        (answer.agent?.runs || [])
          .filter((r) => r.purpose === "agent")
          .map(
            (r) =>
              `<details><summary>${esc(r.id)} · ${r.rowCount} rows · ${r.ok ? "succeeded" : "failed"}</summary><pre>${esc(r.query)}</pre><pre>${esc(JSON.stringify(r.rows, null, 2))}</pre></details>`,
          )
          .join("") || "<p>No graph queries.</p>"
      }<p><label><input type="checkbox"> Claim supported</label> <label><input type="checkbox"> Context preserved</label> <label><input type="checkbox"> Useful answer</label></p><textarea placeholder="Your review notes (temporary; print to save)"></textarea></section>`,
    );
    console.log(`${test.id}: ${flags.length ? flags.join("; ") : "mechanical checks passed"}`);
  }
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "review.html"),
    `<!doctype html><meta charset="utf-8"><title>OntoLab real-model evidence review</title><style>body{font:16px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:20px;background:#f6f5f0;color:#202821}section{background:white;border:1px solid #ddd;border-radius:12px;padding:28px;margin:24px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 system-ui;background:#f2f4ef;padding:16px}textarea{width:95%;min-height:80px}summary{cursor:pointer}small{overflow-wrap:anywhere}h2{color:#32634b}@media print{section{break-inside:avoid}}</style><h1>OntoLab real-model evidence review</h1><p>${esc(provider + " / " + model)} · ${new Date().toISOString()}</p><p>Controlled synthetic fatigue study. Corpus extraction uses the mock; every answer below uses the named real provider through OntoLab’s HTTP Ask endpoint. This is a small diagnostic sample, not a production quality benchmark. Each case starts a fresh conversation. Raw responses and tool events: <a href="results.json">results.json</a>. Complete source: <a href="source.txt">source.txt</a>.</p><p>Review each answer against its cited passages: Is the claim supported? Are material and test conditions preserved? Does uncertainty read clearly? Checkboxes and notes are temporary; print to save.</p>${cards.join("")}`,
  );
  await worker?.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await stopSparqlPool();
  await rm(data, { recursive: true, force: true });
}
console.log(`Review written to ${out}/review.html`);

if (issueCount) process.exitCode = 1;
