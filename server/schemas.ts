// JSON Schemas for the structured-output tools. Class and property URIs become
// enums, and datatypes are an enum of the datatypes the T-Box actually declares
// (plus common XSD types) — the old free-text `datatype` let the model emit
// "decimal", which serialised to the invalid IRI <decimal> and broke both the
// Turtle export and every SPARQL competency question.

import type { TBoxModel } from "../src/types/tbox.ts";
import { COMMON_DATATYPES, normalizeDatatype, localName, RDFS_LITERAL, XSD } from "../src/lib/ontology/iri.ts";

export type JsonSchema = Record<string, unknown>;

/**
 * The datatypes the model may choose from, as SHORT names ("decimal", not
 * "http://www.w3.org/2001/XMLSchema#decimal").
 *
 * Full IRIs cost ~15-25 tokens each and are repeated for every data property in
 * the output; with a large A-Box that bulk made Gemini return
 * MALFORMED_FUNCTION_CALL outright. Short names constrain the model just as
 * tightly and `normalizeDatatype` maps them back to IRIs server-side.
 * Non-XSD (custom) datatypes keep their full IRI, since there is nothing to map.
 */
export function datatypeEnum(tbox: TBoxModel): string[] {
  const declared = tbox.dataProps
    .flatMap((p) => p.range)
    .map((r) => normalizeDatatype(r) ?? r)
    .filter((r) => r && r !== RDFS_LITERAL)
    .map((r) => (r.startsWith(XSD) ? localName(r) : r));
  const common = COMMON_DATATYPES.map((d) => localName(d));
  return [...new Set([...declared, ...common])];
}

function individualSchema(tbox: TBoxModel, opts: { requireEvidence?: boolean } = {}): JsonSchema {
  const classUris = tbox.classes.map((c) => c.uri);
  const dataPropUris = tbox.dataProps.map((p) => p.uri);
  const objPropUris = tbox.objectProps.map((p) => p.uri);

  const properties: Record<string, unknown> = {
    id: { type: "string", description: "stable lowercase-kebab identifier, unique within this result" },
    classUri: { type: "string", enum: classUris, description: "the most specific T-Box class this individual instantiates" },
    label: { type: "string", description: "human-readable label" },
    sourceEvidence: { type: "string", description: "short verbatim quote from the documents supporting this individual" },
  };
  // NOTE: `additionalTypes` is deliberately NOT offered to the model. Multi-typing
  // is rare in extracted A-Boxes, and the extra enum array per individual measurably
  // raised Gemini's MALFORMED_FUNCTION_CALL rate on long outputs. The field still
  // exists in the data model, so multi-typed individuals survive a Turtle round-trip
  // and can be added by hand in the editor.
  if (dataPropUris.length) {
    properties.dataProperties = {
      type: "array",
      description:
        "All supported literal assertions for this individual, including stated values, descriptions, results and limitations; empty only if none are supported.",
      items: {
        type: "object",
        properties: {
          propUri: { type: "string", enum: dataPropUris },
          value: { type: "string", description: "the literal value; magnitude only when the datatype is numeric" },
          datatype: {
            type: "string",
            enum: datatypeEnum(tbox),
            description: 'xsd datatype name matching the property\'s declared range, e.g. "decimal"',
          },
          lang: { type: "string", description: 'BCP-47 language tag for quoted text in another language, e.g. "de"' },
          quote: { type: "string", description: "short verbatim quote from the documents stating this value" },
        },
        required: ["propUri", "value", ...(opts.requireEvidence ? ["quote"] : [])],
        additionalProperties: false,
      },
    };
  }
  if (objPropUris.length) {
    properties.objectProperties = {
      type: "array",
      items: {
        type: "object",
        properties: {
          propUri: { type: "string", enum: objPropUris },
          targetId: { type: "string", description: "the id of another individual in THIS result" },
          quote: { type: "string", description: "short verbatim quote from the documents stating this relation" },
        },
        required: ["propUri", "targetId", ...(opts.requireEvidence ? ["quote"] : [])],
        additionalProperties: false,
      },
    };
  }

  const required = [
    "id",
    "classUri",
    ...(opts.requireEvidence
      ? ["sourceEvidence", ...(dataPropUris.length ? ["dataProperties"] : []), ...(objPropUris.length ? ["objectProperties"] : [])]
      : []),
  ];
  return { type: "object", properties, required, additionalProperties: false };
}

export interface ExtractSchemaOptions {
  /** every individual must carry a verbatim quote (the evidence gate) */
  requireEvidence?: boolean;
  /** offer `proposedTerms` for facts no T-Box term can express (the improvement loop, EDC-style) */
  proposeTerms?: boolean;
}

/** Terms the extractor needed but the ontology lacks. Free text on purpose: these are the ones the enums cannot hold. */
export const PROPOSED_TERMS_SCHEMA: JsonSchema = {
  type: "array",
  description: "ideas the documents state that NO existing class or property can express; empty when the T-Box covers everything",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["class", "objectProperty", "dataProperty"] },
      name: { type: "string", description: "PascalCase for a class, camelCase for a property" },
      definition: { type: "string", description: "one-sentence definition" },
      parent: { type: "string", description: "class: local name of the closest existing superclass" },
      domain: { type: "string", description: "property: local name of the subject class" },
      range: { type: "string", description: "property: local name of the object class, or an xsd datatype" },
      quote: { type: "string", description: "short verbatim quote where the idea occurs" },
      subject: { type: "string", description: "id of the individual the fact is about (as in individuals, or a new kebab-case id)" },
      subjectLabel: { type: "string", description: "that individual's name as written" },
      value: { type: "string", description: "dataProperty: the value the text gives" },
      object: { type: "string", description: "objectProperty: id of the individual it points at" },
    },
    required: ["kind", "name", "definition"],
    additionalProperties: false,
  },
};

/** Schema for extraction / interactive refinement. */
export function buildExtractSchema(tbox: TBoxModel, withQuestions: boolean, opts: ExtractSchemaOptions = {}): JsonSchema {
  const properties: Record<string, unknown> = {
    individuals: { type: "array", items: individualSchema(tbox, { requireEvidence: opts.requireEvidence }) },
  };
  if (opts.proposeTerms) properties.proposedTerms = PROPOSED_TERMS_SCHEMA;
  if (withQuestions) {
    properties.questions = {
      type: "array",
      description: "clarifying questions about gaps/ambiguities; empty when nothing useful remains to ask",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "stable id for this question" },
          text: { type: "string", description: "the clarifying question" },
          options: { type: "array", items: { type: "string" }, description: "optional suggested answers" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    };
  }
  return { type: "object", properties, required: ["individuals"], additionalProperties: false };
}

/**
 * Schema for edit mode: patch operations rather than a full re-emission.
 * Re-emitting the whole A-Box meant a lazy or truncated response silently
 * deleted individuals; with ops, anything untouched is preserved by construction.
 */
export function buildEditSchema(tbox: TBoxModel): JsonSchema {
  return {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "the changes to apply; empty when the message needs no change",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "update", "remove"] },
            id: { type: "string", description: "id of the individual to update/remove (required for update and remove)" },
            individual: individualSchema(tbox),
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      summary: { type: "string", description: "a 1–2 sentence, user-facing description of what changed (or the answer to a question)" },
    },
    required: ["operations", "summary"],
    additionalProperties: false,
  };
}

const nameStr = { type: "string" };
const names = { type: "array", items: { type: "string" } };
const DATATYPE_NAMES = ["string", "decimal", "integer", "boolean", "double", "date", "dateTime", "time", "duration", "anyURI"];

/** Schema for T-Box generation (emit_tbox). */
export function buildTBoxSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      classes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "PascalCase local name, unique among classes" },
            label: nameStr,
            comment: nameStr,
            parents: { ...names, description: "names of more general superclasses" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      objectProperties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "camelCase local name, unique among properties" },
            label: nameStr,
            comment: nameStr,
            domain: { ...names, description: "subject class name(s)" },
            range: { ...names, description: "object class name(s)" },
            functional: { type: "boolean", description: "true when a subject may have at most one value" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      dataProperties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "camelCase local name, unique among properties" },
            label: nameStr,
            comment: nameStr,
            domain: { ...names, description: "subject class name(s)" },
            datatype: { type: "string", enum: DATATYPE_NAMES, description: "xsd datatype local name" },
            functional: { type: "boolean", description: "true when a subject may have at most one value" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["classes"],
    additionalProperties: false,
  };
}

/** Schema for the advisory T-Box coverage suggestion. */
export function buildSuggestSchema(): JsonSchema {
  const moduleField = { type: "string", description: "file name of the existing module this term extends; omit for a brand-new module" };
  return {
    type: "object",
    properties: {
      coverage: { type: "string", description: "Brief plain-language assessment of how well the T-Box fits the documents" },
      classes: {
        type: "array",
        description: "Suggested NEW classes (empty if nothing to add)",
        items: {
          type: "object",
          properties: { name: nameStr, label: nameStr, comment: nameStr, parents: names, module: moduleField },
          required: ["name"],
          additionalProperties: false,
        },
      },
      objectProperties: {
        type: "array",
        description: "Suggested NEW object properties",
        items: {
          type: "object",
          properties: { name: nameStr, label: nameStr, comment: nameStr, domain: names, range: names, module: moduleField },
          required: ["name"],
          additionalProperties: false,
        },
      },
      dataProperties: {
        type: "array",
        description: "Suggested NEW data properties",
        items: {
          type: "object",
          properties: {
            name: nameStr,
            label: nameStr,
            comment: nameStr,
            domain: names,
            datatype: { type: "string", enum: DATATYPE_NAMES },
            module: moduleField,
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      removals: {
        type: "array",
        description: "EXISTING terms to delete (redundant/incorrect)",
        items: {
          type: "object",
          properties: {
            term: { type: "string", description: "exact existing local name" },
            module: { type: "string", description: "file that declares it" },
          },
          required: ["term", "module"],
          additionalProperties: false,
        },
      },
      renames: {
        type: "array",
        description: "EXISTING terms to rename (misnamed)",
        items: {
          type: "object",
          properties: { from: nameStr, to: nameStr, module: { type: "string", description: "file that declares it" } },
          required: ["from", "to", "module"],
          additionalProperties: false,
        },
      },
      updates: { type: "array", items: { type: "string" }, description: "Short notes on OTHER recommended changes" },
    },
    required: ["coverage"],
    additionalProperties: false,
  };
}

/** Schema for competency-question translation. */
export function buildCQSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      sparql: { type: "string", description: "The SPARQL 1.1 query answering the question." },
      explanation: { type: "string", description: "One sentence explaining what the query returns." },
    },
    required: ["sparql", "explanation"],
    additionalProperties: false,
  };
}

/**
 * OpenAI strict mode requires every property to appear in `required`, with
 * optional ones typed as nullable. Converting here lets us keep one readable
 * schema definition and still get guaranteed enum conformance.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toStrictSchema(pv)]));
    } else out[k] = toStrictSchema(v);
  }
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const all = Object.keys(s.properties as Record<string, unknown>);
    const required = new Set((Array.isArray(s.required) ? (s.required as string[]) : []).filter((r) => all.includes(r)));
    const props = out.properties as Record<string, Record<string, unknown>>;
    for (const key of all) {
      if (required.has(key)) continue;
      const p = props[key];
      // optional → nullable union, as strict mode demands
      if (p && typeof p.type === "string") props[key] = { ...p, type: [p.type, "null"] };
    }
    out.required = all;
    out.additionalProperties = false;
  }
  return out;
}

/** Gemini wants an OpenAPI-subset schema: uppercase types, no additionalProperties. */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (k === "additionalProperties") continue;
      if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
      else out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return s;
}
