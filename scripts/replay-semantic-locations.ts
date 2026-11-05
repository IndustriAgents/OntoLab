// Reproduce the two retained validation failures, then repair their locations with the real model.
import { config } from "dotenv";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConversationMessage } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
if (!process.env.EVIDENCE_BASELINE) throw new Error("EVIDENCE_BASELINE must name the preserved merged-main review directory");
const { resolveSemanticEdits } = await import("../server/graphchat/semanticEdits.ts");
const { answerSourceIssues } = await import("../server/graphchat/sourceCheck.ts");
const baseline = resolve(process.env.EVIDENCE_BASELINE);
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-semantic-recovery");
await mkdir(out, { recursive: true });
const results = [];
for (const id of ["plant-method", "two-paper-comparison"]) {
  const original = JSON.parse(await readFile(join(baseline, `${id}-first-attempt.json`), "utf8")) as {
    id: string;
    q: string;
    answer: ConversationMessage;
  };
  const check = original.answer.agent?.semanticCheck;
  if (check?.status !== "withheld" || !check.draft || !check.edits.length) throw new Error(`Missing original failure: ${id}`);
  const evidence = new Map(original.answer.agent?.passages?.map((p) => [p.ref, p.evidence.quote]) ?? []);
  for (const run of original.answer.agent?.runs.filter((r) => r.ok) ?? [])
    evidence.set(
      run.id,
      run.rows
        .map((row) =>
          Object.values(row)
            .map((t) => t.value)
            .join(" | "),
        )
        .join("\n"),
    );
  for (let repeat = 1; repeat <= 3; repeat++) {
    const result = await resolveSemanticEdits(check.draft, evidence, check.edits, {
      provider: "gemini",
      model: "gemini-3.8-flash",
      signal: AbortSignal.timeout(180000),
    });
    const issues = result.text ? answerSourceIssues(result.text, evidence) : [];
    const unchangedIntent =
      result.edits.length === check.edits.length &&
      result.edits.every((e, i) => e.replacement === check.edits[i].replacement && e.reason === check.edits[i].reason);
    const knownDefectGone =
      id === "plant-method"
        ? !!result.text && !result.text.includes("Reference Model of Control (RCM)") && /recommendation to remove/.test(result.text)
        : !!result.text && result.text.includes("plant model FB derived from simulation event logs");
    const passed = !!result.text && !!result.repairAttempt && !result.error && !issues.length && unchangedIntent && knownDefectGone;
    results.push({
      id,
      repeat,
      original,
      evidence: Object.fromEntries(evidence),
      ...result,
      issues,
      unchangedIntent,
      knownDefectGone,
      passed,
    });
    await writeFile(
      join(out, "semantic-location-replay.json"),
      JSON.stringify({ baseline, provider: "gemini", model: "gemini-3.8-flash", mock: false, results }, null, 2),
    );
    console.log(`${id} repeat ${repeat}: ${passed ? "PASS" : "FAIL"}${result.error ? ` — ${result.error}` : ""}`);
  }
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
