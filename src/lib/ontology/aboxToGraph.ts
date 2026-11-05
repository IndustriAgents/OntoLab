import type { ABoxResult } from "../../types/abox";
import { normalize, type GraphModel } from "../graph";
import { localName } from "./iri";

/**
 * Turn the structured A-Box into the Cytoscape graph model: each individual is a
 * node coloured by its class (`type` prop); each object property is a labelled
 * edge; data properties + evidence ride along as node props for the inspector.
 * Duplicate ids collapse to one node (the validator reports them as errors).
 */
export function aboxToGraph(abox: ABoxResult): GraphModel {
  const nodes = abox.individuals.map((ind) => {
    const props: Record<string, string> = { type: localName(ind.classUri) };
    for (const dp of ind.dataProperties ?? []) {
      const key = localName(dp.propUri);
      props[key] = props[key] ? `${props[key]}; ${dp.value}` : dp.value;
    }
    if (ind.sourceEvidence) props.evidence = ind.sourceEvidence;
    return { id: ind.id, label: ind.label || ind.id, props };
  });

  const edges = abox.individuals.flatMap((ind, i) =>
    (ind.objectProperties ?? []).map((op, j) => ({
      id: `e${i}_${j}`,
      source: ind.id,
      target: op.targetId,
      label: localName(op.propUri),
      props: {},
    })),
  );

  return normalize({ nodes, edges });
}
