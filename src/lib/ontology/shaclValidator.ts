import ds from "@rdfjs/dataset";
import { DataFactory, Writer, type Quad } from "n3";
import SHACLValidator from "rdf-validate-shacl";
import { serializeABoxQuads } from "./aboxSerializer";
import { tboxToShapes } from "./shaclShapes";
import { ancestorsOf } from "./hierarchy";
import { localName, RDF_TYPE, SH } from "./iri";
import type { ABoxResult, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";
import type { ShaclExecution } from "../../types/transparency";

const { namedNode, quad } = DataFactory;

/**
 * Validate the A-Box against SHACL shapes induced from the T-Box (tboxToShapes).
 * This is the standards-based form of validateABox's checks.
 *
 * Before validating we materialise each individual's full rdfs:subClassOf
 * ancestor types (same closure as aboxValidator) so sh:class / sh:targetClass
 * honour the class hierarchy. Findings map back to the originating individual
 * via the shared id→IRI map; sh:Warning results become "warn" (flag-and-keep),
 * sh:Violation results become "error".
 */
export async function validateShacl(abox: ABoxResult, tbox: TBoxModel, baseIri?: string): Promise<ValidationIssue[]> {
  return (await validateShaclDetailed(abox, tbox, baseIri)).issues;
}

export async function validateShaclDetailed(
  abox: ABoxResult,
  tbox: TBoxModel,
  baseIri?: string,
): Promise<{ issues: ValidationIssue[]; execution: ShaclExecution }> {
  const started = Date.now();
  const shapes = tboxToShapes(tbox);

  const { quads, idToUri } = serializeABoxQuads(abox, tbox, baseIri, { header: false, provenance: false });

  const dataQuads: Quad[] = [...quads];
  for (const ind of abox.individuals) {
    const subj = namedNode(idToUri.get(ind.id)!);
    for (const cls of [ind.classUri, ...(ind.additionalTypes ?? [])]) {
      if (!cls) continue;
      for (const a of ancestorsOf(tbox, cls)) {
        if (a !== cls) dataQuads.push(quad(subj, namedNode(RDF_TYPE), namedNode(a)));
      }
    }
  }

  const execution: ShaclExecution = {
    status: abox.individuals.length ? "completed" : "empty-data",
    engine: "rdf-validate-shacl",
    durationMs: 0,
    conforms: null,
    shapeQuads: shapes.length,
    dataQuads: dataQuads.length,
    inferredTypeQuads: dataQuads.length - quads.length,
    shapesTurtle: new Writer().quadsToString(shapes),
    dataTurtle: new Writer().quadsToString(dataQuads),
    results: [],
  };
  if (!abox.individuals.length) {
    execution.durationMs = Date.now() - started;
    return { issues: [], execution };
  }
  const validator = new SHACLValidator(ds.dataset(shapes));
  let report;
  try {
    report = await validator.validate(ds.dataset(dataQuads));
  } catch (e) {
    execution.status = "failed";
    execution.error = e instanceof Error ? e.message : "SHACL execution failed";
    execution.durationMs = Date.now() - started;
    return {
      issues: [{ severity: "warn", code: "shacl", where: "SHACL", message: `SHACL validation could not run: ${execution.error}` }],
      execution,
    };
  }
  execution.conforms = report.conforms;

  const uriToInd = new Map<string, { id: string; label?: string }>();
  for (const ind of abox.individuals) uriToInd.set(idToUri.get(ind.id)!, { id: ind.id, label: ind.label });

  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const res of report.results) {
    const focus = res.focusNode?.value ?? "";
    const meta = uriToInd.get(focus);
    const where = meta ? (meta.label ? `${meta.label} (${meta.id})` : meta.id) : focus ? localName(focus) : "(unknown)";
    const path = res.path && "value" in res.path ? (res.path as { value: string }).value : undefined;
    const value = res.value && "value" in res.value ? (res.value as { value: string }).value : undefined;
    const component = localName(res.sourceConstraintComponent?.value ?? "").replace(/ConstraintComponent$/, "");
    const severityIri = res.severity?.value ?? SH + "Violation";
    execution.results.push({
      focusNode: focus,
      path,
      value,
      sourceShape: res.sourceShape?.value ?? "",
      constraint: res.sourceConstraintComponent?.value ?? "",
      severity: severityIri,
      messages: res.message?.map((m) => m.value) ?? [],
    });
    const severity: ValidationIssue["severity"] = severityIri === SH + "Violation" ? "error" : "warn";

    const base =
      res.message?.[0]?.value ||
      (component === "Class"
        ? "value is not an instance of the required class"
        : component === "Datatype"
          ? "value does not have the required datatype"
          : component === "MaxCount"
            ? "too many values"
            : component === "MinCount" || component === "QualifiedMinCount"
              ? "required value is missing"
              : component === "Or"
                ? "value matches none of the allowed types"
                : component === "Not"
                  ? "individual is typed with disjoint classes"
                  : `${component || "SHACL"} constraint violated`);
    const shownValue = value != null ? ` (${value.length > 60 ? value.slice(0, 57) + "…" : value})` : "";
    const message = path ? `${localName(path)}${shownValue}: ${base}` : base;

    const key = `${focus}|${path}|${component}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ severity, code: "shacl", message, where, id: meta?.id });
  }
  execution.durationMs = Date.now() - started;
  return { issues, execution };
}
