// Ontologies that name terms with SKOS and opaque IRIs (EMMO, QUDT) must still have
// readable labels: otherwise matching, retrieval and prompts see only UUIDs.

import { describe, expect, it } from "vitest";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

const TTL = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix emmo: <https://w3id.org/emmo#> .
emmo:EMMO_31ec09ba a owl:Class ; skos:prefLabel "Fracture Toughness"@en, "Bruchzähigkeit"@de ; skos:definition "Resistance of a material to crack growth."@en .
emmo:EMMO_b51fbd00 a owl:Class ; rdfs:label "Hardness" ; skos:prefLabel "HardnessPref"@en ; rdfs:comment "Resistance to indentation." ; skos:definition "unused" .
emmo:EMMO_06448f64 a owl:ObjectProperty ; skos:prefLabel "hasProperty"@en .
emmo:EMMO_aaaa a owl:Class .`;

describe("parseTBox with SKOS labels", () => {
  const m = parseTBox(TTL);
  const cls = (id: string) => m.classes.find((c) => c.uri.endsWith(id));

  it("uses skos:prefLabel (English first) and skos:definition when rdfs terms are absent", () => {
    expect(cls("EMMO_31ec09ba")).toMatchObject({ label: "Fracture Toughness", comment: "Resistance of a material to crack growth." });
    expect(m.objectProps.find((p) => p.uri.endsWith("EMMO_06448f64"))?.label).toBe("hasProperty");
  });

  it("keeps rdfs:label and rdfs:comment as the first choice", () => {
    expect(cls("EMMO_b51fbd00")).toMatchObject({ label: "Hardness", comment: "Resistance to indentation." });
  });

  it("leaves terms without any label unlabelled", () => {
    expect(cls("EMMO_aaaa")?.label).toBeUndefined();
  });
});
