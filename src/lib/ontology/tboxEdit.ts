import { DataFactory, Parser, Writer, type Quad } from "n3";
import { parseTBox } from "./tboxParser";
import { localName, namespaceOf, OWL, RDFS, XSD } from "./iri";
import { toTermLocalName } from "./tboxSerializer";

const { namedNode } = DataFactory;

export { namespaceOf };

/** NCName-ish local name, preserving case (same rule as generated T-Box terms). */
export const sanitizeLocal = toTermLocalName;

/** Resolve a term's local name to its full URI within a module's Turtle. */
export function localNameToUri(turtle: string, name: string): string | null {
  let model;
  try {
    model = parseTBox(turtle);
  } catch {
    return null;
  }
  const all = [...model.classes, ...model.objectProps, ...model.dataProps];
  const hit = all.find((t) => localName(t.uri) === name);
  return hit ? hit.uri : null;
}

/** Build the rename target URI for a term: keep the source term's namespace. */
export function renameTargetUri(fromUri: string, toName: string): string {
  return namespaceOf(fromUri) + sanitizeLocal(toName);
}

/** Declared prefixes of a Turtle document (via the N3 parser, so @base/@prefix edge cases are handled). */
export function extractPrefixes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    new Parser().parse(text, null, (prefix: string, iri: { value: string }) => {
      out[prefix] = iri.value;
    });
  } catch {
    // a broken document contributes no prefixes
  }
  return out;
}

/**
 * Apply edit operations to a module's Turtle at the quad level and re-serialize:
 *   - remove: drop every quad whose subject or NamedNode object is a removed URI;
 *   - rename: substitute renamed URIs in subject/object NamedNode positions;
 *   - additions: append the quads of `additionsTurtle`.
 * Produces a full, drop-in updated module.
 */
export function buildUpdatedModule(
  originalTurtle: string,
  opts: { removeUris?: string[]; renames?: { fromUri: string; toUri: string }[]; additionsTurtle?: string },
): string {
  const removeSet = new Set(opts.removeUris ?? []);
  const renameMap = new Map((opts.renames ?? []).map((r) => [r.fromUri, r.toUri]));
  const subst = (v: string) => renameMap.get(v) ?? v;

  const origQuads = new Parser().parse(originalTurtle);
  const addQuads = opts.additionsTurtle?.trim() ? new Parser().parse(opts.additionsTurtle) : [];

  const out: Quad[] = [];
  for (const q of origQuads) {
    if (removeSet.has(q.subject.value)) continue;
    if (q.object.termType === "NamedNode" && removeSet.has(q.object.value)) continue;
    const subject = q.subject.termType === "NamedNode" && renameMap.has(q.subject.value) ? namedNode(subst(q.subject.value)) : q.subject;
    const object = q.object.termType === "NamedNode" && renameMap.has(q.object.value) ? namedNode(subst(q.object.value)) : q.object;
    out.push(DataFactory.quad(subject, q.predicate, object, q.graph));
  }
  for (const q of addQuads) out.push(q);

  const prefixes: Record<string, string> = {
    owl: OWL,
    rdfs: RDFS,
    xsd: XSD,
    ...extractPrefixes(originalTurtle),
    ...extractPrefixes(opts.additionsTurtle ?? ""),
  };

  const writer = new Writer({ prefixes });
  writer.addQuads(out);
  let result = "";
  let writeErr: Error | null = null;
  writer.end((err, res) => {
    if (err) writeErr = err;
    else result = res;
  });
  if (writeErr) throw new Error(`module update serialize error: ${(writeErr as Error).message}`);
  return result;
}
