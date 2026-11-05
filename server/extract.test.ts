import { describe, it, expect } from "vitest";
import { Parser } from "n3";
import { applyEditOps, groupSuggestion, mergedGraphTurtle } from "./extract.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import type { ABoxResult } from "../src/types/abox.ts";

const NS = "http://ex/onto#";
const TTL = `
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Station a owl:Class ; rdfs:label "Station" .
:Component a owl:Class ; rdfs:label "Component" .
:Sensor a owl:Class ; rdfs:subClassOf :Component ; rdfs:label "Sensor" .
:partOf a owl:ObjectProperty ; rdfs:label "part of" ; rdfs:domain :Component ; rdfs:range :Station .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
`;
const tbox = parseTBox(TTL);

const current: ABoxResult = {
  individuals: [
    { id: "s1", classUri: NS + "Station", label: "Station 1" },
    { id: "c1", classUri: NS + "Component", label: "Comp 1", objectProperties: [{ propUri: NS + "partOf", targetId: "s1" }] },
    { id: "c2", classUri: NS + "Sensor", label: "Sensor 2" },
  ],
};

describe("applyEditOps", () => {
  it("preserves individuals the model did not mention", () => {
    const { abox } = applyEditOps(current, [{ op: "update", id: "c1", individual: { id: "c1", classUri: NS + "Component", label: "Renamed" } }], tbox);
    expect(abox.individuals).toHaveLength(3);
    expect(abox.individuals.find((i) => i.id === "c1")!.label).toBe("Renamed");
    expect(abox.individuals.find((i) => i.id === "c2")!.label).toBe("Sensor 2");
  });

  it("adds a new individual", () => {
    const { abox } = applyEditOps(current, [{ op: "add", individual: { id: "c3", classUri: NS + "Sensor", label: "New" } }], tbox);
    expect(abox.individuals).toHaveLength(4);
    expect(abox.individuals.at(-1)!.id).toBe("c3");
  });

  it("removes an individual and cleans up links pointing at it", () => {
    const { abox, notes } = applyEditOps(current, [{ op: "remove", id: "s1" }], tbox);
    expect(abox.individuals.map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(abox.individuals.find((i) => i.id === "c1")!.objectProperties).toBeUndefined();
    expect(notes.join(" ")).toMatch(/links? to deleted/);
  });

  it("reports a removal that names a non-existent individual", () => {
    const { abox, notes } = applyEditOps(current, [{ op: "remove", id: "ghost" }], tbox);
    expect(abox.individuals).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/no such individual/);
  });

  it("treats an update of a missing individual as an add, and says so", () => {
    const { abox, notes } = applyEditOps(current, [{ op: "update", id: "new1", individual: { id: "new1", classUri: NS + "Station" } }], tbox);
    expect(abox.individuals).toHaveLength(4);
    expect(notes.join(" ")).toMatch(/did not exist/);
  });

  it("rejects an operation that would introduce an unknown class", () => {
    const { abox, notes } = applyEditOps(current, [{ op: "add", individual: { id: "bad", classUri: "http://elsewhere#Nope" } }], tbox);
    expect(abox.individuals).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/not in the T-Box/);
  });

  it("ignores unknown operations rather than corrupting the A-Box", () => {
    const { abox, notes } = applyEditOps(current, [{ op: "explode" }, {}], tbox);
    expect(abox.individuals).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/unknown operation/);
  });

  it("applies no operations at all when the model returns none", () => {
    const { abox } = applyEditOps(current, [], tbox);
    expect(abox.individuals).toEqual(current.individuals);
  });
});

describe("mergedGraphTurtle", () => {
  const abox: ABoxResult = {
    individuals: [
      { id: "s1", classUri: NS + "Station", label: "Station 1" },
      { id: "sensor1", classUri: NS + "Sensor", label: "Sensor 1", objectProperties: [{ propUri: NS + "partOf", targetId: "s1" }] },
    ],
  };

  it("produces valid Turtle", () => {
    const ttl = mergedGraphTurtle({ tbox, abox, question: "" });
    expect(() => new Parser().parse(ttl)).not.toThrow();
  });

  it("includes T-Box labels and domain/range so schema questions are answerable", () => {
    const ttl = mergedGraphTurtle({ tbox, abox, question: "" });
    expect(ttl).toContain(`<${NS}Sensor>`);
    expect(ttl).toContain("rdf-schema#label");
    expect(ttl).toContain("rdf-schema#domain");
    expect(ttl).toContain("rdf-schema#range");
  });

  it("materialises subsumption so a subclass instance matches its superclass", () => {
    const ttl = mergedGraphTurtle({ tbox, abox, question: "" });
    const quads = new Parser().parse(ttl);
    const sensorIri = quads.find((q) => q.object.value === NS + "Sensor" && q.predicate.value.endsWith("#type"))!.subject.value;
    const types = quads.filter((q) => q.subject.value === sensorIri && q.predicate.value.endsWith("#type")).map((q) => q.object.value);
    expect(types).toContain(NS + "Sensor");
    expect(types).toContain(NS + "Component"); // materialised ancestor
  });
});

describe("groupSuggestion", () => {
  const moduleTtl = `@prefix : <${NS}> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n:Station a owl:Class .\n:Legacy a owl:Class .\n`;
  const modules = [{ name: "core.ttl", turtle: moduleTtl }];

  it("routes tagged additions into the module they extend", () => {
    const out = groupSuggestion([{ name: "Valve", module: "core.ttl" }], [], [], [], [], modules, NS);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("core.ttl");
    expect(out[0].isNew).toBe(false);
    expect(out[0].addedClasses).toEqual(["Valve"]);
    expect(out[0].turtle).toContain("Valve");
    expect(out[0].turtle).toContain("Station"); // existing terms preserved
  });

  it("puts untagged additions in a new-module bucket", () => {
    const out = groupSuggestion([{ name: "Valve" }], [], [], [], [], modules, NS);
    expect(out[0].isNew).toBe(true);
    expect(out[0].name).toBe("new-module.ttl");
  });

  it("applies removals and renames to the target module", () => {
    const out = groupSuggestion([], [], [], [{ term: "Legacy", module: "core.ttl" }], [{ from: "Station", to: "Cell", module: "core.ttl" }], modules, NS);
    expect(out[0].removed).toEqual(["Legacy"]);
    expect(out[0].renamed).toEqual([{ from: "Station", to: "Cell" }]);
    expect(out[0].turtle).toContain("Cell");
    expect(out[0].turtle).not.toContain("Legacy");
  });

  it("ignores edits aimed at a module that is not loaded", () => {
    const out = groupSuggestion([], [], [], [{ term: "Legacy", module: "absent.ttl" }], [], modules, NS);
    expect(out).toHaveLength(0);
  });

  it("emits nothing when there is nothing to suggest", () => {
    expect(groupSuggestion([], [], [], [], [], modules, NS)).toEqual([]);
  });
});
