// A fixed, source-derived checklist for these two PDFs. This measures coverage
// of named facets, not exhaustive recall, general entailment, or human acceptance.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { FactRow } from "../src/lib/ontology/factReview.ts";
const out = resolve(process.env.EVIDENCE_OUTPUT || "output/research-e2e-scientific-review");
const facts = JSON.parse(await readFile(join(out, "facts.json"), "utf8")) as FactRow[];
const state = JSON.parse(await readFile(join(out, "state.json"), "utf8")) as { documents: { id: string; name: string }[] };
const plant = state.documents.find((d) => d.name === "plant-model-prom.pdf")!.id;
const port = state.documents.find((d) => d.name === "iec61499-portability.pdf")!.id;
const own = (f: FactRow, doc: string) => f.evidence.some((e) => e.documentId === doc && e.status === "verified");
const prop = (f: FactRow, p: string) => f.propUri?.endsWith("#" + p) ?? false;
const value = (f: FactRow) => (f.value || "").replace(/-\s*\n/g, "").replace(/\s+/g, " ");
const checks: { id: string; expectation: string; represented: boolean; factKeys: string[] }[] = [];
const add = (id: string, expectation: string, predicate: (f: FactRow) => boolean) => {
  const hits = facts.filter(predicate);
  checks.push({ id, expectation, represented: hits.length > 0, factKeys: hits.map((f) => f.key) });
};
add(
  "scalability",
  "Plant conclusion: real-example scalability/speed still needs evaluation (p4).",
  (f) => own(f, plant) && prop(f, "limitation") && /scalab/i.test(value(f)),
);
add(
  "trace-coverage",
  "Plant conclusion: all possible trace scenarios remain future work (p4).",
  (f) => own(f, plant) && f.kind === "data" && /trace scenarios|all possible traces/i.test(value(f)),
);
add(
  "nondeterminism-description",
  "Spontaneous transitions are a modeling choice, described without asserting a failure (p2).",
  (f) => own(f, plant) && prop(f, "description") && /non.?determin|spontaneous transition/i.test(value(f)),
);
add(
  "removal-recommendation",
  "Start/End removal retains recommendation strength (p3).",
  (f) => own(f, plant) && f.kind === "data" && /Start.*End/i.test(value(f)) && /recommend|better|suggest/i.test(value(f)),
);
add(
  "logging",
  "OPC UA event logging with UaExpert is represented (p2).",
  (f) => own(f, plant) && f.kind === "data" && /UaExpert/i.test((f.label || "") + " " + value(f)) && /OPC\s*UA/i.test(value(f)),
);
add(
  "home-end-result",
  "Printed G HOME/END result is represented (p4), without changing G to AG.",
  (f) => own(f, plant) && f.kind === "data" && /\bG\s*!\s*\([^)]*HOME[^)]*END/s.test(value(f)) && !/\bAG\s*!/.test(value(f)),
);
add(
  "future-generation",
  "Automatic monitor/controller generation is future work (p4).",
  (f) => own(f, plant) && f.kind === "data" && /monitor/i.test(value(f)) && /future/i.test(value(f)),
);
add("4diac-version", "Tested 4DIAC version 2.0.1 is a value (p4).", (f) => own(f, port) && prop(f, "version") && /2\.0\.1/.test(value(f)));
add("eae-version", "Tested EAE version 21.2 is a value (p4).", (f) => own(f, port) && prop(f, "version") && /21\.2/.test(value(f)));
add(
  "mux-values",
  "MUX index 2 and time values/expected output are values, not merely quoted evidence (pp3–4).",
  (f) =>
    own(f, port) &&
    f.kind === "data" &&
    /MUX/i.test((f.label || "") + " " + value(f)) &&
    /1m30s/.test(value(f)) &&
    /15s/.test(value(f)) &&
    /2m30s/.test(value(f)) &&
    /(?:int1\s*=\s*2|index\s*(?:of\s*)?2)/i.test(value(f)) &&
    facts.some(
      (other) =>
        other.individualId === f.individualId && own(other, port) && /expected|should/i.test(value(other)) && /2m30s/.test(value(other)),
    ),
);
add(
  "cdata-finding",
  "Historical CDATA algorithm import failure is a finding/description, not a study limitation (p4).",
  (f) => own(f, port) && f.kind === "data" && !prop(f, "limitation") && /CDATA/.test(value(f)),
);
add(
  "argument-finding",
  "Missing-argument parser issue is recorded as a reported finding (p4).",
  (f) => own(f, port) && f.kind === "data" && !prop(f, "limitation") && /(?:one|missing) argument/i.test(value(f)),
);
add(
  "string-finding",
  "Historical CHAR/WCHAR/WSTRING support issue is represented (p4).",
  (f) => own(f, port) && f.kind === "data" && !prop(f, "limitation") && /WSTRING/.test(value(f)),
);
add(
  "import-format",
  "Nonstandard extended import format issue is represented (p4).",
  (f) => own(f, port) && f.kind === "data" && !prop(f, "limitation") && /extended import format/i.test(value(f)),
);
// Include the actual expected-output assertion in the review, not only the inputs.
const mux = checks.find((c) => c.id === "mux-values")!;
const outputFacts = facts.filter(
  (f) =>
    own(f, port) &&
    (prop(f, "reportedResult") || prop(f, "description")) &&
    /MUX/.test(value(f)) &&
    /expected/i.test(value(f)) &&
    /2m30s/.test(value(f)),
);
mux.factKeys = [...new Set([...mux.factKeys, ...outputFacts.map((f) => f.key)])];
const portText = JSON.parse(await readFile(join(out, "sources/iec61499-portability.pdf.parsed.json"), "utf8"));
const page4 = portText.pages.find((p: { page: number }) => p.page === 4);
const locatedMuxOutput = outputFacts.some((f) =>
  f.evidence.some(
    (e) =>
      e.start != null &&
      e.end != null &&
      e.start < page4.end &&
      e.end > page4.start &&
      /is MUX Out:=MUX\(int1,time1,time2,time3\) = 2m30s/.test(e.quote),
  ),
);
const unsupportedNames = facts.filter((f) => /EcoStruxure\s+Automation\s+Expert|Schneider/.test(f.label || "")).map((f) => f.key);
const wrongMappings = facts
  .filter((f) => own(f, plant) && prop(f, "limitation") && /non.?determin|spontaneous transition/i.test(value(f)))
  .map((f) => f.key);
const scores = facts
  .flatMap((f) => f.evidence)
  .reduce<Record<string, number>>((counts, e) => {
    const score = e.confidence == null ? "unscored" : String(e.confidence);
    counts[score] = (counts[score] || 0) + 1;
    return counts;
  }, {});
const result = {
  scope: "Fourteen source-derived coverage facets; textual matches are diagnostic, not semantic acceptance or exhaustive recall.",
  represented: checks.filter((c) => c.represented).length,
  total: checks.length,
  checks,
  wrongMappings,
  locatedMuxOutput,
  unsupportedNames,
  entailmentScores: scores,
  humanAcceptance: "pending",
};
await writeFile(join(out, "scientific-coverage-audit.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (
  wrongMappings.length ||
  !locatedMuxOutput ||
  unsupportedNames.length ||
  checks.some(
    (c) =>
      ["scalability", "trace-coverage", "nondeterminism-description", "removal-recommendation", "mux-values"].includes(c.id) &&
      !c.represented,
  )
)
  process.exitCode = 1;
