import type { StylesheetStyle, LayoutOptions } from "cytoscape";

/** Read a CSS custom property off :root (theme-aware). */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export type EdgeLabelMode = "auto" | "all" | "off";

/** Above this element count the graph drops decorations that cost per-frame work. */
export const LARGE_GRAPH = 300;

/**
 * Cytoscape stylesheet. `large` strips gradients, transitions and text outlines:
 * at a few hundred elements those are the difference between a smooth canvas and
 * a visibly janky one, and they add nothing at that density.
 */
export function buildStylesheet(edgeLabels: EdgeLabelMode = "auto", large = false): StylesheetStyle[] {
  const ink = token("--ink", "#000000");
  const bg = token("--bg", "#ffffff");
  const faint = token("--ink-soft", "rgba(0,0,0,0.55)");
  const lineMono = token("--line-strong", "rgba(0,0,0,0.18)");

  const nodeStyle: Record<string, unknown> = {
    width: "data(size)",
    height: "data(size)",
    shape: "data(shape)",
    "border-color": "data(border)",
    "border-width": 1.5,
    "border-opacity": 0.9,
    label: "data(label)",
    color: ink,
    "font-family": "JetBrains Mono, monospace",
    "font-size": 9.5,
    "font-weight": 500,
    "text-valign": "bottom",
    "text-halign": "center",
    "text-margin-y": 5,
    "text-max-width": "130px",
    "text-wrap": "ellipsis",
    "min-zoomed-font-size": large ? 11 : 8,
  };
  if (large) {
    nodeStyle["background-color"] = "data(color)";
  } else {
    nodeStyle["background-fill"] = "linear-gradient";
    nodeStyle["background-gradient-stop-colors"] = "data(grad)";
    nodeStyle["background-gradient-direction"] = "to-bottom-right";
    nodeStyle["text-outline-color"] = bg;
    nodeStyle["text-outline-width"] = 2.4;
    nodeStyle["text-outline-opacity"] = 1;
    nodeStyle["transition-property"] = "opacity, border-width, width, height";
    nodeStyle["transition-duration"] = "140ms";
  }

  const edgeStyle: Record<string, unknown> = {
    width: 1.6,
    "line-color": "data(color)",
    "line-opacity": 0.6,
    "target-arrow-color": "data(color)",
    "target-arrow-shape": "triangle",
    "arrow-scale": 0.85,
    "curve-style": large ? "straight" : "bezier",
    label: edgeLabels === "all" ? "data(label)" : "",
    color: faint,
    "font-family": "JetBrains Mono, monospace",
    "font-size": 8,
    "text-rotation": "autorotate",
    "text-background-color": bg,
    "text-background-opacity": 0.9,
    "text-background-padding": "2px",
    "text-outline-opacity": 0,
    "min-zoomed-font-size": 9,
  };
  if (!large) {
    edgeStyle["transition-property"] = "opacity, width, line-opacity";
    edgeStyle["transition-duration"] = "140ms";
  }

  const styles: StylesheetStyle[] = [
    { selector: "node", style: nodeStyle },
    { selector: "edge", style: edgeStyle },
  ] as StylesheetStyle[];

  if (edgeLabels === "auto") {
    styles.push({ selector: "edge.hovered, edge:selected, edge.highlighted, edge.lbl", style: { label: "data(label)", "line-opacity": 1 } } as StylesheetStyle);
  }

  styles.push(
    ...([
      {
        selector: "node.hovered, node:selected",
        style: { "border-width": 3.5, "border-color": ink, "underlay-color": "data(color)", "underlay-opacity": 0.28, "underlay-padding": 9, "z-index": 50 },
      },
      {
        selector: "node.highlighted",
        style: {
          "border-width": 4,
          "border-color": ink,
          "underlay-color": "data(color)",
          "underlay-opacity": 0.4,
          "underlay-padding": 12,
          "z-index": 99,
          "font-size": 11,
        },
      },
      { selector: "edge:selected, edge.highlighted", style: { "line-opacity": 1, width: 2.6, "z-index": 90, color: ink } },
      { selector: ".nb-dim", style: { opacity: 0.12 } },
      { selector: ".faded", style: { opacity: 0.1 } },
      { selector: ".hidden", style: { display: "none" } },
      { selector: "edge[!color]", style: { "line-color": lineMono, "target-arrow-color": lineMono, "line-opacity": 0.75 } },
    ] as StylesheetStyle[]),
  );

  return styles;
}

/** Layout factories. `seeded` keeps existing positions instead of scrambling them. */
export const LAYOUTS: Record<string, (opts?: { animate?: boolean; seeded?: boolean }) => LayoutOptions> = {
  fcose: (o) =>
    ({
      name: "fcose",
      animate: o?.animate ?? true,
      animationDuration: 600,
      // Seeding from current positions is what stops a small edit from
      // rearranging the whole graph and destroying the user's mental map.
      randomize: !o?.seeded,
      packComponents: true,
      nodeSeparation: 110,
      idealEdgeLength: 110,
      nodeRepulsion: 8000,
      gravity: 0.25,
      padding: 45,
    }) as unknown as LayoutOptions,
  dagre: (o) => ({ name: "dagre", rankDir: "TB", nodeSep: 45, rankSep: 75, animate: o?.animate ?? true, padding: 45 }) as unknown as LayoutOptions,
  concentric: (o) =>
    ({
      name: "concentric",
      animate: o?.animate ?? true,
      padding: 45,
      minNodeSpacing: 40,
      concentric: (n: { degree: () => number }) => n.degree(),
      levelWidth: () => 2,
    }) as unknown as LayoutOptions,
  circle: (o) => ({ name: "circle", animate: o?.animate ?? true, padding: 45 }) as unknown as LayoutOptions,
  grid: (o) => ({ name: "grid", animate: o?.animate ?? true, padding: 45 }) as unknown as LayoutOptions,
  breadthfirst: (o) => ({ name: "breadthfirst", animate: o?.animate ?? true, padding: 45, spacingFactor: 1.15 }) as unknown as LayoutOptions,
};

export const LAYOUT_LABELS: Record<string, string> = {
  fcose: "Force (fCoSE)",
  dagre: "Hierarchy",
  concentric: "Concentric (hubs)",
  circle: "Circle",
  grid: "Grid",
  breadthfirst: "Tree",
};
