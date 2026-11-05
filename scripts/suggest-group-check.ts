// Verify the pure per-module grouping + edit application of coverage suggestions
// (no LLM). Run: npx tsx scripts/suggest-group-check.ts
import { groupSuggestion } from "../server/extract.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

const BASE = "http://ex/plant#";

const baseTurtle = [
  "@prefix : <http://ex/plant#> .",
  "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
  "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
  "",
  ":Component a owl:Class .",
  ":Pump a owl:Class ; rdfs:subClassOf :Component .",
  ":Tank a owl:Class ; rdfs:subClassOf :Component .",
  ":feeds a owl:ObjectProperty ; rdfs:domain :Pump ; rdfs:range :Tank .",
].join("\n");
const modules = [{ name: "base.ttl", turtle: baseTurtle }];

// Add Sensor (to base.ttl) + Gauge (untagged → new module); remove Tank; rename Pump → Machine.
const classes = [
  { name: "Sensor", label: "Sensor", module: "base.ttl" },
  { name: "Gauge", label: "Gauge" },
];
const removals = [{ term: "Tank", module: "base.ttl" }];
const renames = [{ from: "Pump", to: "Machine", module: "base.ttl" }];

const buckets = groupSuggestion(classes, [], [], removals, renames, modules, BASE);
const upd = buckets.find((b) => b.name === "base.ttl");
const fresh = buckets.find((b) => b.isNew);

const updModel = upd ? parseTBox(upd.turtle) : null;
const updClassUris = updModel ? updModel.classes.map((c) => c.uri) : [];
const addModel = upd && upd.additionsTurtle ? parseTBox(upd.additionsTurtle) : null;

// Backward-compat: no modules → single suggested-module.ttl bucket.
const noModules = groupSuggestion(classes, [], [], [], [], [], BASE);

const checks: [string, boolean][] = [
  ["update bucket 'base.ttl' exists, isNew=false", !!upd && upd.isNew === false],
  ["updated module renames Pump → Machine", updClassUris.includes(BASE + "Machine") && !updClassUris.includes(BASE + "Pump")],
  ["updated module removes Tank", !updClassUris.includes(BASE + "Tank")],
  ["updated module keeps Component + adds Sensor", updClassUris.includes(BASE + "Component") && updClassUris.includes(BASE + "Sensor")],
  ["renamed feeds domain follows rename", !!updModel && (updModel.objectProps.find((p) => p.uri === BASE + "feeds")?.domain.includes(BASE + "Machine") ?? false)],
  ["additionsTurtle has only Sensor", !!addModel && addModel.classes.length === 1 && addModel.classes[0].uri === BASE + "Sensor"],
  ["removed list = [Tank]", !!upd && upd.removed.length === 1 && upd.removed[0] === "Tank"],
  ["renamed list = [Pump→Machine]", !!upd && upd.renamed.length === 1 && upd.renamed[0].from === "Pump" && upd.renamed[0].to === "Machine"],
  ["new bucket new-module.ttl has Gauge", !!fresh && fresh.name === "new-module.ttl" && fresh.addedClasses.includes("Gauge")],
  ["no-modules → suggested-module.ttl bucket", noModules.length === 1 && noModules[0].name === "suggested-module.ttl" && noModules[0].isNew === true],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "OK " : "XX "} ${label}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.log("\n--- updated module turtle ---\n" + (upd?.turtle ?? "(none)"));
  console.log("\n--- buckets ---\n" + JSON.stringify(buckets, null, 2));
}

console.log(ok ? "\nGROUP OK" : "\nGROUP MISMATCH");
process.exit(ok ? 0 : 1);
