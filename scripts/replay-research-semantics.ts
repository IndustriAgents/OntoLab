import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
const { checkAnswerSemantics } = await import("../server/graphchat/semanticCheck.ts");
const { checkAnswerSources } = await import("../server/graphchat/sourceCheck.ts");
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-completeness");
const before = JSON.parse(await readFile("output/research-e2e-scientific-review/answers.json", "utf8")) as {
  results: { id: string; q: string; answer: ConversationMessage }[];
};
const results = [];
const cases = before.results.filter((r) => ["plant-method", "graph-limitations", "two-paper-comparison"].includes(r.id));
const recent = await readFile(join(out, "answers-before-interface-refinement.json"), "utf8").then(
  (s) => (JSON.parse(s) as typeof before).results[0],
  () => undefined,
);
if (recent) cases.push({ ...recent, id: "method-transition-specificity" });
for (const item of cases) {
  const evidence = new Map(item.answer.agent!.passages!.map((p) => [p.ref, p.evidence.quote]));
  for (const run of item.answer.agent!.runs.filter((r) => r.ok))
    evidence.set(
      run.id,
      run.rows
        .slice(0, 50)
        .map((row) =>
          Object.values(row)
            .map((v) => v.value)
            .join(" | "),
        )
        .join("\n"),
    );
  const ctx = { provider: "gemini" as const, model: "gemini-3.8-flash", signal: AbortSignal.timeout(180000) };
  const reviewed = await checkAnswerSemantics(item.answer.content, item.q, evidence, ctx);
  const checked = await checkAnswerSources(reviewed.text, item.q, evidence, ctx);
  const knownDefectGone = ["plant-method", "method-transition-specificity"].includes(item.id)
    ? !/FSM (?:transitions(?: and states)?|states) (?:are )?(?:mapped|transformed) (?:to|into) (?:the )?(?:basic )?function block (?:input\/output events and variables|interface)/i.test(
        checked.text,
      ) && !/after the actuator transition/i.test(checked.text)
    : item.id === "graph-limitations"
      ? !/large[ -]scale/i.test(checked.text)
      : !/Schneider|Automation Expert/.test(checked.text);
  const passed = reviewed.semanticCheck.status === "repaired" && checked.sourceCheck.status !== "withheld" && knownDefectGone;
  results.push({
    id: item.id,
    question: item.q,
    ...reviewed,
    text: checked.text,
    literalCheck: checked.sourceCheck,
    knownDefectGone,
    passed,
  });
  await writeFile(
    join(out, "semantic-replay.json"),
    JSON.stringify({ provider: ctx.provider, model: ctx.model, mock: false, results }, null, 2),
  );
  console.log(`${item.id}: ${passed ? "PASS" : "FAIL"}; ${reviewed.semanticCheck.status}; edits ${reviewed.semanticCheck.edits.length}`);
}
if (results.length !== cases.length || results.some((r) => !r.passed)) process.exitCode = 1;
