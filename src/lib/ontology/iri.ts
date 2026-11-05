// Shared IRI / datatype helpers for the ontology core. Every module that needs a
// local name, a namespace, or an XSD datatype goes through here so the rules are
// defined exactly once.

export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
export const OWL = "http://www.w3.org/2002/07/owl#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const SH = "http://www.w3.org/ns/shacl#";
export const DCTERMS = "http://purl.org/dc/terms/";
export const PROV = "http://www.w3.org/ns/prov#";
export const SKOS = "http://www.w3.org/2004/02/skos/core#";

export const RDF_TYPE = RDF + "type";
export const RDF_LANGSTRING = RDF + "langString";
export const RDFS_LABEL = RDFS + "label";
export const RDFS_COMMENT = RDFS + "comment";
export const RDFS_LITERAL = RDFS + "Literal";
export const OWL_NAMED_INDIVIDUAL = OWL + "NamedIndividual";
export const XSD_STRING = XSD + "string";

/** Standard vocabulary namespaces: never treated as user-declared terms. */
export const STD_NAMESPACES: ReadonlySet<string> = new Set([RDF, RDFS, OWL, XSD, SH, DCTERMS, PROV, SKOS]);

/** Local name — everything after the last `#` or `/`. */
export function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

/** Namespace — everything up to and including the last `#` or `/`. */
export function namespaceOf(iri: string): string {
  const hash = iri.lastIndexOf("#");
  if (hash >= 0) return iri.slice(0, hash + 1);
  const slash = iri.lastIndexOf("/");
  return slash >= 0 ? iri.slice(0, slash + 1) : iri;
}

export function isStandardTerm(iri: string): boolean {
  return STD_NAMESPACES.has(namespaceOf(iri));
}

/**
 * Default namespace for A-Box individuals, derived from the T-Box namespace so
 * individuals never share IRIs with T-Box terms:
 *   http://ex/onto#  →  http://ex/onto/abox#
 *   http://ex/onto/  →  http://ex/onto/abox#
 */
export function defaultAboxNamespace(tboxNamespace: string): string {
  const root = (tboxNamespace ?? "").replace(/[#/]+$/, "");
  return root ? `${root}/abox#` : "http://ontolab.example/abox#";
}

/* ───────────────────────── XSD datatypes ───────────────────────── */

const XSD_NAMES = [
  "string",
  "boolean",
  "decimal",
  "integer",
  "int",
  "long",
  "short",
  "byte",
  "nonNegativeInteger",
  "positiveInteger",
  "nonPositiveInteger",
  "negativeInteger",
  "unsignedLong",
  "unsignedInt",
  "unsignedShort",
  "unsignedByte",
  "float",
  "double",
  "date",
  "dateTime",
  "dateTimeStamp",
  "time",
  "duration",
  "dayTimeDuration",
  "yearMonthDuration",
  "gYear",
  "gYearMonth",
  "gMonth",
  "gDay",
  "gMonthDay",
  "anyURI",
  "hexBinary",
  "base64Binary",
  "language",
  "normalizedString",
  "token",
  "Name",
  "NCName",
] as const;

const XSD_BY_LOWER = new Map<string, string>(XSD_NAMES.map((n) => [n.toLowerCase(), XSD + n]));

/** Common LLM / spreadsheet spellings that are not XSD names. */
const DATATYPE_ALIASES: Record<string, string> = {
  number: "decimal",
  numeric: "decimal",
  num: "decimal",
  real: "double",
  text: "string",
  str: "string",
  bool: "boolean",
  datetime: "dateTime",
  timestamp: "dateTime",
  uri: "anyURI",
  url: "anyURI",
  iri: "anyURI",
};

/** The XSD datatypes the LLM is offered (enum) when the T-Box declares none. */
export const COMMON_DATATYPES: readonly string[] = [
  "string",
  "decimal",
  "integer",
  "boolean",
  "double",
  "date",
  "dateTime",
  "time",
  "duration",
  "anyURI",
].map((n) => XSD + n);

/**
 * Normalise a datatype hint to a datatype IRI. Accepts full IRIs, CURIEs
 * (`xsd:decimal`), bare names (`decimal`, case-insensitive) and a few aliases
 * (`number`, `text`). Custom (non-XSD) datatype IRIs are kept verbatim.
 * Returns undefined when the hint cannot be understood.
 */
export function normalizeDatatype(dt?: string | null): string | undefined {
  if (!dt) return undefined;
  const s = dt.trim();
  if (!s) return undefined;
  if (s === RDF_LANGSTRING || s === RDFS_LITERAL) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("urn:")) {
    if (s.startsWith(XSD)) return XSD_BY_LOWER.get(localName(s).toLowerCase()) ?? s;
    return s;
  }
  const local = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s.includes("#") ? localName(s) : s;
  const key = local.trim().toLowerCase();
  const hit = XSD_BY_LOWER.get(key);
  if (hit) return hit;
  const alias = DATATYPE_ALIASES[key];
  return alias ? XSD + alias : undefined;
}

/** Like normalizeDatatype but never fails — unknown hints default to xsd:string. */
export function xsdUri(dt?: string | null): string {
  return normalizeDatatype(dt) ?? XSD_STRING;
}

export function isXsdDatatype(iri: string): boolean {
  return iri.startsWith(XSD) || iri === RDF_LANGSTRING || iri === RDFS_LITERAL;
}

const INTEGER_TYPES = new Set(
  [
    "integer",
    "int",
    "long",
    "short",
    "byte",
    "nonNegativeInteger",
    "positiveInteger",
    "nonPositiveInteger",
    "negativeInteger",
    "unsignedLong",
    "unsignedInt",
    "unsignedShort",
    "unsignedByte",
  ].map((n) => XSD + n),
);

export const NUMERIC_DATATYPES: ReadonlySet<string> = new Set([
  ...INTEGER_TYPES,
  XSD + "decimal",
  XSD + "float",
  XSD + "double",
]);

const RE = {
  integer: /^[+-]?\d+$/,
  decimal: /^[+-]?(\d+(\.\d*)?|\.\d+)$/,
  floating: /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/,
  boolean: /^(true|false|0|1)$/,
  date: /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/,
  dateTime: /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  time: /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  duration: /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
  gYear: /^-?\d{4,}$/,
};

/**
 * Check a literal's lexical form against its XSD datatype. Returns null when
 * it is well-formed (or the datatype is not one we check), else a short reason.
 */
export function checkLexicalForm(value: string, datatype: string): string | null {
  if (!datatype.startsWith(XSD)) return null;
  const v = value.trim();
  const name = localName(datatype);
  const bad = (what: string) => `"${value}" is not a valid ${what}`;
  if (INTEGER_TYPES.has(datatype)) {
    if (!RE.integer.test(v)) return bad(name);
    const n = Number(v);
    if (name === "nonNegativeInteger" && n < 0) return bad(name);
    if (name === "positiveInteger" && n <= 0) return bad(name);
    if (name === "nonPositiveInteger" && n > 0) return bad(name);
    if (name === "negativeInteger" && n >= 0) return bad(name);
    if (name.startsWith("unsigned") && n < 0) return bad(name);
    return null;
  }
  switch (name) {
    case "decimal":
      return RE.decimal.test(v) ? null : bad("decimal number");
    case "float":
    case "double":
      return RE.floating.test(v) ? null : bad(name);
    case "boolean":
      return RE.boolean.test(v) ? null : bad("boolean (true/false)");
    case "date":
      return RE.date.test(v) ? null : bad("date (YYYY-MM-DD)");
    case "dateTime":
    case "dateTimeStamp":
      return RE.dateTime.test(v) ? null : bad("dateTime (YYYY-MM-DDThh:mm:ss)");
    case "time":
      return RE.time.test(v) ? null : bad("time (hh:mm:ss)");
    case "duration":
    case "dayTimeDuration":
    case "yearMonthDuration":
      return RE.duration.test(v) ? null : bad("ISO 8601 duration (e.g. PT2.5S)");
    case "gYear":
      return RE.gYear.test(v) ? null : bad("year");
    default:
      return null;
  }
}
