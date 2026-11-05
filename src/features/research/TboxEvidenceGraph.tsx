import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildEvidenceGraph,
  evidenceNodeId,
  layoutEvidenceGraph,
  topicGraphNodes,
  traceEvidenceGraph,
  type EvidenceGraphNode,
  type EvidenceNodeKind,
} from "../../lib/tboxEvidenceGraph";
import { readableChunkPreview, type Citation, type TboxEvidence } from "../../lib/tboxEvidence";
import { IconMinus, IconPlus } from "../../components/icons";
import "./tbox-evidence-graph.css";

const names: Record<EvidenceNodeKind, string> = {
  topic: "Topic",
  chunk: "Chunk",
  passage: "Source passage",
  class: "Class",
  property: "Property",
};
const initialView = { zoom: 1, x: 0, y: 0 };
const amount = (count: number, label: string) => `${count} ${label}${count === 1 ? "" : "s"}`;
function lines(label: string) {
  const words = label.split(/\s+/);
  const result: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > 23) {
      result.push(line);
      line = word;
    } else line += (line ? " " : "") + word;
  }
  if (line) result.push(line);
  return result.slice(0, 2).map((s, i) => (s.length > 25 ? s.slice(0, 24) + "…" : i === 1 && result.length > 2 ? s.slice(0, 23) + "…" : s));
}

export function TboxEvidenceGraph({
  data,
  initialTopicId,
  initialTermId,
  onHighlightTerm,
  onInspectTerm,
  onSource,
  onTopicScope,
  onTopic,
}: {
  data: TboxEvidence;
  initialTopicId: string;
  initialTermId: string;
  onHighlightTerm: (id: string) => void;
  onInspectTerm: (id: string) => void;
  onSource: (chunkId: string, citation?: Citation) => void;
  onTopicScope: (id: string) => void;
  onTopic: (id: string, chunkId?: string) => void;
}) {
  const graph = useMemo(() => buildEvidenceGraph(data), [data]);
  const [scope, setScope] = useState(data.topics.some((t) => t.id === initialTopicId) ? initialTopicId : (data.topics[0]?.id ?? ""));
  const [mode, setMode] = useState<"focus" | "overview">("focus");
  const [includeInputs, setIncludeInputs] = useState(false);
  const [selection, setSelection] = useState(initialTermId ? evidenceNodeId("term", initialTermId) : "");
  const [view, setView] = useState(initialView);
  const [vertical, setVertical] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setVertical(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; origin: typeof initialView } | null>(null);
  const scopeIds = useMemo(() => topicGraphNodes(graph, scope), [graph, scope]);
  const scopedTerms = graph.nodes
    .filter((n) => n.term && scopeIds.has(n.id))
    .sort((a, b) => Number(b.kind === "class") - Number(a.kind === "class") || a.label.localeCompare(b.label));
  const selected =
    graph.byId.get(selection) ??
    scopedTerms.find((n) => n.refId === initialTermId) ??
    scopedTerms[0] ??
    graph.byId.get(evidenceNodeId("topic", scope)) ??
    graph.nodes[0];
  const terms = selected?.term && !scopedTerms.some((n) => n.id === selected.id) ? [selected, ...scopedTerms] : scopedTerms;
  const selectedId = selected?.id ?? "";
  const trace = useMemo(() => traceEvidenceGraph(graph, selectedId, includeInputs), [graph, selectedId, includeInputs]);
  const { nodes, edges } = useMemo(() => {
    const ids = mode === "focus" ? trace.nodeIds : new Set([...scopeIds, ...trace.nodeIds]);
    return {
      nodes: graph.nodes.filter((n) => ids.has(n.id)),
      edges: graph.edges.filter(
        (e) => ids.has(e.source) && ids.has(e.target) && (mode === "focus" ? trace.edgeIds.has(e.id) : includeInputs || e.kind !== "input"),
      ),
    };
  }, [graph, mode, trace, scopeIds, includeInputs]);
  const layout = useMemo(() => layoutEvidenceGraph(nodes, edges, vertical), [nodes, edges, vertical]);
  const focusedId = mode === "focus" ? selectedId : "";
  useEffect(() => setView(initialView), [scope, mode, focusedId, vertical]);
  const select = (node: EvidenceGraphNode) => {
    setSelection(node.id);
    if (node.term) onHighlightTerm(node.refId);
    if (node.kind === "topic") {
      setScope(node.refId);
      onTopicScope(node.refId);
    }
  };
  const setTopic = (id: string) => {
    setScope(id);
    setSelection("");
    setMode("focus");
    onTopicScope(id);
  };
  const zoom = (factor: number) =>
    setView((v) => {
      const next = Math.max(0.25, Math.min(Math.max(8, layout.width / 250, layout.height / 250), v.zoom * factor));
      return {
        zoom: next,
        x: v.x + (layout.width / v.zoom - layout.width / next) / 2,
        y: v.y + (layout.height / v.zoom - layout.height / next) / 2,
      };
    });
  const highlighted = graph.nodes.filter((n) => trace.nodeIds.has(n.id));
  const count = (kind: EvidenceNodeKind) => highlighted.filter((n) => n.kind === kind).length;
  const quotes = highlighted.filter((n) => n.kind === "passage");
  const citation = selected?.citation ?? selected?.term?.citations.find((c) => c.chunkId);
  const topicId =
    selected?.topicId ?? data.calls.find((c) => c.id === citation?.callId)?.topicId ?? highlighted.find((n) => n.kind === "topic")?.refId;
  const sourceChunk = selected?.chunkId ?? citation?.chunkId;
  return (
    <section className="eg-root" aria-label="Evidence graph view">
      <div className="eg-toolbar">
        <label className="field">
          <span>Browse topic</span>
          <select value={scope} onChange={(e) => setTopic(e.target.value)}>
            <option value="">All topics</option>
            {data.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field eg-term-select">
          <span>Trace a class or property</span>
          <select
            value={selected?.term ? selected.id : ""}
            onChange={(e) => {
              const node = graph.byId.get(e.target.value);
              if (node) {
                select(node);
                setMode("focus");
              }
            }}
          >
            <option value="">{terms.length ? "Choose a class or property" : "No generated terms yet"}</option>
            {(["class", "property"] as const).map((kind) => (
              <optgroup key={kind} label={kind === "class" ? "Classes" : "Properties"}>
                {terms
                  .filter((n) => n.kind === kind)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="research-tabs" role="group" aria-label="Graph detail">
          <button type="button" aria-pressed={mode === "focus"} onClick={() => setMode("focus")}>
            Selected path
          </button>
          <button type="button" aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>
            Overview
          </button>
        </div>
        <label className="check eg-input-toggle">
          <input type="checkbox" checked={includeInputs} onChange={(e) => setIncludeInputs(e.target.checked)} />
          Include shared inputs
        </label>
      </div>
      <div className="eg-legend" aria-label="Graph legend">
        {(Object.entries(names) as [EvidenceNodeKind, string][]).map(([kind, name]) => (
          <span key={kind}>
            <i className={`eg-swatch eg-${kind}`} />
            {name}
          </span>
        ))}
        <span>
          <i className="eg-line" />
          Recorded origin / quote
        </span>
        <span>
          <i className="eg-line is-dashed" />
          Shared input association
        </span>
      </div>
      <div className="eg-workspace">
        <div className="eg-chart">
          <div className="eg-canvas-tools">
            <span>
              {nodes.length} nodes · {edges.length} links
            </span>
            <div>
              <button className="icon-btn sm" type="button" aria-label="Zoom out graph" onClick={() => zoom(1 / 1.25)}>
                <IconMinus />
              </button>
              <button className="icon-btn sm" type="button" aria-label="Zoom in graph" onClick={() => zoom(1.25)}>
                <IconPlus />
              </button>
              <button className="btn ghost sm" type="button" onClick={() => setView(initialView)}>
                Fit graph
              </button>
              <button
                className="btn ghost sm eg-mobile-jump"
                type="button"
                onClick={() => inspectorRef.current?.scrollIntoView({ block: "start" })}
              >
                Details ↓
              </button>
            </div>
          </div>
          <div
            className="eg-viewport"
            role="region"
            aria-label="Interactive provenance graph"
            data-orientation={vertical ? "vertical" : "horizontal"}
            style={{ height: vertical ? 560 : nodes.length <= 8 ? 360 : 550 }}
          >
            <svg
              ref={svgRef}
              role="group"
              aria-label="Topics, chunks, source passages, classes and properties"
              viewBox={`${view.x} ${view.y} ${layout.width / view.zoom} ${layout.height / view.zoom}`}
              onPointerDown={(e) => {
                if (e.button !== 0 || (e.target as Element).closest(".eg-node")) return;
                drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: view };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = drag.current,
                  svg = svgRef.current;
                if (!d || !svg || d.id !== e.pointerId) return;
                const bounds = svg.getBoundingClientRect();
                const scale = Math.min(bounds.width / (layout.width / d.origin.zoom), bounds.height / (layout.height / d.origin.zoom));
                setView({ ...d.origin, x: d.origin.x - (e.clientX - d.x) / scale, y: d.origin.y - (e.clientY - d.y) / scale });
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              <g aria-hidden="true">
                {edges.map((edge) => {
                  const a = layout.positions.get(edge.source)!,
                    b = layout.positions.get(edge.target)!,
                    related = trace.edgeIds.has(edge.id);
                  return (
                    <path
                      key={edge.id}
                      className={`eg-edge eg-edge-${edge.kind}${related ? " is-related" : " is-muted"}`}
                      data-edge-kind={edge.kind}
                      data-highlighted={related}
                      d={
                        vertical
                          ? edge.kind === "generated"
                            ? `M ${a.x - 92} ${a.y} C ${a.x - 130} ${a.y + 40}, ${b.x - 130} ${b.y - 40}, ${b.x - 92} ${b.y}`
                            : edge.kind === "input"
                              ? `M ${a.x + 92} ${a.y} C ${a.x + 130} ${a.y + 40}, ${b.x + 130} ${b.y - 40}, ${b.x + 92} ${b.y}`
                              : `M ${a.x} ${a.y + 26} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y - 26}`
                          : edge.kind === "generated"
                            ? `M ${a.x + 92} ${a.y} C ${a.x + 180} ${a.y - 80}, ${b.x - 180} ${b.y - 80}, ${b.x - 92} ${b.y}`
                            : edge.kind === "input"
                              ? `M ${a.x} ${a.y + 26} C ${a.x + 50} ${a.y + 80}, ${b.x - 50} ${b.y + 80}, ${b.x} ${b.y + 26}`
                              : `M ${a.x + 92} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x - 92} ${b.y}`
                      }
                    >
                      <title>{edge.label}</title>
                    </path>
                  );
                })}
              </g>
              {["Topics", "Chunks", "Source passages", "Classes & properties"].map((label, i) => (
                <g key={label} aria-hidden="true">
                  {vertical && <rect x={layout.width / 2 - 80} y={10 + i * 142} width={160} height={24} className="eg-column-background" />}
                  <text
                    x={vertical ? layout.width / 2 : 122 + i * 250}
                    y={vertical ? 26 + i * 142 : 24}
                    textAnchor="middle"
                    className="eg-column-label"
                  >
                    {label}
                  </text>
                </g>
              ))}
              {nodes.map((node) => {
                const p = layout.positions.get(node.id)!,
                  related = trace.nodeIds.has(node.id);
                return (
                  <g
                    key={node.id}
                    className={`eg-node eg-${node.kind}${node.id === selectedId ? " is-selected" : ""}${related ? " is-related" : " is-muted"}${node.unavailable ? " is-unavailable" : ""}`}
                    data-node-id={node.id}
                    data-node-kind={node.kind}
                    data-highlighted={related}
                    role="button"
                    tabIndex={0}
                    aria-label={`${names[node.kind]}: ${node.label}`}
                    aria-pressed={node.id === selectedId}
                    onClick={() => select(node)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        select(node);
                      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                        e.preventDefault();
                        setView((v) => ({
                          ...v,
                          x: v.x + (e.key === "ArrowLeft" ? -50 : e.key === "ArrowRight" ? 50 : 0) / v.zoom,
                          y: v.y + (e.key === "ArrowUp" ? -50 : e.key === "ArrowDown" ? 50 : 0) / v.zoom,
                        }));
                      }
                    }}
                    transform={`translate(${p.x},${p.y})`}
                  >
                    <title>{[node.label, node.term?.uri ?? node.fileName ?? node.text?.slice(0, 240)].filter(Boolean).join("\n")}</title>
                    <rect x={-92} y={-26} width={184} height={52} rx={node.kind === "topic" ? 20 : 7} />
                    <text x={-79} y={-11} className="eg-node-kind">
                      {node.unavailable && node.kind === "passage" ? "UNLOCATED QUOTE" : names[node.kind].toUpperCase()}
                    </text>
                    {lines(node.label).map((line, i) => (
                      <text key={i} x={-79} y={5 + i * 15} className="eg-node-label">
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </svg>
            {!nodes.length && <p className="eg-empty">No graph connections were recorded for this build yet.</p>}
          </div>
          <p className="eg-help">
            Click a node to highlight its recorded path. Drag the background to pan; use the controls to zoom. Paths can span several
            topics.
          </p>
        </div>
        <aside className="eg-inspector" aria-label="Graph selection" ref={inspectorRef}>
          <button
            className="ee-text-button eg-mobile-jump"
            type="button"
            onClick={() => svgRef.current?.scrollIntoView({ block: "start" })}
          >
            Back to graph ↑
          </button>
          {selected ? (
            <>
              <span className="ee-eyebrow">{names[selected.kind]}</span>
              <h3>{selected.kind === "passage" ? "Model-cited source passage" : selected.label}</h3>
              <p className="eg-path-counts" role="status" aria-live="polite">
                {amount(count("topic"), "topic")} · {amount(count("chunk"), "chunk")} · {amount(count("passage"), "citation")}
              </p>
              {selected.term && (
                <>
                  <p>{selected.term.definition || "No definition was recorded."}</p>
                  <button className="btn ghost sm" type="button" onClick={() => onInspectTerm(selected.refId)}>
                    Inspect {selected.kind === "class" ? "class" : "property"} evidence
                  </button>
                </>
              )}
              {selected.kind === "topic" && (
                <p>Chunks are grouped by topic. Generated terms and their quoted passages appear as generation steps finish.</p>
              )}
              {selected.kind === "chunk" && (
                <>
                  <p className="ee-source-name">{selected.fileName || "Source filename unavailable"}</p>
                  <p>
                    {selected.text
                      ? readableChunkPreview(selected.text, !!selected.fileName?.endsWith(".xml")).slice(0, 340) +
                        (selected.text.length > 340 ? "…" : "")
                      : "No chunk text was saved."}
                  </p>
                </>
              )}
              {selected.kind === "passage" && (
                <>
                  <blockquote>{selected.text}</blockquote>
                  <p className="ee-note">
                    {selected.unavailable
                      ? "This model quote could not be located in the saved input. No chunk link is assumed."
                      : "The quote was found in the saved input. Human support review is still needed."}
                  </p>
                </>
              )}
              {(selected.kind === "chunk" || selected.kind === "passage") && (
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={!sourceChunk || (selected.kind === "chunk" && selected.unavailable)}
                  onClick={() => sourceChunk && onSource(sourceChunk, selected.citation)}
                >
                  Open saved source
                </button>
              )}
              {trace.associationOnly && (
                <p className="eg-caution">No quote was located in a chunk. Shared inputs are associations, not confirmed support.</p>
              )}
              {trace.hiddenInputs > 0 && (
                <button className="ee-text-button eg-expand-inputs" type="button" onClick={() => setIncludeInputs(true)}>
                  Include {trace.hiddenInputs} shared-input connection{trace.hiddenInputs === 1 ? "" : "s"}
                </button>
              )}
              {topicId && (
                <button className="ee-text-button eg-topic-link" type="button" onClick={() => onTopic(topicId, sourceChunk)}>
                  Show in topic view
                </button>
              )}
              {!!quotes.length && selected.kind !== "passage" && (
                <section className="eg-related-quotes">
                  <h4>Source passages</h4>
                  {quotes.map((q) => (
                    <button type="button" key={q.id} onClick={() => select(q)}>
                      <span>
                        {q.text?.slice(0, 130)}
                        {(q.text?.length ?? 0) > 130 ? "…" : ""}
                      </span>
                      <small>{q.unavailable ? "Location unverified" : "Quote located in saved input"}</small>
                    </button>
                  ))}
                </section>
              )}
              {!trace.edgeIds.size && (
                <p className="ee-note">
                  No generation links were recorded for this term. It may come from a starting ontology or a manual edit.
                </p>
              )}
              <details className="ee-details">
                <summary>What the links mean</summary>
                <p>
                  Grouping and origin links come from the saved build. Shared inputs show that text was sent to the same generation step.
                  Model-cited passages are claimed support; a located quote is not a human review.
                </p>
              </details>
            </>
          ) : (
            <p className="ee-empty">Select a topic, chunk, class or property to explore its connections.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
