import { parseTBox } from "../../lib/ontology/tboxParser";
import { localName } from "../../lib/ontology/iri";
import type { OntoModule } from "../../types/validation";
import { ALIGNMENT_MODULE } from "../../lib/alignment";

export interface AlignmentTerm {
  uri: string;
  label: string;
  comment?: string;
  moduleId: string;
  moduleName: string;
  kind: "class" | "object" | "data";
  parents: string[];
  children: string[];
  domain: string[];
  range: string[];
  constraints: string[];
}

export function alignmentTerms(modules: OntoModule[]): AlignmentTerm[] {
  return modules
    .filter((m) => m.name !== ALIGNMENT_MODULE)
    .flatMap((module) => {
      try {
        const model = parseTBox(module.turtle);
        const common = { moduleId: module.id, moduleName: module.name };
        return [
          ...model.classes.map((c): AlignmentTerm => ({
            ...common,
            ...c,
            label: c.label ?? localName(c.uri),
            kind: "class",
            parents: model.subClassOf[c.uri] ?? [],
            children: Object.entries(model.subClassOf)
              .filter(([, parents]) => parents.includes(c.uri))
              .map(([child]) => child),
            domain: [],
            range: [],
            constraints: [
              ...(c.disjointWith ?? []).map((uri) => `Disjoint with ${localName(uri)}`),
              ...(model.restrictions ?? [])
                .filter((r) => r.onClass === c.uri)
                .map((r) => `${localName(r.onProperty)}: ${r.kind} ${r.value ? localName(r.value) : (r.n ?? "")}`),
            ],
          })),
          ...[...model.objectProps, ...model.dataProps].map((p): AlignmentTerm => ({
            ...common,
            ...p,
            label: p.label ?? localName(p.uri),
            parents: p.subPropertyOf ?? [],
            children: [...model.objectProps, ...model.dataProps]
              .filter((child) => child.subPropertyOf?.includes(p.uri))
              .map((child) => child.uri),
            constraints: [
              ...(p.functional ? ["Functional"] : []),
              ...(p.characteristics ?? []),
              ...(p.inverseOf ? [`Inverse of ${localName(p.inverseOf)}`] : []),
            ],
          })),
        ];
      } catch {
        return [];
      }
    });
}
