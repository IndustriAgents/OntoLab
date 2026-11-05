// The evidence graph: the triples behind an answer, rebuilt from the cited
// queries' patterns and bindings, drawn with the Explore graph. Resources are
// coloured by class; classes, values and blank nodes are grey chips that can
// be hidden. Click a node for what it is and which query found it; a query
// pill fades everything that query did not produce.

import { useMemo, useState } from "react";
import type { EvidenceGraph } from "../../types/graphChat";
import { ForceGraph, type GraphEdge, type GraphNode } from "../explore/ForceGraph";
import { workbenchResourceUrl } from "./graphChat";

const CLASS = "Class";
const VALUE = "Value";
const BLANK = "Blank node";
const UNTYPED = "Untyped";
const NEUTRAL = new Set([CLASS, VALUE, BLANK, UNTYPED]);
const NOUN = { one: "node", many: "nodes" };

interface Props {
  graph: EvidenceGraph;
  theme: "light" | "dark";
  workbenchUrl?: string;
  focusQuery?: string;
  onFocusQuery: (id?: string) => void;
  onIndividual?: (id: string) => void;
}

export function EvidenceGraphView({ graph, theme, workbenchUrl, focusQuery, onFocusQuery, onIndividual }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  // Large graphs start without literal values (labels already name the nodes); the Value chip brings them back.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(graph.nodes.length > 60 ? [VALUE] : []));

  const { nodes, edges, byId } = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: GraphNode[] = graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind === "resource" ? (n.type ?? UNTYPED) : n.kind === "class" ? CLASS : n.kind === "literal" ? VALUE : BLANK,
      label: n.kind === "literal" ? (n.value ?? n.label) : n.label,
      degree: degree.get(n.id) ?? 0,
    }));
    const edges: GraphEdge[] = graph.edges.map((e) => ({ from: e.source, to: e.target, name: e.label }));
    return { nodes, edges, byId: new Map(graph.nodes.map((n) => [n.id, n])) };
  }, [graph]);

  // What the focused query produced stays bright; the rest fades.
  const emphasis = useMemo(() => (focusQuery ? new Set(graph.nodes.filter((n) => n.sources.includes(focusQuery)).map((n) => n.id)) : null), [graph, focusQuery]);

  const pills =
    graph.queryIds.length > 1 ? (
      <span className="gc-query-pills" role="group" aria-label="Highlight one query">
        {graph.queryIds.map((id) => (
          <button key={id} type="button" className={"og-type" + (focusQuery === id ? " is-current" : "")} aria-pressed={focusQuery === id} onClick={() => onFocusQuery(focusQuery === id ? undefined : id)}>
            {id}
          </button>
        ))}
      </span>
    ) : null;

  const details = (id: string) => {
    const n = byId.get(id);
    if (!n) return null;
    return (
      <>
        <dl className="kv-list gc-kv">
          {n.kind === "literal" && (
            <>
              <dt>Value</dt>
              <dd>{n.value}</dd>
            </>
          )}
          {n.compact && (
            <>
              <dt>IRI</dt>
              <dd className="mono-sm">
                {n.iri && workbenchUrl ? (
                  <a href={workbenchResourceUrl(workbenchUrl, n.iri)} target="_blank" rel="noreferrer">
                    {n.compact}
                  </a>
                ) : (
                  n.compact
                )}
              </dd>
            </>
          )}
          {n.datatype && (
            <>
              <dt>Datatype</dt>
              <dd className="mono-sm">{n.datatype}</dd>
            </>
          )}
          {n.lang && (
            <>
              <dt>Language</dt>
              <dd>{n.lang}</dd>
            </>
          )}
          {n.vars.length > 0 && (
            <>
              <dt>Bound to</dt>
              <dd className="mono-sm">{n.vars.map((v) => `?${v}`).join("  ")}</dd>
            </>
          )}
          <dt>Found by</dt>
          <dd className="mono-sm">{n.sources.join(", ")}</dd>
        </dl>
        {n.individualId && onIndividual && (
          <div className="og-actions">
            <button type="button" className="btn sm" onClick={() => onIndividual(n.individualId!)}>
              Show in Explore
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="gc-graph">
      {(graph.truncated || graph.note) && (
        <p className="gc-note">
          {graph.truncated && "Showing the first 300 triples. "}
          {graph.note}
        </p>
      )}
      <ForceGraph
        nodes={nodes}
        edges={edges}
        all={nodes}
        total={nodes.length}
        theme={theme}
        hidden={hidden}
        onToggleType={(t) => setHidden((h) => (h.has(t) ? new Set([...h].filter((x) => x !== t)) : new Set([...h, t])))}
        selectedId={selected}
        onSelect={setSelected}
        noun={NOUN}
        neutral={NEUTRAL}
        emphasis={emphasis}
        panelExtra={details}
        toolbar={pills}
      />
    </div>
  );
}
