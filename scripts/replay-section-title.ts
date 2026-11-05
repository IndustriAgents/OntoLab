// Deterministic replay of the exact pre-review checkpoint that proposed a section as a publication title.
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { omitSectionHeadingTitles } from "../server/services/documentTitle.ts";
import type { ABoxResult } from "../src/types/abox.ts";
import type { DocumentText } from "../src/types/project.ts";
if (!process.env.EVIDENCE_BASELINE) throw new Error("EVIDENCE_BASELINE must name the preserved semantic-recovery review directory");
const baseline = resolve(process.env.EVIDENCE_BASELINE);
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-section-titles");
const read = async <T>(name: string) => JSON.parse(await readFile(join(baseline, name), "utf8")) as T;
const state = await read<{ corpusId: string; runId: string; documents: { id: string; name: string }[] }>("state.json");
const findings = await read<{ findings: { fact: { individualId: string; propUri: string; value: string } }[] }>(
  "manual-extraction-findings.json",
);
const fact = findings.findings[0].fact;
const source = state.documents.find((d) => d.name === "plant-model-prom.pdf")!;
const document = await read<DocumentText>(`sources/${source.name}.parsed.json`);
const dir = `data/u/research-e2e-agent/p/${state.corpusId}/runs/${state.runId}.cp`;
const checkpoints = await Promise.all(
  (await readdir(join(baseline, dir))).map((f) =>
    read<{
      key: string;
      abox?: ABoxResult;
      trace?: { input?: { knownIndividuals?: ABoxResult } };
    }>(`${dir}/${f}`),
  ),
);
const checkpoint = checkpoints.find(
  (c) =>
    c.key.startsWith("chunk:") &&
    c.abox?.individuals.some(
      (i) => i.id === fact.individualId && i.dataProperties?.some((p) => p.propUri === fact.propUri && p.value === fact.value),
    ),
);
if (!checkpoint?.abox || !checkpoint.trace?.input?.knownIndividuals)
  throw new Error("Original failing checkpoint or prior identities missing");
const prior = checkpoint.trace.input.knownIndividuals;
const before = JSON.stringify({ input: checkpoint.abox, prior });
const result = omitSectionHeadingTitles(checkpoint.abox, prior, source.id, document);
const expected = structuredClone(checkpoint.abox);
const subject = expected.individuals.find((i) => i.id === fact.individualId)!;
subject.dataProperties = subject.dataProperties?.filter((p) => !(p.propUri === fact.propUri && p.value === fact.value));
const passed =
  result.notes.length === 1 &&
  JSON.stringify(result.abox) === JSON.stringify(expected) &&
  before === JSON.stringify({ input: checkpoint.abox, prior });
await mkdir(out, { recursive: true });
await writeFile(
  join(out, "section-title-replay.json"),
  JSON.stringify(
    {
      passed,
      mode: "deterministic original-checkpoint replay; not a new model extraction",
      baseline,
      checkpoint: checkpoint.key,
      documentId: source.id,
      original: checkpoint.abox,
      prior,
      sections: document.sections,
      ...result,
    },
    null,
    2,
  ),
);
console.log(`Original section-title checkpoint: ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
