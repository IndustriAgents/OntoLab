// Verify the manual-edit round-trip: ABox -> Turtle -> parseABoxTurtle -> ABox.
// Run: npx tsx scripts/edit-check.ts
import { serializeABox } from "../src/lib/ontology/aboxSerializer.ts";
import { parseABoxTurtle } from "../src/lib/ontology/aboxFromTurtle.ts";
import type { TBoxModel } from "../src/types/tbox.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const C = "http://ex/onto#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const tbox: TBoxModel = {
  prefixes: { "": C },
  baseIri: C,
  classes: [{ uri: C + "Component" }, { uri: C + "Motion" }],
  objectProps: [{ uri: C + "actsOn", domain: [], range: [], kind: "object" }],
  dataProps: [{ uri: C + "hasDuration", domain: [], range: [XSD + "decimal"], kind: "data" }],
  subClassOf: {},
};

const abox: ABoxResult = {
  individuals: [
    { id: "cylinder", classUri: C + "Component", label: "Cylinder" },
    {
      id: "eject",
      classUri: C + "Motion",
      label: "Eject",
      dataProperties: [{ propUri: C + "hasDuration", value: "2.5", datatype: XSD + "decimal" }],
      objectProperties: [{ propUri: C + "actsOn", targetId: "cylinder" }],
    },
  ],
};

const { turtle } = serializeABox(abox, tbox);
console.log("--- Turtle ---\n" + turtle);

const back = parseABoxTurtle(turtle);
console.log("Parsed individuals:", back.individuals.length);
for (const i of back.individuals) {
  console.log(
    `  ${i.id} : ${i.classUri.split(/[#/]/).pop()}` +
      (i.label ? ` "${i.label}"` : "") +
      ` data=${(i.dataProperties ?? []).map((d) => `${d.propUri.split(/[#/]/).pop()}=${d.value}^^${d.datatype?.split(/[#/]/).pop() ?? "str"}`).join(",")}` +
      ` obj=${(i.objectProperties ?? []).map((o) => `${o.propUri.split(/[#/]/).pop()}->${o.targetId}`).join(",")}`,
  );
}

const ok =
  back.individuals.length === 2 &&
  back.individuals.find((i) => i.id === "eject")?.dataProperties?.[0].value === "2.5" &&
  back.individuals.find((i) => i.id === "eject")?.objectProperties?.[0].targetId === "cylinder";
console.log(ok ? "\nROUND-TRIP OK" : "\nROUND-TRIP MISMATCH");
