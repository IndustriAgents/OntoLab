import { describe, it, expect } from "vitest";
import { datatypeEnum, buildExtractSchema, buildEditSchema, toStrictSchema, toGeminiSchema } from "./schemas.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { normalizeDatatype } from "../src/lib/ontology/iri.ts";

const NS = "http://ex/onto#";
const tbox = parseTBox(`
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Station a owl:Class .
:Component a owl:Class .
:partOf a owl:ObjectProperty ; rdfs:domain :Component ; rdfs:range :Station .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
:since a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:date .
`);

describe("datatypeEnum", () => {
  const values = datatypeEnum(tbox);

  it("offers short names, not full IRIs", () => {
    // Full IRIs are ~15-25 tokens each and repeat per property; that bulk made
    // Gemini return MALFORMED_FUNCTION_CALL on larger A-Boxes.
    expect(values).toContain("decimal");
    expect(values).toContain("date");
    expect(values.some((v) => v.startsWith("http"))).toBe(false);
  });

  it("includes every datatype the T-Box declares plus common ones", () => {
    expect(values).toEqual(expect.arrayContaining(["decimal", "date", "string", "integer", "boolean"]));
  });

  it("round-trips every offered value back to a real datatype IRI", () => {
    for (const v of values) {
      const iri = normalizeDatatype(v);
      expect(iri, `"${v}" must normalise to an IRI`).toBeDefined();
      expect(iri!.startsWith("http")).toBe(true);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("buildExtractSchema", () => {
  it("requires explicit assertion arrays for evidence extraction without requiring invented values", () => {
    const item = (buildExtractSchema(tbox, false, { requireEvidence: true }) as any).properties.individuals.items;
    expect(item.required).toEqual(expect.arrayContaining(["sourceEvidence", "dataProperties", "objectProperties"]));
    expect(item.properties.dataProperties.minItems).toBeUndefined();
    expect(item.properties.dataProperties.items.required).toContain("quote");
    const bare = parseTBox(`@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . :Thing a owl:Class .`);
    const bareItem = (buildExtractSchema(bare, false, { requireEvidence: true }) as any).properties.individuals.items;
    expect(bareItem.required).toEqual(["id", "classUri", "sourceEvidence"]);
  });
  it("constrains classUri and property URIs to the T-Box", () => {
    const schema = buildExtractSchema(tbox, false) as any;
    const props = schema.properties.individuals.items.properties;
    expect(props.classUri.enum).toEqual([NS + "Component", NS + "Station"]);
    expect(props.dataProperties.items.properties.propUri.enum).toEqual([NS + "pressure", NS + "since"]);
    expect(props.objectProperties.items.properties.propUri.enum).toEqual([NS + "partOf"]);
  });

  it("adds questions only in interactive mode", () => {
    expect((buildExtractSchema(tbox, false) as any).properties.questions).toBeUndefined();
    expect((buildExtractSchema(tbox, true) as any).properties.questions).toBeDefined();
  });

  it("omits property blocks a T-Box does not declare", () => {
    const bare = parseTBox(`@prefix : <${NS}> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n:Thing a owl:Class .`);
    const props = (buildExtractSchema(bare, false) as any).properties.individuals.items.properties;
    expect(props.dataProperties).toBeUndefined();
    expect(props.objectProperties).toBeUndefined();
  });
});

describe("buildEditSchema", () => {
  it("describes patch operations rather than a full re-emission", () => {
    const schema = buildEditSchema(tbox) as any;
    expect(schema.properties.operations.items.properties.op.enum).toEqual(["add", "update", "remove"]);
    expect(schema.required).toEqual(["operations", "summary"]);
  });
});

describe("toStrictSchema", () => {
  it("marks every property required and makes optional ones nullable", () => {
    const strict = toStrictSchema(buildExtractSchema(tbox, false)) as any;
    const item = strict.properties.individuals.items;
    expect(item.required).toEqual(expect.arrayContaining(["id", "classUri", "label", "sourceEvidence"]));
    // `label` is optional, so strict mode requires it be nullable
    expect(item.properties.label.type).toEqual(["string", "null"]);
    // `id` is genuinely required and stays a plain string
    expect(item.properties.id.type).toBe("string");
    expect(item.additionalProperties).toBe(false);
  });
});

describe("toGeminiSchema", () => {
  it("uppercases types and strips additionalProperties", () => {
    const gem = toGeminiSchema(buildExtractSchema(tbox, false)) as any;
    expect(gem.type).toBe("OBJECT");
    expect(gem.properties.individuals.type).toBe("ARRAY");
    expect(gem.additionalProperties).toBeUndefined();
    expect(gem.properties.individuals.items.additionalProperties).toBeUndefined();
    // enums survive the conversion — they are what constrains the vocabulary
    expect(gem.properties.individuals.items.properties.classUri.enum).toContain(NS + "Station");
  });
});
