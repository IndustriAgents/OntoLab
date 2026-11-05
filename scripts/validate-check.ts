// Verify the modular-ontology validator: a clean extending module passes, and
// each breaking case yields the right error code + diff.
// Run: npx tsx scripts/validate-check.ts
import { validateOntology } from "../src/lib/ontology/validate.ts";
import type { OntoModule, ValidationReport } from "../src/types/validation.ts";

const PREF = [
  "@prefix : <http://ex/plant#> .",
  "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
  "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
  "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
  "",
].join("\n");

const BASE = "http://ex/plant#";

const baseModule: OntoModule = {
  id: "base",
  name: "base.ttl",
  turtle:
    PREF +
    [
      ":Component a owl:Class .",
      ":Pump a owl:Class ; rdfs:subClassOf :Component .",
      ":Tank a owl:Class ; rdfs:subClassOf :Component .",
      ":feeds a owl:ObjectProperty ; rdfs:domain :Pump ; rdfs:range :Tank .",
    ].join("\n"),
};

const codes = (r: ValidationReport) => r.issues.map((i) => i.code);

// (a) clean extending module
const clean = validateOntology([baseModule], {
  name: "sensors.ttl",
  turtle:
    PREF +
    [
      ":Sensor a owl:Class ; rdfs:subClassOf :Component .",
      ":monitors a owl:ObjectProperty ; rdfs:domain :Sensor ; rdfs:range :Component .",
    ].join("\n"),
});

// (b) dangling subClassOf target
const dangling = validateOntology([baseModule], {
  name: "valve.ttl",
  turtle: PREF + ":Valve a owl:Class ; rdfs:subClassOf :NonExistent .",
});

// (c) subclass cycle
const cycle = validateOntology([baseModule], {
  name: "cycle.ttl",
  turtle: PREF + [":A a owl:Class ; rdfs:subClassOf :B .", ":B a owl:Class ; rdfs:subClassOf :A ."].join("\n"),
});

// (d) edit base, removing :Component (still referenced by Pump/Tank)
const removed = validateOntology([baseModule], {
  id: "base",
  name: "base.ttl",
  turtle:
    PREF +
    [
      ":Pump a owl:Class ; rdfs:subClassOf :Component .",
      ":Tank a owl:Class ; rdfs:subClassOf :Component .",
      ":feeds a owl:ObjectProperty ; rdfs:domain :Pump ; rdfs:range :Tank .",
    ].join("\n"),
});

// (e) type-conflict — same URI is a class and an object property
const conflict = validateOntology([baseModule], {
  name: "conflict.ttl",
  turtle: PREF + ":Mixer a owl:Class , owl:ObjectProperty .",
});

const checks: [string, boolean][] = [
  ["(a) clean module is valid", clean.ok === true],
  ["(a) clean module adds :Sensor", clean.diff.added.classes.includes(BASE + "Sensor")],
  ["(a) clean module adds :monitors", clean.diff.added.objectProps.includes(BASE + "monitors")],
  ["(b) dangling ref is an error", dangling.ok === false && codes(dangling).includes("dangling-ref")],
  ["(c) subclass cycle is an error", cycle.ok === false && codes(cycle).includes("subclass-cycle")],
  ["(d) removing a referenced base class blocks", removed.ok === false],
  ["(d) reports removed-term", codes(removed).includes("removed-term")],
  ["(d) Component flagged removed", removed.diff.removed.classes.includes(BASE + "Component")],
  ["(e) type conflict is an error", conflict.ok === false && codes(conflict).includes("type-conflict")],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "OK " : "XX "} ${label}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.log("\n--- issue dump ---");
  for (const [name, r] of [["clean", clean], ["dangling", dangling], ["cycle", cycle], ["removed", removed], ["conflict", conflict]] as [string, ValidationReport][]) {
    console.log(`${name}: ok=${r.ok} ${JSON.stringify(codes(r))}`);
  }
}

console.log(ok ? "\nVALIDATE OK" : "\nVALIDATE MISMATCH");
process.exit(ok ? 0 : 1);
