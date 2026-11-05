// Throwaway verification for the ontology core (no LLM needed):
// parse the sample T-Box, serialize a hand-built A-Box, re-parse the Turtle,
// validate, and convert to a graph. Run: npx tsx scripts/ontology-check.ts
import { readFileSync } from "node:fs";
import { Parser } from "n3";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { serializeABox } from "../src/lib/ontology/aboxSerializer.ts";
import { validateABox } from "../src/lib/ontology/aboxValidator.ts";
import { aboxToGraph } from "../src/lib/ontology/aboxToGraph.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const C = "http://ontolab.example/mechatronic#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const ttl = readFileSync(new URL("../samples/mechatronic-tbox.ttl", import.meta.url), "utf8");
const tbox = parseTBox(ttl);
console.log(`T-Box: ${tbox.classes.length} classes, ${tbox.objectProps.length} object props, ${tbox.dataProps.length} data props`);
console.log(`baseIri: ${tbox.baseIri}`);

const abox: ABoxResult = {
  individuals: [
    { id: "distributing-station", classUri: C + "Station", label: "Distributing Station" },
    {
      id: "ejection-cylinder",
      classUri: C + "Actuator",
      label: "Ejection cylinder",
      dataProperties: [
        { propUri: C + "partNumber", value: "DSNU-8-80", datatype: XSD + "string" },
        { propUri: C + "position", value: "extended", datatype: XSD + "string" },
      ],
      objectProperties: [{ propUri: C + "partOf", targetId: "distributing-station" }],
      sourceEvidence: "Ausschiebezylinder DSNU-8-80",
    },
    {
      id: "eject-part",
      classUri: C + "Motion",
      label: "Eject part",
      dataProperties: [{ propUri: C + "hasDuration", value: "2.5", datatype: XSD + "decimal" }],
      objectProperties: [
        { propUri: C + "actsOn", targetId: "ejection-cylinder" },
        { propUri: C + "precedes", targetId: "grip-part" },
      ],
    },
    // deliberately introduce one issue: a bad datatype value to exercise the validator
    {
      id: "grip-part",
      classUri: C + "Motion",
      label: "Grip part",
      dataProperties: [{ propUri: C + "hasDuration", value: "fast", datatype: XSD + "decimal" }],
    },
  ],
};

const { turtle } = serializeABox(abox, tbox);
console.log("\n--- A-Box Turtle ---\n" + turtle);

// re-parse to prove the Turtle is valid
const reparsed = new Parser().parse(turtle);
console.log(`Re-parsed Turtle: ${reparsed.length} triples (valid).`);

const issues = validateABox(abox, tbox);
console.log(`\nValidation issues: ${issues.length}`);
for (const i of issues) console.log(`  [${i.severity}/${i.code}] ${i.message}  @ ${i.where}`);

const graph = aboxToGraph(abox);
console.log(`\nGraph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

// Assert rather than unconditionally printing OK: this script used to "pass"
// even when the pipeline was broken.
const failures: string[] = [];
if (tbox.classes.length !== 7) failures.push(`expected 7 classes, got ${tbox.classes.length}`);
if (reparsed.length === 0) failures.push("serialized Turtle produced no triples");
if (!turtle.includes("owl:NamedIndividual")) failures.push("export is missing owl:NamedIndividual");
if (!turtle.includes("dcterms:source")) failures.push("export is missing provenance");
// The deliberately-bad "fast" duration must be caught.
if (!issues.some((i) => i.code === "lexical")) failures.push("validator did not flag the invalid decimal value");
if (graph.nodes.length !== abox.individuals.length) failures.push(`graph has ${graph.nodes.length} nodes for ${abox.individuals.length} individuals`);

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("OK");
