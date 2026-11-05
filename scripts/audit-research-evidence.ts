import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { locateQuote } from "../src/lib/sourceQuote.ts";
import type { FactRow } from "../src/lib/ontology/factReview.ts";
import type { ABoxResult } from "../src/types/abox.ts";
import type { DocumentText } from "../src/types/project.ts";
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-title-repair");
const read = async <T>(p: string) => JSON.parse(await readFile(join(out, p), "utf8")) as T;
const state = await read<{ documents: { id: string; name: string; sha256: string }[] }>("state.json");
const facts = await read<FactRow[]>("facts.json");
const docs = new Map(
  await Promise.all(state.documents.map(async (d) => [d.id, await read<DocumentText>(`sources/${d.name}.parsed.json`)] as const)),
);
const extraction = await read<{ content: { abox: ABoxResult } }>("extraction.json");
const studies = extraction.content.abox.individuals.filter((i) => i.classUri.endsWith("#Study"));
const normalizeTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/p\s*ro\s*m/g, "prom")
    .replace(/[^a-z0-9]/g, "");
const expectedTitles = [
  "Plant model generation from event log using ProM for formal verification of CPS",
  "Developing a Test Suite for Evaluating IEC 61499 Application Portability",
];
const identityFindings: string[] = [];
const primaryStudies = studies.filter((i) =>
  i.dataProperties?.some(
    (p) => p.propUri.endsWith("#title") && expectedTitles.some((title) => normalizeTitle(p.value) === normalizeTitle(title)),
  ),
);
// Bibliography entries are grounded mentions of other publications, not extra
// identities for the two uploaded papers. Keep them visible and separate.
const citedStudyIdentities: string[] = [];
const bibliographyRanges = new Map(
  [...docs].map(([id, doc]) => {
    const ranges = (doc.sections ?? []).filter((s) => /^(?:references|bibliography)$/i.test(s.title.replace(/\s+/g, "")));
    // This PDF parser does not always produce sections for two-column papers.
    // A standalone References heading in saved text still supplies a checkable range.
    const marker = /^\s*(?:R\s*EFERENCES|BIBLIOGRAPHY)\s*$/im.exec(doc.text);
    return [id, ranges.length ? ranges : marker ? [{ start: marker.index, end: doc.text.length }] : []] as const;
  }),
);
for (const study of studies.filter((i) => !primaryStudies.includes(i))) {
  const rows = facts.filter((f) => f.individualId === study.id);
  const referenceOnly =
    rows.length > 0 &&
    rows.every(
      (f) =>
        f.evidence.length > 0 &&
        f.evidence.every(
          (e) =>
            e.status === "verified" &&
            e.start != null &&
            e.end != null &&
            bibliographyRanges.get(e.documentId || "")?.some((s) => e.start! >= s.start && e.end! <= s.end),
        ),
    );
  if (referenceOnly) citedStudyIdentities.push(study.id);
  else identityFindings.push(`Additional study identity outside the source titles or bibliography: ${study.id}`);
}
for (const title of expectedTitles) {
  const matches = studies.filter((i) =>
    i.dataProperties?.some((p) => p.propUri.endsWith("#title") && normalizeTitle(p.value) === normalizeTitle(title)),
  );
  if (matches.length !== 1) identityFindings.push(`Expected one complete title property for ${title}; found ${matches.length}`);
}
for (const study of studies) {
  const titles = study.dataProperties?.filter((p) => p.propUri.endsWith("#title")) ?? [];
  if (new Set(titles.map((p) => normalizeTitle(p.value))).size < titles.length)
    identityFindings.push(`Duplicate equivalent title assertions for ${study.id}`);
}
// Independent fixture check: a study title cannot simply be a body-section heading.
// A located quotation alone would otherwise let this semantic misclassification pass.
const sectionTitleFindings = facts
  .filter(
    (f) =>
      f.propUri?.endsWith("#title") &&
      studies.some((s) => s.id === f.individualId) &&
      f.evidence.some((e) =>
        docs
          .get(e.documentId || "")
          ?.sections?.some(
            (s) =>
              s.start > 0 &&
              s.level > 1 &&
              normalizeTitle(s.title.replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)])\s+/, "")) ===
                normalizeTitle((f.value || "").replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)])\s+/, "")),
          ),
      ),
  )
  .map((f) => ({ key: f.key, value: f.value, evidence: f.evidence }));
const statuses: Record<string, number> = {};
const pageMismatches: unknown[] = [];
const invalidLocations: unknown[] = [];
for (const f of facts)
  for (const e of f.evidence) {
    statuses[e.status] = (statuses[e.status] || 0) + 1;
    if (e.status !== "verified") continue;
    const doc = docs.get(e.documentId || "");
    if (!doc || e.start == null || e.end == null || !locateQuote(e.quote, doc.text.slice(e.start, e.end)))
      invalidLocations.push({ fact: f.key, evidence: e });
    const actual = doc?.pages.find((p) => e.start != null && p.start <= e.start && e.start < p.end)?.page;
    if (actual !== e.page) pageMismatches.push({ fact: f.key, reportedPage: e.page, offsetPage: actual });
  }
const sourceHashes = await Promise.all(
  state.documents.map(async (d) => ({
    name: d.name,
    sha256: d.sha256,
    matches:
      createHash("sha256")
        .update(await readFile(join(out, "sources", d.name)))
        .digest("hex") === d.sha256,
  })),
);
const diagnostic = {
  facts: facts.length,
  studyIdentities: studies.map((i) => ({
    id: i.id,
    label: i.label,
    titles: i.dataProperties?.filter((p) => p.propUri.endsWith("#title")).map((p) => p.value),
  })),
  primaryStudyIds: primaryStudies.map((i) => i.id),
  citedStudyIdentities,
  identityFindings,
  sectionTitleFindings,
  evidenceStatuses: statuses,
  pageMismatches,
  invalidLocations,
  noEvidence: facts.filter((f) => !f.evidence.length).map((f) => f.key),
  unlocatedFacts: facts.filter((f) => !f.evidence.some((e) => e.status === "verified")).map((f) => f.key),
  sourceHashes,
};
await writeFile(join(out, "extraction-diagnostics.json"), JSON.stringify(diagnostic, null, 2));
console.log(
  JSON.stringify(
    {
      facts: facts.length,
      primaryStudyIds: primaryStudies.map((i) => i.id),
      citedStudyIdentities,
      identityFindings,
      sectionTitleFindings,
      evidenceStatuses: statuses,
      pageMismatches: pageMismatches.length,
      invalidLocations: invalidLocations.length,
      noEvidence: diagnostic.noEvidence.length,
      unlocatedFacts: diagnostic.unlocatedFacts.length,
      sourceHashes,
    },
    null,
    2,
  ),
);
if (
  identityFindings.length ||
  sectionTitleFindings.length ||
  (statuses.unverified ?? 0) ||
  pageMismatches.length ||
  invalidLocations.length ||
  diagnostic.unlocatedFacts.length ||
  sourceHashes.some((s) => !s.matches)
)
  process.exitCode = 1;
