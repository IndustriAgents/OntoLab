// Replay the two previously unlocated references using the same saved source.
import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RevisionWithContent, DocumentText } from "../src/types/project.ts";
config({ path: process.env.EVIDENCE_ENV_FILE || ".env", quiet: true });
process.env.MOCK_LLM = "0";
const { repairSourceQuotes } = await import("../server/services/quoteRepair.ts");
const { resolveEvidence } = await import("../server/services/evidence.ts");
const { listFacts } = await import("../src/lib/ontology/factReview.ts");
const baseline = resolve("output/research-e2e-final");
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-identity-fixed");
const revision = JSON.parse(await readFile(join(baseline, "extraction.json"), "utf8")) as RevisionWithContent;
const text = JSON.parse(await readFile(join(baseline, "sources/iec61499-portability.pdf.parsed.json"), "utf8")) as DocumentText;
const failed = (e: { status: string }) => e.status === "unverified";
const individuals = revision.content
  .abox!.individuals.filter((i) => i.evidence?.some(failed) || i.objectProperties?.some((p) => p.evidence?.some(failed)))
  .map((i) => ({ ...i, dataProperties: [], objectProperties: i.objectProperties?.filter((p) => p.evidence?.some(failed)) }));
const before = listFacts({ individuals }).filter((f) => f.evidence.some(failed));
if (before.length !== 2) throw new Error("Expected the two preserved failures");
const repaired = await repairSourceQuotes({ individuals }, [{ name: "iec61499-portability.pdf", text: text.text }], {
  provider: "gemini",
  model: "gemini-3.8-flash",
});
const documentId = before[0].evidence[0].documentId!;
const located = resolveEvidence(repaired.abox, { documentId, chunk: null, documentText: text.text, pages: text.pages });
const after = listFacts(located).filter((f) => before.some((b) => b.key === f.key));
const passed =
  after.length === 2 && after.every((f) => f.evidence.every((e) => e.status === "verified" && text.text.slice(e.start, e.end) === e.quote));
await writeFile(
  join(out, "cross-page-replay.json"),
  JSON.stringify({ model: "gemini-3.8-flash", mock: false, before, after, notes: repaired.notes, usage: repaired.usage, passed }, null, 2),
);
console.log(`Original cross-page failures repaired with exact source ranges: ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
