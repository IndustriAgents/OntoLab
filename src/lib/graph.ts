// Unified graph model produced by aboxToGraph and consumed by the canvas.

export interface GraphNode {
  id: string;
  label: string;
  props: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  props: Record<string, string>;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** De-dupe nodes by id and ensure every edge endpoint exists as a node. */
export function normalize(model: GraphModel): GraphModel {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of model.nodes) {
    if (!n.id) continue;
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, { ...n, label: n.label || n.id, props: n.props ?? {} });
  }

  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const e of model.edges) {
    if (!e.source || !e.target) continue;
    for (const endpoint of [e.source, e.target]) {
      if (!nodeMap.has(endpoint)) {
        nodeMap.set(endpoint, { id: endpoint, label: endpoint, props: {} });
      }
    }
    let id = e.id || `${e.source}__${e.label ?? ""}__${e.target}`;
    while (seenEdge.has(id)) id += "_";
    seenEdge.add(id);
    edges.push({ ...e, id, props: e.props ?? {} });
  }

  return { nodes: [...nodeMap.values()], edges };
}
