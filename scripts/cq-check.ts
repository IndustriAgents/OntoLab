// Verify the competency-question query path (no LLM): serialize T-Box subsumption
// + A-Box to Turtle, load into Oxigraph, run a SPARQL query using a subclass
// property path, and assert the expected rows.
// Run: npx tsx scripts/cq-check.ts
import { serializeABox } from "../src/lib/ontology/aboxSerializer.ts";
import type { TBoxModel } from "../src/types/tbox.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const C = "http://ex/onto#";
const RDFS_SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const tbox: TBoxModel = {
  prefixes: { "": C },
  baseIri: C,
  classes: [{ uri: C + "Component" }, { uri: C + "PneumaticComponent" }],
  objectProps: [],
  dataProps: [],
  subClassOf: { [C + "PneumaticComponent"]: [C + "Component"] },
};

const abox: ABoxResult = {
  individuals: [
    { id: "cylinder", classUri: C + "PneumaticComponent", label: "Cylinder" },
    { id: "frame", classUri: C + "Component", label: "Frame" },
  ],
};

// Build the same merged graph the server builds (A-Box + subClassOf triples).
const aboxTurtle = serializeABox(abox, tbox).turtle;
const subclass = Object.entries(tbox.subClassOf)
  .flatMap(([child, parents]) => parents.map((p) => `<${child}> <${RDFS_SUBCLASS}> <${p}> .`))
  .join("\n");
const merged = `${aboxTurtle}\n${subclass}\n`;

const oxigraph = await import("oxigraph");
const store = new oxigraph.Store();
store.load(merged, { format: "text/turtle" });

// "Which components (including subclasses) are there?" — subclass path.
const q = `SELECT ?c ?label WHERE {
  ?c <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>/<${RDFS_SUBCLASS}>* <${C}Component> .
  OPTIONAL { ?c <http://www.w3.org/2000/01/rdf-schema#label> ?label }
}`;
const rows = store.query(q) as Map<string, { value: string }>[];
const labels = rows
  .map((b) => b.get("label")?.value)
  .filter((v): v is string => !!v)
  .sort();
console.log("Components (incl. subclasses):", labels.join(", "));

const ok = labels.length === 2 && labels[0] === "Cylinder" && labels[1] === "Frame";
console.log(ok ? "\nCQ CHECK OK" : "\nCQ CHECK MISMATCH");
process.exit(ok ? 0 : 1);
