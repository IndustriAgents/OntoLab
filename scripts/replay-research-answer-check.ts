// Real model repair of preserved failing answers, using only their saved evidence.
import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
const { checkAnswerSources, answerSourceIssues } = await import("../server/graphchat/sourceCheck.ts");
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-answer-grounding");
const before = JSON.parse(await readFile("output/research-e2e-title-repair/answers.json", "utf8")) as {
  results: { id: string; q: string; answer: ConversationMessage }[];
};
const results = [];
const cases = before.results.filter((r) => ["plant-method", "two-paper-comparison"].includes(r.id));
const recommendation = await readFile(join(out, "answers-before-modality-guard.json"), "utf8").then(
  (s) => (JSON.parse(s) as typeof before).results.find((r) => r.id === "plant-method"),
  () => undefined,
);
if (recommendation) cases.push({ ...recommendation, id: "recommendation-strength" });
for (const item of cases) {
  const sources = new Map(item.answer.agent!.passages!.map((p) => [p.ref, p.evidence.quote]));
  for (const r of item.answer.agent!.runs.filter((r) => r.ok))
    sources.set(
      r.id,
      r.rows
        .slice(0, 50)
        .map((row) =>
          Object.values(row)
            .map((t) => t.value)
            .join(" | "),
        )
        .join("\n"),
    );
  const result = await checkAnswerSources(item.answer.content, item.q, sources, {
    provider: "gemini",
    model: "gemini-3.8-flash",
    signal: AbortSignal.timeout(180000),
  });
  const passed =
    result.sourceCheck.status === "repaired" &&
    result.sourceCheck.issues.length > 0 &&
    answerSourceIssues(result.text, sources).length === 0;
  results.push({ id: item.id, question: item.q, ...result, passed });
  await writeFile(join(out, "answer-check-replay.json"), JSON.stringify({ model: "gemini-3.8-flash", mock: false, results }, null, 2));
  console.log(
    `${item.id}: ${passed ? "PASS" : "FAIL"}; ${result.sourceCheck.issues.length} original literal issues; ${result.sourceCheck.status}`,
  );
}
if (results.length !== cases.length || results.some((r) => !r.passed)) process.exitCode = 1;
