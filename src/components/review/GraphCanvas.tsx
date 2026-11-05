import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import dagre from "cytoscape-dagre";
import type { GraphModel } from "../../lib/graph";
import type { Visuals } from "../../lib/colorize";
import { buildStylesheet, LAYOUTS, LARGE_GRAPH, type EdgeLabelMode } from "../../lib/cytoStyle";

cytoscape.use(fcose);
cytoscape.use(dagre);

interface Props {
  model: GraphModel;
  visuals: Visuals;
  layout: string;
  theme: "light" | "dark";
  edgeLabels: EdgeLabelMode;
  /** externally selected individual (from the table or an issue list) */
  selectedId?: string | null;
  onSelect: (sel: { kind: "node" | "edge"; id: string } | null) => void;
  /** bumped by the parent to force a fresh layout */
  relayoutKey?: number;
}

function degreeMap(model: GraphModel): Map<string, number> {
  const d = new Map<string, number>();
  for (const n of model.nodes) d.set(n.id, 0);
  for (const e of model.edges) {
    d.set(e.source, (d.get(e.source) ?? 0) + 1);
    d.set(e.target, (d.get(e.target) ?? 0) + 1);
  }
  return d;
}

function nodeData(n: GraphModel["nodes"][number], visuals: Visuals, deg: Map<string, number>) {
  const v = visuals.node.get(n.id);
  return {
    id: n.id,
    label: n.label,
    grad: v?.grad,
    color: v?.color,
    border: v?.border,
    shape: v?.shape ?? "ellipse",
    size: v?.size ?? 28,
    deg: deg.get(n.id) ?? 0,
  };
}

export function GraphCanvas({ model, visuals, layout, theme, edgeLabels, selectedId, onSelect, relayoutKey = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const largeRef = useRef(false);

  // init once
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStylesheet("auto"),
      wheelSensitivity: 0.2,
      minZoom: 0.04,
      maxZoom: 4,
      // Cheap wins on big graphs; harmless on small ones.
      textureOnViewport: true,
      pixelRatio: 1,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (ev) => onSelect({ kind: "node", id: ev.target.id() }));
    cy.on("tap", "edge", (ev) => onSelect({ kind: "edge", id: ev.target.id() }));
    cy.on("tap", (ev) => {
      if (ev.target === cy) onSelect(null);
    });
    cy.on("mouseover", "node", (ev) => {
      // On a large graph, restyling every element per hover is the main source
      // of jank — the neighbourhood highlight is skipped there.
      if (largeRef.current) return;
      const n = ev.target;
      cy.batch(() => {
        cy.elements().addClass("nb-dim");
        n.closedNeighborhood().removeClass("nb-dim");
        n.addClass("hovered");
        n.connectedEdges().addClass("lbl");
      });
    });
    cy.on("mouseout", "node", () => {
      if (largeRef.current) return;
      cy.elements().removeClass("nb-dim hovered lbl");
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // onSelect is stable enough for a one-time wiring; re-initialising the
    // canvas on every parent render would destroy the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply the model as a DIFF: add new elements, remove departed ones, update
   * changed data, and lay out only what is new. Previously every A-Box edit did
   * `remove()` + `add()` + a randomised layout, so the whole graph jumped and
   * the user lost track of where everything was.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const deg = degreeMap(model);
    const wasEmpty = cy.elements().empty();
    const total = model.nodes.length + model.edges.length;
    const large = total > LARGE_GRAPH;
    if (large !== largeRef.current) {
      largeRef.current = large;
      cy.style(buildStylesheet(edgeLabels, large));
    }

    const wantNodes = new Set(model.nodes.map((n) => n.id));
    const wantEdges = new Set(model.edges.map((e) => e.id));
    const added: ElementDefinition[] = [];

    cy.batch(() => {
      for (const el of cy.elements().toArray()) {
        const id = el.id();
        if (el.isNode() ? !wantNodes.has(id) : !wantEdges.has(id)) el.remove();
      }
      for (const n of model.nodes) {
        const data = nodeData(n, visuals, deg);
        const existing = cy.getElementById(n.id);
        if (existing.nonempty()) existing.data(data);
        else added.push({ group: "nodes", data });
      }
      for (const e of model.edges) {
        const color = visuals.edge.get(e.id);
        const data: Record<string, unknown> = { id: e.id, source: e.source, target: e.target, label: e.label ?? "" };
        if (color) data.color = color;
        const existing = cy.getElementById(e.id);
        if (existing.nonempty()) existing.data(data);
        else added.push({ group: "edges", data: data as ElementDefinition["data"] });
      }
      if (added.length) cy.add(added);
    });

    if (!added.length && !wasEmpty) return; // pure data update: keep positions

    const make = LAYOUTS[layoutRef.current] ?? LAYOUTS.fcose;
    if (wasEmpty) {
      cy.layout(make({ animate: !large })).run();
    } else {
      // Seed from current positions so existing nodes barely move.
      cy.layout(make({ animate: false, seeded: true })).run();
    }
    // `visuals` and `edgeLabels` are handled by their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // recolour in place when visuals change (no layout)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.elements().empty()) return;
    const deg = degreeMap(model);
    cy.batch(() => {
      for (const n of cy.nodes()) {
        const v = visuals.node.get(n.id());
        if (!v) continue;
        n.data({ grad: v.grad, color: v.color, border: v.border, shape: v.shape, size: v.size, deg: deg.get(n.id()) ?? 0 });
      }
      for (const e of cy.edges()) {
        const color = visuals.edge.get(e.id());
        if (color) e.data("color", color);
        else e.removeData("color");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visuals]);

  // Keep Cytoscape's idea of the viewport in step with the container (panels
  // opening, window resizes). A canvas created before its container had a
  // size would otherwise draw the whole graph into a corner.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = { w: el.clientWidth, h: el.clientHeight };
    const ro = new ResizeObserver(() => {
      const cy = cyRef.current;
      if (!cy) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === last.w && h === last.h) return;
      const wasTiny = last.w < 50 || last.h < 50;
      last = { w, h };
      cy.resize();
      if (wasTiny && cy.elements().nonempty()) cy.fit(undefined, 40);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // explicit layout change / re-layout request
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.elements().empty()) return;
    const make = LAYOUTS[layout] ?? LAYOUTS.fcose;
    cy.layout(make({ animate: !largeRef.current })).run();
  }, [layout, relayoutKey]);

  // rebuild style on theme / edge-label change
  useEffect(() => {
    cyRef.current?.style(buildStylesheet(edgeLabels, largeRef.current));
  }, [theme, edgeLabels]);

  // follow a selection made elsewhere (table row, validation issue, chat citation)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("highlighted");
    if (!selectedId) return;
    const node = cy.getElementById(selectedId);
    if (node.empty()) return;
    node.addClass("highlighted");
    cy.animate({ center: { eles: node }, duration: 250 });
  }, [selectedId]);

  return <div className="cy" ref={containerRef} />;
}
