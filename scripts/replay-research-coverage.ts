// Recheck the preserved capability-as-observed failure against its own evidence.
import { config } from "dotenv";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
if (!process.env.EVIDENCE_BASELINE) throw new Error("EVIDENCE_BASELINE must name the preserved review directory");
const { checkAnswerSemantics } = await import("../server/graphchat/semanticCheck.ts");
const { checkAnswerSources, answerSourceIssues } = await import("../server/graphchat/sourceCheck.ts");
const baseline = resolve(process.env.EVIDENCE_BASELINE);
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-scientific-followup");
await mkdir(out, { recursive: true });
const before = JSON.parse(await readFile(join(baseline, "answers.json"), "utf8")) as {
  results: { id: string; q: string; answer: ConversationMessage }[];
};
const item = before.results.find((r) => r.id === "two-paper-comparison");
if (!item) throw new Error("Baseline comparison answer missing");
const evidence = new Map(item.answer.agent?.passages?.map((p) => [p.ref, p.evidence.quote]) ?? []);
for (const run of item.answer.agent?.runs.filter((r) => r.ok) ?? [])
  evidence.set(
    run.id,
    run.rows
      .slice(0, 50)
      .map((row) =>
        Object.values(row)
          .map((t) => t.value)
          .join(" | "),
      )
      .join("\n"),
  );
const originalIssues = answerSourceIssues(item.answer.content, evidence);
if (!originalIssues.some((i) => i.reason.includes("capability")))
  throw new Error("Baseline no longer contains the expected coverage defect");
const ctx = { provider: "gemini" as const, model: "gemini-3.8-flash", signal: AbortSignal.timeout(240000) };
const semantic = await checkAnswerSemantics(item.answer.content, item.q, evidence, ctx);
const literal = await checkAnswerSources(semantic.text, item.q, evidence, ctx);
const passed =
  semantic.semanticCheck.status !== "withheld" &&
  literal.sourceCheck.status !== "withheld" &&
  /(?:capable of testing|can test|ability to test) over 75/i.test(literal.text) &&
  !answerSourceIssues(literal.text, evidence).length;
await writeFile(
  join(out, "testing-coverage-replay.json"),
  JSON.stringify(
    {
      baseline,
      provider: ctx.provider,
      model: ctx.model,
      mock: false,
      passed,
      original: item,
      originalIssues,
      evidence: Object.fromEntries(evidence),
      semanticCheck: semantic.semanticCheck,
      sourceCheck: literal.sourceCheck,
      text: literal.text,
      usage: { semantic: semantic.usage, literal: literal.usage },
    },
    null,
    2,
  ),
);
console.log(`Preserved testing-coverage replay: ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
