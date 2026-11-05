// Verify the T-Box generation round-trip: structured schema -> Turtle ->
// parseTBox -> TBoxModel. Run: npx tsx scripts/tbox-gen-check.ts
import { serializeTBoxStructured, type RawTBox } from "../src/lib/ontology/tboxSerializer.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

const BASE = "http://ex/plant#";

const raw: RawTBox = {
  classes: [
    { name: "Component", label: "Component", comment: "A physical part of the plant." },
    { name: "Pump", label: "Pump", parents: ["Component"] },
    { name: "Tank", label: "Tank", parents: ["Component"] },
    { name: "Operation", label: "Operation", comment: "A process step." },
  ],
  objectProperties: [
    { name: "feeds", label: "feeds", domain: ["Pump"], range: ["Tank"] },
    { name: "performedOn", label: "performed on", domain: ["Operation"], range: ["Component"] },
  ],
  dataProperties: [
    { name: "ratedPower", label: "rated power", domain: ["Pump"], datatype: "decimal" },
    { name: "tagName", label: "tag name", domain: ["Component"], datatype: "string" },
    { name: "duration", label: "duration", domain: ["Operation"], datatype: "xsd:integer" },
  ],
};

const turtle = serializeTBoxStructured(raw, BASE);
console.log("--- Turtle ---\n" + turtle);

const m = parseTBox(turtle);
console.log(`Parsed: ${m.classes.length} classes, ${m.objectProps.length} obj props, ${m.dataProps.length} data props`);

const pump = m.classes.find((c) => c.uri === BASE + "Pump");
const pumpParents = m.subClassOf[BASE + "Pump"] ?? [];
const feeds = m.objectProps.find((p) => p.uri === BASE + "feeds");
const ratedPower = m.dataProps.find((p) => p.uri === BASE + "ratedPower");

const checks: [string, boolean][] = [
  ["4 classes", m.classes.length === 4],
  ["2 object props", m.objectProps.length === 2],
  ["3 data props", m.dataProps.length === 3],
  ["Pump class present (PascalCase preserved)", !!pump],
  ["Pump subClassOf Component", pumpParents.includes(BASE + "Component")],
  ["feeds domain=Pump range=Tank", feeds?.domain.includes(BASE + "Pump") === true && feeds?.range.includes(BASE + "Tank") === true],
  ["ratedPower datatype=xsd:decimal", ratedPower?.range.includes("http://www.w3.org/2001/XMLSchema#decimal") === true],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "OK " : "XX "} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nROUND-TRIP OK" : "\nROUND-TRIP MISMATCH");
process.exit(ok ? 0 : 1);
