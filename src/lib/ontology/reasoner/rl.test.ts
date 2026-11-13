import { describe, it, expect } from "vitest";
import { parseTBox } from "../tboxParser";
import type { ABoxResult } from "../../../types/abox";
import { reasonModules, entailmentDiff } from "./index";

const NS = "http://ex/onto#";
const C = (n: string) => NS + n;

const PREAMBLE = `
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
const mod = (body: string, name = "core.ttl") => ({ name, turtle: PREAMBLE + body });

const ind = (id: string, cls: string, extra: Partial<ABoxResult["individuals"][number]> = {}) => ({ id, classUri: C(cls), ...extra });

describe("parser additions used by the reasoner", () => {
  it("reads equivalences, property characteristics and property disjointness", () => {
    const m = parseTBox(
      PREAMBLE +
        `
      :Person a owl:Class ; owl:equivalentClass :Human .
      :Human a owl:Class .
      :partOf a owl:ObjectProperty, owl:TransitiveProperty ; owl:propertyDisjointWith :hasPart .
      :hasPart a owl:ObjectProperty ; owl:equivalentProperty :contains .
      :knows a owl:SymmetricProperty .
    `,
    );
    expect(m.classes.find((c) => c.uri === C("Person"))?.equivalentTo).toEqual([C("Human")]);
    expect(m.objectProps.find((p) => p.uri === C("partOf"))?.characteristics).toEqual(["transitive"]);
    expect(m.objectProps.find((p) => p.uri === C("partOf"))?.disjointWith).toEqual([C("hasPart")]);
    expect(m.objectProps.find((p) => p.uri === C("hasPart"))?.equivalentTo).toEqual([C("contains")]);
    // declared only as symmetric → still an object property
    expect(m.objectProps.find((p) => p.uri === C("knows"))?.characteristics).toEqual(["symmetric"]);
  });
});

describe("reasonRL — T-Box", () => {
  it("finds a class under two disjoint parents and explains it with the asserted axioms", () => {
    const s = reasonModules([
      mod(`
        :Person a owl:Class ; owl:disjointWith :Organization .
        :Organization a owl:Class .
        :University rdfs:subClassOf :Organization .
        :Researcher rdfs:subClassOf :Person .
        :WeirdThing rdfs:subClassOf :Researcher, :University .
      `),
    ]);
    const u = s.report.unsatisfiable.map((x) => x.cls);
    expect(u).toEqual([C("WeirdThing")]);
    const kinds = s.report.unsatisfiable[0].explanation.map((a) => {
      const names = a.args.map((x) => x.split("#")[1]);
      return `${a.kind}:${(a.kind === "disjointWith" ? names.sort() : names).join(",")}`;
    });
    expect(kinds).toEqual(expect.arrayContaining(["subClassOf:WeirdThing,Researcher", "subClassOf:Researcher,Person", "disjointWith:Organization,Person"]));
    expect(s.report.unsatisfiable[0].explanation.every((a) => a.module === "core.ttl")).toBe(true);
    expect(s.report.consistent).toBe(true); // an unsatisfiable class alone is not an inconsistency
  });

  it("propagates unsatisfiability to subclasses and through existential fillers", () => {
    const s = reasonModules([
      mod(`
        :A owl:disjointWith :B .
        :Bad rdfs:subClassOf :A, :B .
        :Child rdfs:subClassOf :Bad .
        :p a owl:ObjectProperty .
        :NeedsBad rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :Bad ] .
      `),
    ]);
    expect(s.report.unsatisfiable.map((x) => x.cls).sort()).toEqual([C("Bad"), C("Child"), C("NeedsBad")]);
  });

  it("catches a someValuesFrom filler that clashes with the property range, and min > max", () => {
    const s = reasonModules([
      mod(`
        :Person owl:disjointWith :Building .
        :worksIn a owl:ObjectProperty ; rdfs:range :Building .
        :Odd rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :worksIn ; owl:someValuesFrom :Person ] .
        :hasPI a owl:ObjectProperty .
        :Project rdfs:subClassOf
          [ a owl:Restriction ; owl:onProperty :hasPI ; owl:minCardinality "2"^^xsd:nonNegativeInteger ] ,
          [ a owl:Restriction ; owl:onProperty :hasPI ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
      `),
    ]);
    const byCls = Object.fromEntries(s.report.unsatisfiable.map((u) => [u.cls.split("#")[1], u.reason]));
    expect(byCls.Odd).toMatch(/range of worksIn/);
    expect(byCls.Project).toMatch(/at least 2 .* at most 1/);
  });

  it("closes subsumption over equivalences and lists inferred pairs", () => {
    const s = reasonModules([mod(`:A rdfs:subClassOf :B . :B owl:equivalentClass :C . :C rdfs:subClassOf :D .`)]);
    const pairs = s.report.subsumptions.map((e) => e.args.map((x) => x.split("#")[1]).join("<"));
    expect(pairs).toEqual(expect.arrayContaining(["A<B", "A<C", "A<D", "B<C", "C<B", "B<D"]));
    expect(s.explainSubsumption(C("A"), C("D")).map((a) => a.kind)).toEqual(["subClassOf", "equivalentClass", "subClassOf"]);
  });
});

describe("reasonRL — A-Box", () => {
  const tbox = mod(`
    :Person a owl:Class ; owl:disjointWith :Organization .
    :Organization a owl:Class .
    :University rdfs:subClassOf :Organization .
    :worksAt a owl:ObjectProperty ; rdfs:domain :Person ; rdfs:range :Organization .
    :employs a owl:ObjectProperty ; owl:inverseOf :worksAt .
    :partOf a owl:ObjectProperty, owl:TransitiveProperty .
    :hasSupervisor a owl:ObjectProperty, owl:FunctionalProperty .
    :ssn a owl:DatatypeProperty, owl:FunctionalProperty .
  `);

  it("finds a disjointness clash that only exists through an inferred range type", () => {
    // oxford is asserted a Person, and becomes an Organization through range(worksAt)
    const s = reasonModules([tbox], {
      abox: { individuals: [ind("sarah", "Person", { objectProperties: [{ propUri: C("worksAt"), targetId: "oxford" }] }), ind("oxford", "Person")] },
    });
    expect(s.report.consistent).toBe(false);
    const c = s.report.clashes.find((x) => x.code === "disjoint-types")!;
    expect(c.subjects).toEqual(["oxford"]);
    const kinds = c.explanation.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["link", "range", "type", "disjointWith"]));
    expect(c.explanation.find((a) => a.kind === "link")?.individualId).toBe("sarah");
  });

  it("derives inverse and transitive links and inferred types", () => {
    const s = reasonModules([tbox], {
      abox: {
        individuals: [
          ind("sarah", "Person", { objectProperties: [{ propUri: C("worksAt"), targetId: "oxford" }] }),
          ind("oxford", "University"),
          ind("lab", "Organization", { objectProperties: [{ propUri: C("partOf"), targetId: "dept" }] }),
          ind("dept", "Organization", { objectProperties: [{ propUri: C("partOf"), targetId: "oxford" }] }),
        ],
      },
    });
    expect(s.report.consistent).toBe(true);
    const links = s.report.inferredLinks.map((e) => `${e.args[0]} ${e.args[1].split("#")[1]} ${e.args[2]}`);
    expect(links).toEqual(expect.arrayContaining(["oxford employs sarah", "lab partOf oxford"]));
    expect(s.report.inferredTypes.oxford).toEqual([C("Organization")]);
    expect(s.explainType("oxford", C("Organization")).map((a) => a.kind)).toEqual(["type", "subClassOf"]);
  });

  it("reports a functional clash under UNA and a sameAs suggestion without it", () => {
    const abox: ABoxResult = {
      individuals: [
        ind("ann", "Person", {
          objectProperties: [
            { propUri: C("hasSupervisor"), targetId: "bob" },
            { propUri: C("hasSupervisor"), targetId: "robert" },
          ],
        }),
        ind("bob", "Person"),
        ind("robert", "Person"),
      ],
    };
    const withUna = reasonModules([tbox], { abox });
    expect(withUna.report.clashes.map((c) => c.code)).toEqual(["functional-clash"]);
    const without = reasonModules([tbox], { abox, una: false });
    expect(without.report.consistent).toBe(true);
    expect(without.report.sameAs).toContainEqual(["bob", "robert"]);
  });

  it("treats different literal values of a functional data property as a clash, but not 1 vs 1.0", () => {
    const s = reasonModules([tbox], {
      abox: {
        individuals: [
          ind("ann", "Person", { dataProperties: [{ propUri: C("ssn"), value: "1" }, { propUri: C("ssn"), value: "1.0" }] }),
          ind("bea", "Person", { dataProperties: [{ propUri: C("ssn"), value: "1" }, { propUri: C("ssn"), value: "2" }] }),
        ],
      },
    });
    expect(s.report.clashes.map((c) => c.subjects[0])).toEqual(["bea"]);
  });

  it("merges individuals sharing an external sameAs and flags a differentFrom between them", () => {
    const s = reasonModules([tbox], {
      abox: {
        individuals: [
          ind("ox1", "University", { sameAs: ["http://www.wikidata.org/entity/Q34433"], differentFrom: ["ox2"] }),
          ind("ox2", "University", { sameAs: ["http://www.wikidata.org/entity/Q34433"] }),
        ],
      },
    });
    expect(s.report.sameAs).toContainEqual(["ox1", "ox2"]);
    expect(s.report.clashes.map((c) => c.code)).toEqual(["different-same"]);
  });

  it("flags members of an unsatisfiable class and too many values for a max cardinality", () => {
    const s = reasonModules(
      [
        tbox,
        mod(
          `
        :Chimera rdfs:subClassOf :Person, :Organization .
        :Project rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLead ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
        :hasLead a owl:ObjectProperty .
      `,
          "extra.ttl",
        ),
      ],
      {
        abox: {
          individuals: [
            ind("x", "Chimera"),
            ind("p1", "Project", {
              objectProperties: [
                { propUri: C("hasLead"), targetId: "ann" },
                { propUri: C("hasLead"), targetId: "bob" },
              ],
            }),
            ind("ann", "Person"),
            ind("bob", "Person"),
          ],
        },
      },
    );
    const codes = s.report.clashes.map((c) => c.code).sort();
    expect(codes).toContain("unsat-type");
    expect(codes).toContain("max-card");
    expect(s.report.clashes.find((c) => c.code === "unsat-type")?.explanation.some((a) => a.module === "extra.ttl")).toBe(true);
  });

  it("stops at the fact cap and says so", () => {
    const individuals = Array.from({ length: 40 }, (_, i) => ind(`n${i}`, "Organization", { objectProperties: i < 39 ? [{ propUri: C("partOf"), targetId: `n${i + 1}` }] : [] }));
    const s = reasonModules([tbox], { abox: { individuals }, maxFacts: 100 });
    expect(s.report.incomplete.some((m) => /Stopped after 100/.test(m))).toBe(true);
  });
});

describe("entailmentDiff", () => {
  it("separates intended additions from changes between existing terms", () => {
    const base = mod(`:Person a owl:Class . :Organization a owl:Class . :Employee rdfs:subClassOf :Person .`);
    const before = reasonModules([base]);
    const change = mod(`:Researcher rdfs:subClassOf :Employee . :Person rdfs:subClassOf :Organization .`, "change.ttl");
    const after = reasonModules([base, change]);
    const baseTerms = new Set([C("Person"), C("Organization"), C("Employee")]);
    const d = entailmentDiff(before.report, after.report, baseTerms, after.explainSubsumption);
    const show = (xs: { args: string[] }[]) => xs.map((e) => e.args.map((x) => x.split("#")[1]).join("<")).sort();
    expect(show(d.added)).toEqual(["Employee<Organization", "Person<Organization", "Researcher<Employee", "Researcher<Organization", "Researcher<Person"]);
    expect(show(d.unintended)).toEqual(["Employee<Organization", "Person<Organization"]);
    expect(d.unintended.find((e) => e.args[0] === C("Employee"))?.explanation?.map((a) => a.module)).toEqual(["core.ttl", "change.ttl"]);
  });

  it("reports classes that became unsatisfiable", () => {
    const base = mod(`:A owl:disjointWith :B . :C rdfs:subClassOf :A .`);
    const after = reasonModules([base, mod(`:C rdfs:subClassOf :B .`, "x.ttl")]);
    const d = entailmentDiff(reasonModules([base]).report, after.report, new Set([C("A"), C("B"), C("C")]));
    expect(d.newlyUnsat).toEqual([C("C")]);
  });
});

describe("OWL unions in reasoning", () => {
  const classes = `:A a owl:Class ; owl:disjointWith :B . :B a owl:Class .
    :Allowed rdfs:subClassOf :A . :Value a owl:Class .`;

  it("does not turn a union domain into two mandatory domains", () => {
    const s = reasonModules([mod(classes + `
      :p a owl:ObjectProperty ; rdfs:domain [ owl:unionOf (:A :B) ] .
      :Allowed rdfs:subClassOf [ owl:onProperty :p ; owl:someValuesFrom :Value ] .
    `)], { abox: { individuals: [ind("a", "Allowed", { objectProperties: [{ propUri: C("p"), targetId: "v" }] }), ind("v", "Value")] } });
    expect(s.report.unsatisfiable).toEqual([]);
    expect(s.report.clashes).toEqual([]);
    expect(s.report.inferredTypes.a ?? []).not.toContain(C("B"));
    expect(s.report.incomplete.join(" ")).toContain("Anonymous domain/range");
  });

  it("does not turn a union range into two mandatory ranges", () => {
    const s = reasonModules([mod(classes + `
      :p a owl:ObjectProperty ; rdfs:range [ owl:unionOf (:B :A) ] .
      :Value rdfs:subClassOf [ owl:onProperty :p ; owl:someValuesFrom :Allowed ] .
    `)], { abox: { individuals: [ind("v", "Value", { objectProperties: [{ propUri: C("p"), targetId: "a" }] }), ind("a", "Allowed")] } });
    expect(s.report.unsatisfiable).toEqual([]);
    expect(s.report.clashes).toEqual([]);
  });

  it("keeps genuine conflicts from separate named domain and range axioms", () => {
    for (const field of ["domain", "range"]) {
      const s = reasonModules([mod(classes + `
        :p a owl:ObjectProperty ; rdfs:${field} :A, :B .
        :Allowed rdfs:subClassOf [ owl:onProperty :p ; owl:someValuesFrom :A ] .
      `)]);
      expect(s.report.unsatisfiable.map((u) => u.cls)).toContain(C("Allowed"));
    }
  });

  it("retains named constraints alongside a union and follows subproperties across modules", () => {
    const s = reasonModules([
      mod(classes + `:p a owl:ObjectProperty ; rdfs:domain [ owl:unionOf (:A :B) ], :B .`, "base.ttl"),
      mod(`:q a owl:ObjectProperty ; rdfs:subPropertyOf :p .
        :Allowed rdfs:subClassOf [ owl:onProperty :q ; owl:someValuesFrom :Value ] .`, "child.ttl"),
    ]);
    const issue = s.report.unsatisfiable.find((u) => u.cls === C("Allowed"));
    expect(issue).toBeDefined();
    expect(issue!.explanation).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "domain", args: [C("p"), C("B")], module: "base.ttl" }),
      expect.objectContaining({ kind: "subPropertyOf", args: [C("q"), C("p")], module: "child.ttl" }),
    ]));
  });

  it("does not pick the first union member as an existential or universal filler", () => {
    const s = reasonModules([mod(classes + `
      :p a owl:ObjectProperty ; rdfs:range :A .
      :Value rdfs:subClassOf
        [ owl:onProperty :p ; owl:someValuesFrom [ owl:unionOf (:B :A) ] ],
        [ owl:onProperty :p ; owl:someValuesFrom :A ],
        [ owl:onProperty :p ; owl:allValuesFrom [ owl:unionOf (:B :A) ] ] .
    `)]);
    expect(s.report.unsatisfiable).toEqual([]);
  });

  it("does not turn an unsupported qualified maximum into an unqualified maximum", () => {
    const s = reasonModules([mod(classes + `
      :p a owl:ObjectProperty .
      :Value rdfs:subClassOf
        [ owl:onProperty :p ; owl:minCardinality 1 ],
        [ owl:onProperty :p ; owl:maxQualifiedCardinality 0 ; owl:onClass [ owl:unionOf (:A :B) ] ] .
    `)]);
    expect(s.report.unsatisfiable).toEqual([]);
  });
});
