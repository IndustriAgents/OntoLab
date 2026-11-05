import { describe, it, expect } from "vitest";
import {
  XSD,
  RDF_LANGSTRING,
  RDFS_LITERAL,
  XSD_STRING,
  localName,
  namespaceOf,
  isStandardTerm,
  defaultAboxNamespace,
  normalizeDatatype,
  xsdUri,
  isXsdDatatype,
  checkLexicalForm,
} from "./iri";

describe("localName / namespaceOf", () => {
  it("splits on the last # or /", () => {
    expect(localName("http://ex/onto#Sensor")).toBe("Sensor");
    expect(localName("http://ex/onto/Sensor")).toBe("Sensor");
    expect(localName("http://ex/onto/v1#a/b")).toBe("b");
    expect(namespaceOf("http://ex/onto#Sensor")).toBe("http://ex/onto#");
    expect(namespaceOf("http://ex/onto/Sensor")).toBe("http://ex/onto/");
  });

  it("prefers # over a later /", () => {
    // A hash always wins, even when a slash appears after it.
    expect(namespaceOf("http://ex/onto#a/b")).toBe("http://ex/onto#");
  });

  it("returns the input when there is no separator", () => {
    expect(localName("Sensor")).toBe("Sensor");
    expect(namespaceOf("Sensor")).toBe("Sensor");
  });
});

describe("isStandardTerm", () => {
  it("recognises the standard vocabularies and nothing else", () => {
    expect(isStandardTerm(XSD + "decimal")).toBe(true);
    expect(isStandardTerm("http://www.w3.org/2000/01/rdf-schema#label")).toBe(true);
    expect(isStandardTerm("http://www.w3.org/2002/07/owl#Thing")).toBe(true);
    expect(isStandardTerm("http://purl.org/dc/terms/source")).toBe(true);
    expect(isStandardTerm("http://ex/onto#Sensor")).toBe(false);
  });
});

describe("defaultAboxNamespace", () => {
  it("derives a SEPARATE namespace so individuals never collide with T-Box terms", () => {
    expect(defaultAboxNamespace("http://ex/onto#")).toBe("http://ex/onto/abox#");
    expect(defaultAboxNamespace("http://ex/onto/")).toBe("http://ex/onto/abox#");
    expect(defaultAboxNamespace("http://ex/onto")).toBe("http://ex/onto/abox#");
  });

  it("falls back when the T-Box namespace is unknown", () => {
    expect(defaultAboxNamespace("")).toBe("http://ontolab.example/abox#");
    expect(defaultAboxNamespace("###")).toBe("http://ontolab.example/abox#");
  });
});

describe("normalizeDatatype", () => {
  it("keeps full XSD IRIs and canonicalises their casing", () => {
    expect(normalizeDatatype(XSD + "decimal")).toBe(XSD + "decimal");
    expect(normalizeDatatype(XSD + "datetime")).toBe(XSD + "dateTime");
  });

  it("accepts CURIEs", () => {
    expect(normalizeDatatype("xsd:decimal")).toBe(XSD + "decimal");
    expect(normalizeDatatype("xs:dateTime")).toBe(XSD + "dateTime");
  });

  it("accepts bare names, case-insensitively", () => {
    expect(normalizeDatatype("decimal")).toBe(XSD + "decimal");
    expect(normalizeDatatype("DECIMAL")).toBe(XSD + "decimal");
    expect(normalizeDatatype("  DateTime  ")).toBe(XSD + "dateTime");
    expect(normalizeDatatype("nonnegativeinteger")).toBe(XSD + "nonNegativeInteger");
  });

  it("resolves the LLM/spreadsheet aliases", () => {
    expect(normalizeDatatype("number")).toBe(XSD + "decimal");
    expect(normalizeDatatype("numeric")).toBe(XSD + "decimal");
    expect(normalizeDatatype("text")).toBe(XSD_STRING);
    expect(normalizeDatatype("datetime")).toBe(XSD + "dateTime");
    expect(normalizeDatatype("bool")).toBe(XSD + "boolean");
    expect(normalizeDatatype("url")).toBe(XSD + "anyURI");
  });

  it("keeps rdf:langString / rdfs:Literal and custom datatype IRIs verbatim", () => {
    expect(normalizeDatatype(RDF_LANGSTRING)).toBe(RDF_LANGSTRING);
    expect(normalizeDatatype(RDFS_LITERAL)).toBe(RDFS_LITERAL);
    expect(normalizeDatatype("http://ex/dt#Kelvin")).toBe("http://ex/dt#Kelvin");
    expect(normalizeDatatype("urn:dt:kelvin")).toBe("urn:dt:kelvin");
  });

  it("returns undefined for nonsense and empty hints", () => {
    expect(normalizeDatatype("banana")).toBeUndefined();
    expect(normalizeDatatype("xsd:banana")).toBeUndefined();
    expect(normalizeDatatype("")).toBeUndefined();
    expect(normalizeDatatype("   ")).toBeUndefined();
    expect(normalizeDatatype(undefined)).toBeUndefined();
    expect(normalizeDatatype(null)).toBeUndefined();
  });
});

describe("xsdUri", () => {
  it("never fails — unknown hints become xsd:string", () => {
    expect(xsdUri("text")).toBe(XSD_STRING);
    expect(xsdUri("banana")).toBe(XSD_STRING);
    expect(xsdUri(undefined)).toBe(XSD_STRING);
    expect(xsdUri("integer")).toBe(XSD + "integer");
  });
});

describe("isXsdDatatype", () => {
  it("covers the XSD namespace plus the two RDF literal types", () => {
    expect(isXsdDatatype(XSD + "date")).toBe(true);
    expect(isXsdDatatype(RDF_LANGSTRING)).toBe(true);
    expect(isXsdDatatype(RDFS_LITERAL)).toBe(true);
    expect(isXsdDatatype("http://ex/onto#Sensor")).toBe(false);
  });
});

describe("checkLexicalForm", () => {
  const ok = (v: string, dt: string) => expect(checkLexicalForm(v, XSD + dt)).toBeNull();
  const bad = (v: string, dt: string) => expect(checkLexicalForm(v, XSD + dt)).toBeTypeOf("string");

  it("accepts well-formed values", () => {
    ok("-42", "integer");
    ok("+7", "integer");
    ok("3.14", "decimal");
    ok(".5", "decimal");
    ok("12", "decimal");
    ok("true", "boolean");
    ok("0", "boolean");
    ok("2024-01-31", "date");
    ok("2024-01-31Z", "date");
    ok("2024-01-31T08:30:00", "dateTime");
    ok("2024-01-31T08:30:00.5+02:00", "dateTime");
    ok("PT2.5S", "duration");
    ok("-P1Y2M3DT4H", "duration");
    ok("1e3", "double");
    ok("INF", "float");
  });

  it("rejects ill-formed values", () => {
    bad("4.5", "integer");
    bad("twelve", "decimal");
    bad("1e3", "decimal"); // exponent is not decimal lexical space
    bad("yes", "boolean");
    bad("31/01/2024", "date");
    bad("2024-01-31", "dateTime"); // missing time part
    bad("2.5s", "duration");
    bad("P", "duration"); // empty duration
  });

  it("enforces the signed-integer bounds", () => {
    ok("0", "nonNegativeInteger");
    bad("-1", "nonNegativeInteger");
    ok("1", "positiveInteger");
    bad("0", "positiveInteger");
    bad("-3", "positiveInteger");
    ok("0", "nonPositiveInteger");
    bad("1", "nonPositiveInteger");
    bad("0", "negativeInteger");
    ok("-1", "negativeInteger");
    bad("-1", "unsignedInt");
  });

  it("ignores surrounding whitespace but not internal junk", () => {
    ok("  42  ", "integer");
    bad("4 2", "integer");
  });

  it("returns null for datatypes it does not check", () => {
    expect(checkLexicalForm("anything", XSD_STRING)).toBeNull();
    expect(checkLexicalForm("anything", "http://ex/dt#Kelvin")).toBeNull();
    expect(checkLexicalForm("anything", XSD + "anyURI")).toBeNull();
  });
});
