import { describe, it, expect } from "vitest";
import { parseTBox } from "../../src/lib/ontology/tboxParser.ts";
import { serializeTBoxStructured } from "../../src/lib/ontology/tboxSerializer.ts";
import { admitAxioms, axiomUnits, groundTerms, keepGrounded, knownNames } from "./inductionAxioms.ts";

const NS = "http://ex/i#";
const RAW = {
  classes: [
    { name: "Agent" },
    { name: "Person", parents: ["Agent"] },
    { name: "Organization", parents: ["Agent"] },
    { name: "Researcher", parents: ["Person"] },
    { name: "Lab", parents: ["Organization"] },
  ],
  objectProperties: [{ name: "worksAt", domain: ["Person"], range: ["Organization"] }],
  dataProperties: [{ name: "name", domain: ["Agent"], datatype: "string" }],
};
const known = knownNames(RAW, { classes: [], objectProps: [], dataProps: [] });

describe("grounding induced terms", () => {
  const docs = [{ text: "Every researcher works at a lab. The lab belongs to a university.", documentId: "d1" }];

  it("locates quotes in the source text", () => {
    const ev = groundTerms(
      [
        { name: "Researcher", quote: "Every researcher works at a lab.", kind: "class" },
        { name: "Unicorn", quote: "Unicorns fund the lab.", kind: "class" },
        { name: "Lab", kind: "class" },
      ],
      docs,
    );
    expect(ev.map((e) => [e.term, e.located, e.documentId])).toEqual([
      ["Researcher", true, "d1"],
      ["Unicorn", false, undefined],
      ["Lab", false, undefined],
    ]);
  });

  it("keeps grounded classes and the parents that hold them together", () => {
    const ev = groundTerms([{ name: "Researcher", quote: "Every researcher works at a lab.", kind: "class" }], docs);
    const { kept, dropped } = keepGrounded(RAW.classes, ev);
    expect(kept.map((c) => c.name)).toEqual(["Agent", "Person", "Researcher"]);
    expect(dropped).toEqual(["Organization", "Lab"]);
  });
});

describe("axiom proposals", () => {
  it("drops proposals that name unknown terms and turns the rest into units", () => {
    const units = axiomUnits(
      {
        disjointGroups: [{ classes: ["Person", "Organization", "Ghost"] }, { classes: ["Ghost", "Person"] }],
        restrictions: [
          { class: "Lab", property: "worksAt", kind: "some", value: "Person" },
          { class: "Researcher", property: "name", kind: "exactly", n: 1 },
          { class: "Nope", property: "worksAt", kind: "min", n: 1 },
        ],
        inverses: [{ property: "worksAt", inverseName: "employs" }],
        characteristics: [{ property: "worksAt", characteristic: "irreflexive" }, { property: "name", characteristic: "transitive" }],
      },
      known,
    );
    expect(units.map((u) => u.label)).toEqual(["disjoint: Person, Organization", "Lab ⊑ worksAt some Person", "Researcher ⊑ name exactly 1 xsd:string", "employs inverse of worksAt", "worksAt is irreflexive"]);
  });

  it("admits only axioms that keep every class satisfiable", () => {
    const turtle = serializeTBoxStructured(RAW, NS);
    const units = axiomUnits(
      {
        disjointGroups: [{ classes: ["Person", "Organization"] }, { classes: ["Researcher", "Agent"] }],
        restrictions: [],
        inverses: [{ property: "worksAt", inverseName: "employs" }],
        characteristics: [],
      },
      known,
    );
    const out = admitAxioms([], turtle, units, NS);
    expect(out.accepted).toEqual(["disjoint: Person, Organization", "employs inverse of worksAt"]);
    expect(out.rejected).toEqual([{ axiom: "disjoint: Researcher, Agent", reason: "would make Researcher unsatisfiable" }]);
    const m = parseTBox(out.turtle);
    expect(m.classes.find((c) => c.uri === NS + "Person")?.disjointWith).toEqual([NS + "Organization"]);
    expect(m.objectProps.find((p) => p.uri === NS + "employs")).toMatchObject({ inverseOf: NS + "worksAt", domain: [NS + "Organization"], range: [NS + "Person"] });
  });
});
