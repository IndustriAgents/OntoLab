// Verify SHACL conformance validation (shapes induced from the T-Box).
// Run: npx tsx scripts/shacl-check.ts
//
// Case A: a conforming A-Box, including a subclass instance, must yield 0 issues
//         (exercises the rdfs:subClassOf ancestor-materialization path).
// Case B: a wrong object-range + a wrong datatype must yield exactly 2 issues.
import { validateShacl } from "../src/lib/ontology/shaclValidator.ts";
import type { TBoxModel } from "../src/types/tbox.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const C = "http://ex/onto#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// Component ⊐ PneumaticComponent ; Motion actsOn a Component ; hasDuration : decimal
const tbox: TBoxModel = {
  prefixes: { "": C },
  baseIri: C,
  classes: [
    { uri: C + "Component" },
    { uri: C + "PneumaticComponent" },
    { uri: C + "Motion" },
  ],
  objectProps: [{ uri: C + "actsOn", domain: [C + "Motion"], range: [C + "Component"], kind: "object" }],
  dataProps: [{ uri: C + "hasDuration", domain: [C + "Motion"], range: [XSD + "decimal"], kind: "data" }],
  subClassOf: { [C + "PneumaticComponent"]: [C + "Component"] },
};

// Case A — conforming. actsOn → a PneumaticComponent (subclass of Component → OK).
const aboxOk: ABoxResult = {
  individuals: [
    { id: "cylinder", classUri: C + "PneumaticComponent", label: "Cylinder" },
    {
      id: "eject",
      classUri: C + "Motion",
      label: "Eject",
      dataProperties: [{ propUri: C + "hasDuration", value: "2.5", datatype: XSD + "decimal" }],
      objectProperties: [{ propUri: C + "actsOn", targetId: "cylinder" }],
    },
  ],
};

// Case B — actsOn → a Motion (not a Component) and hasDuration "fast"^^string.
const aboxBad: ABoxResult = {
  individuals: [
    { id: "retract", classUri: C + "Motion", label: "Retract" },
    {
      id: "eject",
      classUri: C + "Motion",
      label: "Eject",
      dataProperties: [{ propUri: C + "hasDuration", value: "fast", datatype: XSD + "string" }],
      objectProperties: [{ propUri: C + "actsOn", targetId: "retract" }],
    },
  ],
};

const a = await validateShacl(aboxOk, tbox);
console.log(`Case A (conforming): ${a.length} issue(s)`);
for (const i of a) console.log(`  [${i.severity}] ${i.message} — ${i.where}`);

const b = await validateShacl(aboxBad, tbox);
console.log(`Case B (2 violations expected): ${b.length} issue(s)`);
for (const i of b) console.log(`  [${i.severity}] ${i.message} — ${i.where}`);

const ok = a.length === 0 && b.length === 2;
console.log(ok ? "\nSHACL CHECK OK" : "\nSHACL CHECK MISMATCH");
process.exit(ok ? 0 : 1);
