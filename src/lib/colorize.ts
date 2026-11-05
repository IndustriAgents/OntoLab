import type { GraphModel } from "./graph";

export const MONO = "__mono__";
export const DEGREE = "__degree__";
export const NODE_ID = "__node__";

const NODE_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#14b8a6", "#eab308", "#8b5cf6", "#10b981",
  "#e11d48", "#0ea5e9", "#84cc16", "#d946ef",
];

const EDGE_PALETTE = [
  "#60a5fa", "#f87171", "#4ade80", "#fbbf24", "#c084fc", "#f472b6",
  "#22d3ee", "#fb923c", "#2dd4bf", "#facc15", "#a78bfa", "#34d399",
];

const SHAPES = [
  "ellipse", "round-rectangle", "round-hexagon", "round-diamond",
  "round-triangle", "round-pentagon", "round-octagon", "round-tag",
];

const OTHER_COLOR = "#9ca3af";
const MIN_SIZE = 20;
const MAX_SIZE = 60;

export type ColorBy = string;

export interface NodeVisual {
  grad: string;
  color: string;
  border: string;
  shape: string;
  size: number;
  cat: string;
}

export interface LegendItem {
  label: string;
  color: string;
  shape: string;
  count: number;
}

export interface Visuals {
  colorBy: ColorBy;
  field: string;
  node: Map<string, NodeVisual>;
  edge: Map<string, string>;
  legend: LegendItem[];
  legendKind: "category" | "degree" | "mono" | "node";
}

function darken(hex: string, amt: number): string {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  const r = Math.round(parseInt(full.slice(0, 2), 16) * (1 - amt));
  const g = Math.round(parseInt(full.slice(2, 4), 16) * (1 - amt));
  const b = Math.round(parseInt(full.slice(4, 6), 16) * (1 - amt));
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function nodeVisual(color: string, shape: string, size: number, cat = ""): NodeVisual {
  const color2 = darken(color, 0.24);
  return { color, grad: `${color} ${color2}`, border: darken(color, 0.4), shape, size, cat };
}

function degrees(model: GraphModel): Map<string, number> {
  const d = new Map<string, number>();
  for (const n of model.nodes) d.set(n.id, 0);
  for (const e of model.edges) {
    d.set(e.source, (d.get(e.source) ?? 0) + 1);
    d.set(e.target, (d.get(e.target) ?? 0) + 1);
  }
  return d;
}

function sizeFor(deg: number, min: number, max: number): number {
  if (max <= min) return 30;
  const t = (Math.sqrt(deg) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
  return Math.round(MIN_SIZE + t * (MAX_SIZE - MIN_SIZE));
}

export function computeVisuals(model: GraphModel, colorBy: ColorBy, _theme: "light" | "dark"): Visuals {
  void _theme;
  const deg = degrees(model);
  const degVals = [...deg.values()];
  const minDeg = degVals.length ? Math.min(...degVals) : 0;
  const maxDeg = degVals.length ? Math.max(...degVals) : 0;

  const node = new Map<string, NodeVisual>();
  const edge = new Map<string, string>();
  const legend: LegendItem[] = [];

  const edgeLabels = [...new Set(model.edges.map((e) => e.label || "—"))];
  const edgeColorOf = new Map<string, string>();
  edgeLabels.forEach((l, i) => edgeColorOf.set(l, EDGE_PALETTE[i % EDGE_PALETTE.length]));
  if (colorBy !== MONO) {
    for (const e of model.edges) edge.set(e.id, edgeColorOf.get(e.label || "—")!);
  }

  let legendKind: Visuals["legendKind"] = "category";
  let field = colorBy;

  if (colorBy === MONO) {
    legendKind = "mono";
    field = "Monochrome";
    for (const n of model.nodes) {
      node.set(n.id, nodeVisual(OTHER_COLOR, "ellipse", sizeFor(deg.get(n.id) ?? 0, minDeg, maxDeg)));
    }
  } else {
    // categorical by a node prop (default: rdf:type)
    const values = [...new Set(model.nodes.map((n) => n.props[colorBy]).filter(Boolean) as string[])];
    const colorOf = new Map<string, string>();
    const shapeOf = new Map<string, string>();
    values.forEach((v, i) => {
      colorOf.set(v, NODE_PALETTE[i % NODE_PALETTE.length]);
      shapeOf.set(v, SHAPES[i % SHAPES.length]);
    });
    const countOf = new Map<string, number>();
    let otherCount = 0;
    for (const n of model.nodes) {
      const v = n.props[colorBy];
      const d = deg.get(n.id) ?? 0;
      if (v && colorOf.has(v)) {
        node.set(n.id, nodeVisual(colorOf.get(v)!, shapeOf.get(v)!, sizeFor(d, minDeg, maxDeg), v));
        countOf.set(v, (countOf.get(v) ?? 0) + 1);
      } else {
        node.set(n.id, nodeVisual(OTHER_COLOR, "ellipse", sizeFor(d, minDeg, maxDeg), "Other"));
        otherCount += 1;
      }
    }
    for (const v of values) {
      legend.push({ label: v, color: colorOf.get(v)!, shape: shapeOf.get(v)!, count: countOf.get(v) ?? 0 });
    }
    legend.sort((a, b) => b.count - a.count);
    if (otherCount) legend.push({ label: "Other", color: OTHER_COLOR, shape: "ellipse", count: otherCount });
  }

  return { colorBy, field, node, edge, legend, legendKind };
}
