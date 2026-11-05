import { evidenceFiles, type Citation, type EvidenceTerm, type TboxEvidence } from "./tboxEvidence";

export type EvidenceNodeKind = "topic" | "chunk" | "passage" | "class" | "property";
export type EvidenceEdgeKind = "member" | "generated" | "input" | "located" | "cited";
export interface EvidenceGraphNode {
  id: string;
  kind: EvidenceNodeKind;
  refId: string;
  label: string;
  term?: EvidenceTerm;
  chunkId?: string;
  citation?: Citation;
  topicId?: string;
  text?: string;
  fileName?: string;
  unavailable?: boolean;
}
export interface EvidenceGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EvidenceEdgeKind;
  label: string;
}
export interface TboxGraph {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
  byId: Map<string, EvidenceGraphNode>;
}
export const evidenceNodeId = (kind: "topic" | "chunk" | "term", id: string) => `${kind}/${id}`;

/** Builds only recorded provenance. Planned membership never becomes a model-input edge. */
export function buildEvidenceGraph(data: TboxEvidence): TboxGraph {
  const nodes = new Map<string, EvidenceGraphNode>(),
    edges = new Map<string, EvidenceGraphEdge>();
  const files = evidenceFiles(data),
    callById = new Map(data.calls.map((c) => [c.id, c]));
  const addEdge = (source: string, target: string, kind: EvidenceEdgeKind, label: string) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const id = JSON.stringify([kind, source, target]);
    edges.set(id, { id, source, target, kind, label });
  };
  const addChunk = (id: string) => {
    const key = evidenceNodeId("chunk", id);
    if (nodes.has(key)) return key;
    const chunk = data.chunks.get(id),
      saved = data.calls.flatMap((c) => c.passages ?? []).find((p) => p.chunkId === id);
    const file = files.find((f) => f.id === (chunk?.documentId ?? saved?.documentId));
    nodes.set(key, {
      id: key,
      kind: "chunk",
      refId: id,
      chunkId: id,
      label: chunk ? `${file?.label ?? "Source"} · Chunk ${chunk.ordinal + 1}` : "Saved call passage",
      text: chunk?.text ?? saved?.text,
      fileName: file?.name ?? saved?.name,
      unavailable: !chunk && !saved,
    });
    return key;
  };
  for (const topic of data.topics)
    nodes.set(evidenceNodeId("topic", topic.id), {
      id: evidenceNodeId("topic", topic.id),
      kind: "topic",
      refId: topic.id,
      topicId: topic.id,
      label: topic.label,
    });
  for (const topic of data.topics)
    for (const id of topic.chunkIds) addEdge(evidenceNodeId("topic", topic.id), addChunk(id), "member", "Grouped in topic");
  for (const term of data.terms)
    nodes.set(evidenceNodeId("term", term.id), {
      id: evidenceNodeId("term", term.id),
      kind: term.kind === "class" ? "class" : "property",
      refId: term.id,
      label: term.label,
      term,
    });
  for (const term of data.terms) {
    const termId = evidenceNodeId("term", term.id);
    for (const origin of term.origins) {
      const call = callById.get(origin.callId);
      if (!call) continue;
      addEdge(evidenceNodeId("topic", call.topicId), termId, "generated", "Generated in topic");
      for (const passage of call.passages ?? []) addEdge(addChunk(passage.chunkId), termId, "input", "Shared generation input");
    }
    for (const citation of term.citations.filter((c) => c.quote)) {
      // The complete tuple avoids collisions and stays stable as later checkpoints arrive.
      const id = `passage/${JSON.stringify([citation.callId, citation.documentId, citation.chunkId, citation.start, citation.end, citation.quote])}`;
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          kind: "passage",
          refId: id,
          label: citation.quote.replace(/\s+/g, " ").slice(0, 90),
          text: citation.quote,
          citation,
          chunkId: citation.chunkId,
          topicId: callById.get(citation.callId)?.topicId,
          unavailable: !citation.chunkId,
        });
      addEdge(id, termId, "cited", "Model-cited quote");
      if (citation.chunkId) addEdge(addChunk(citation.chunkId), id, "located", "Quote located in chunk");
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], byId: nodes };
}

/** Explicit paths, not unrestricted BFS: siblings sharing a topic are not evidence for one another. */
export function traceEvidenceGraph(graph: TboxGraph, id: string, includeInputs = false) {
  const nodeIds = new Set<string>(),
    edgeIds = new Set<string>();
  const node = graph.byId.get(id);
  if (!node) return { nodeIds, edgeIds, associationOnly: false, hiddenInputs: 0 };
  nodeIds.add(id);
  const markEdge = (edge: EvidenceGraphEdge) => {
    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  };
  let associationOnly = false,
    hiddenInputs = 0;
  if (node.kind === "class" || node.kind === "property") {
    for (const e of graph.edges.filter((e) => e.kind === "generated" && e.target === id)) markEdge(e);
    const quotes = graph.edges.filter((e) => e.kind === "cited" && e.target === id);
    quotes.forEach(markEdge);
    const quoteIds = new Set(quotes.map((e) => e.source));
    const located = graph.edges.filter((e) => e.kind === "located" && quoteIds.has(e.target));
    located.forEach(markEdge);
    const directChunks = new Set(located.map((e) => e.source));
    const inputs = graph.edges.filter((e) => e.kind === "input" && e.target === id && !directChunks.has(e.source));
    associationOnly = !directChunks.size && inputs.length > 0;
    if (includeInputs) inputs.forEach(markEdge);
    else hiddenInputs = inputs.length;
  } else if (node.kind === "topic") {
    graph.edges.filter((e) => (e.kind === "member" || e.kind === "generated") && e.source === id).forEach(markEdge);
    const quotes = graph.nodes.filter((n) => n.kind === "passage" && n.topicId === node.refId);
    for (const q of quotes) graph.edges.filter((e) => e.kind === "cited" && e.source === q.id).forEach(markEdge);
    graph.edges.filter((e) => e.kind === "located" && quotes.some((q) => q.id === e.target)).forEach(markEdge);
    if (includeInputs) graph.edges.filter((e) => e.kind === "input" && nodeIds.has(e.source) && nodeIds.has(e.target)).forEach(markEdge);
  } else if (node.kind === "chunk") {
    graph.edges.filter((e) => e.kind === "member" && e.target === id).forEach(markEdge);
    const located = graph.edges.filter((e) => e.kind === "located" && e.source === id);
    located.forEach(markEdge);
    const quotes = new Set(located.map((e) => e.target));
    graph.edges.filter((e) => e.kind === "cited" && quotes.has(e.source)).forEach(markEdge);
    const inputs = graph.edges.filter((e) => e.kind === "input" && e.source === id && !nodeIds.has(e.target));
    associationOnly = !quotes.size && inputs.length > 0;
    if (includeInputs) inputs.forEach(markEdge);
    else hiddenInputs = inputs.length;
    graph.edges.filter((e) => e.kind === "generated" && nodeIds.has(e.source) && nodeIds.has(e.target)).forEach(markEdge);
  } else {
    graph.edges.filter((e) => (e.kind === "located" && e.target === id) || (e.kind === "cited" && e.source === id)).forEach(markEdge);
    const topic = node.topicId && evidenceNodeId("topic", node.topicId);
    if (topic) graph.edges.filter((e) => e.kind === "generated" && e.source === topic && nodeIds.has(e.target)).forEach(markEdge);
  }
  graph.edges.filter((e) => e.kind === "member" && nodeIds.has(e.source) && nodeIds.has(e.target)).forEach(markEdge);
  return { nodeIds, edgeIds, associationOnly, hiddenInputs };
}

export function topicGraphNodes(graph: TboxGraph, topicId: string) {
  if (!topicId) return new Set(graph.nodes.map((n) => n.id));
  return traceEvidenceGraph(graph, evidenceNodeId("topic", topicId), true).nodeIds;
}

const column = (n: EvidenceGraphNode) => (n.kind === "topic" ? 0 : n.kind === "chunk" ? 1 : n.kind === "passage" ? 2 : 3);
/** Deterministic columns are a provenance layout, not an embedding projection. */
export function layoutEvidenceGraph(nodes: EvidenceGraphNode[], edges: EvidenceGraphEdge[], vertical = false) {
  const lanes = [0, 1, 2, 3].map((i) =>
    nodes.filter((n) => column(n) === i).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  );
  const height = vertical ? 638 : Math.max(420, ...lanes.map((lane) => lane.length * 68 + 100));
  const width = vertical ? Math.max(300, ...lanes.map((lane) => lane.length * 212 + 80)) : 1000;
  const positions = new Map<string, { x: number; y: number }>();
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 4; i++) {
      if (pass)
        lanes[i].sort((a, b) => {
          const center = (id: string) => {
            const ys = edges
              .filter((e) => e.source === id || e.target === id)
              .map((e) => {
                const p = positions.get(e.source === id ? e.target : e.source);
                return vertical ? p?.x : p?.y;
              })
              .filter((v): v is number => v !== undefined);
            return ys.length ? ys.reduce((sum, v) => sum + v, 0) / ys.length : (vertical ? width : height) / 2;
          };
          return center(a.id) - center(b.id) || a.label.localeCompare(b.label);
        });
      lanes[i].forEach((n, j) =>
        positions.set(
          n.id,
          vertical
            ? { x: 50 + ((j + 0.5) * (width - 100)) / Math.max(lanes[i].length, 1), y: 76 + i * 142 }
            : { x: 122 + i * 250, y: 70 + ((j + 0.5) * (height - 100)) / Math.max(lanes[i].length, 1) },
        ),
      );
    }
  }
  return { width, height, positions };
}
