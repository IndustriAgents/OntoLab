// Fixture-specific assertions plus stored-answer revalidation with the current guard.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage, Conversation } from "../src/types/project.ts";
import type { ChatEvent } from "../src/types/graphChat.ts";
import { answerSourceIssues } from "../server/graphchat/sourceCheck.ts";
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-answer-grounding");
const answers = JSON.parse(await readFile(join(out, "answers.json"), "utf8")) as {
  results: { id: string; answer: ConversationMessage; flags: string[]; events: ChatEvent[] }[];
};
const followup = await readFile(join(out, "browser-followup.json"), "utf8").then(
  (s) => JSON.parse(s) as Conversation,
  () => undefined,
);
const failures: string[] = [];
const checks = answers.results.map((r) => {
  let streamed = "";
  for (const event of r.events) {
    if (event.type === "text") streamed += event.text;
    if (event.type === "round_end" && event.hadTools) streamed = "";
  }
  const problems = [...r.flags];
  const evidence = new Map(r.answer.agent?.passages?.map((p) => [p.ref, p.evidence.quote]) ?? []);
  for (const run of r.answer.agent?.runs.filter((q) => q.ok) ?? [])
    evidence.set(
      run.id,
      run.rows
        .slice(0, 50)
        .map((row) =>
          Object.values(row)
            .map((term) => term.value)
            .join(" | "),
        )
        .join("\n"),
    );
  const currentGuardIssues = r.answer.agent?.passages?.length ? answerSourceIssues(r.answer.content, evidence) : [];
  if (currentGuardIssues.length) problems.push("Stored answer fails the current source-fidelity guard");
  if (streamed.trim() !== r.answer.content.trim()) problems.push("Stream and saved answer differ");
  if (/Platform\s+Independent\s+Petri\s+Net\s+Editor/i.test(r.answer.content)) problems.push("Unsupported PIPE expansion");
  if (/EcoStruxure\s+Automation\s+Expert/i.test(r.answer.content)) problems.push("Unsupported EAE expansion, including a bare full name");
  if (/\bAG\s*!?\s*\([^)]*HOME/s.test(r.answer.content)) problems.push("Changed G to AG in HOME/END formula");
  if (r.answer.agent?.sourceCheck?.status === "withheld") problems.push("Answer withheld after failed source check");
  if (r.answer.agent?.semanticCheck?.status === "withheld") problems.push("Answer withheld after semantic review");
  if (/Schneider/.test(r.answer.content)) problems.push("Unsupported correction of source vendor spelling");
  if (
    r.id === "plant-method" &&
    /FSM (?:transitions(?: and states)?|states) (?:are )?(?:mapped|transformed) (?:to|into) (?:the )?(?:basic )?function block (?:input\/output events and variables|interface)/i.test(
      r.answer.content,
    )
  )
    problems.push("Unsupported state/transition to interface-variable mapping");
  if (r.id === "graph-limitations" && /large[ -]scale/i.test(r.answer.content))
    problems.push("Real examples broadened to large-scale systems");
  const printedFormula = r.id === "two-paper-comparison" ? /\bG\s*!\s*\([^)]*HOME[^)]*END/s.test(r.answer.content) : undefined;
  if (printedFormula === false) problems.push("Expected printed G HOME/END formula not retained");
  const scientificRun = answers.results.some((item) => item.id === "scientific-qualifiers");
  if (scientificRun && r.id === "plant-method") {
    if (!/UaExpert/i.test(r.answer.content) || !/OPC\s*UA/i.test(r.answer.content))
      problems.push("Workflow omits the source's logging method");
    if (/Start.*End/i.test(r.answer.content) && !/recommend|better to remove|suggest/i.test(r.answer.content))
      problems.push("Start/End removal loses recommendation wording");
  }
  if (
    r.id === "scientific-qualifiers" &&
    (!/recommend|better to remove|suggest/i.test(r.answer.content) || !/non.?determin/i.test(r.answer.content))
  )
    problems.push("Missing recommendation/non-determinism distinction");
  if (r.id === "graph-limitations" && (!/\bQ\d+\b/.test(r.answer.content) || !/\bC\d+\b/.test(r.answer.content)))
    problems.push("Graph limitations answer must cite both graph and source");
  if (r.id === "testing-coverage" && (!/75/.test(r.answer.content) || !/capab|can test|ability to test/i.test(r.answer.content)))
    problems.push("Testing coverage answer must retain the stated capability and count");
  failures.push(...problems.map((p) => `${r.id}: ${p}`));
  return {
    id: r.id,
    semanticCheck: r.answer.agent?.semanticCheck?.status ?? "not applicable",
    sourceCheck: r.answer.agent?.sourceCheck?.status ?? "not applicable",
    originalIssues: r.answer.agent?.sourceCheck?.issues ?? [],
    currentGuardIssues,
    printedFormula,
    streamMatchesSaved: streamed.trim() === r.answer.content.trim(),
    problems,
  };
});
const required = ["graph-tools", "plant-method", "numerical-mux", "version-scope", "two-paper-comparison", "missing-performance"];
for (const id of required) if (answers.results.filter((r) => r.id === id).length !== 1) failures.push(`Expected one ${id} case`);
if (
  followup &&
  (followup.messages.at(-1)?.agent?.completion !== "complete" ||
    followup.messages.at(-1)?.agent?.sourceCheck?.status === "withheld" ||
    followup.messages.at(-1)?.agent?.semanticCheck?.status === "withheld")
)
  failures.push("Browser follow-up failed");
await writeFile(
  join(out, "answer-fidelity-audit.json"),
  JSON.stringify(
    { passed: !failures.length, failures, checks, browserFollowupComplete: followup?.messages.at(-1)?.agent?.completion === "complete" },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: !failures.length, failures, checks }, null, 2));
if (failures.length) process.exitCode = 1;
