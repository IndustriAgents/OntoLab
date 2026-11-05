// SPDX-License-Identifier: Apache-2.0
// Modified for OntoLab from the Helix Foundry Explorer.
// Individuals as dots coloured by class and their object properties as lines,
// laid out by a force simulation on a canvas. Hover shows an individual's
// links, click selects it, double-click (or "Show what's around it") focuses
// the neighbourhood. Adapted from the Helix Foundry Explorer graph
// (Apache-2.0).

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { IconArrowRight, IconClose, IconMaximize, IconMinus, IconPlus, IconSearch } from "../../components/icons";
import { typeHue } from "./typeColors";
import "./graph.css";

export type GraphNode = { id: string; type: string; label: string; degree: number };
export type GraphEdge = { from: string; to: string; name: string };
type Node = GraphNode & SimulationNodeDatum & { r: number };
type Link = SimulationLinkDatum<Node> & { name: string };
type View = { x: number; y: number; k: number };

const PANEL_W = 324;

export function ForceGraph({
  nodes: data,
  edges: dataEdges,
  all,
  total,
  theme,
  hidden,
  onToggleType,
  selectedId,
  onSelect,
  onOpen,
  showPanel = true,
  focus = null,
  onFocus,
  onFocusHops,
  noun = { one: "individual", many: "individuals" },
  neutral,
  emphasis = null,
  panelExtra,
  toolbar,
  compactLegend = false,
}: {
  /** what to draw: the filtered (and capped) individuals */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** every individual, for search */
  all: GraphNode[];
  /** individuals matching the filters before the cap */
  total: number;
  theme: "light" | "dark";
  hidden: Set<string>;
  onToggleType: (type: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** "Open details" in the panel; absent = no button */
  onOpen?: (id: string) => void;
  /** false while the full inspector is open beside the graph */
  showPanel?: boolean;
  /** neighbourhood focus; absent = no "Show what's around it" and no double-click */
  focus?: { id: string; label: string; hops: number } | null;
  onFocus?: (id: string | null) => void;
  onFocusHops?: (hops: number) => void;
  /** what a node is called in the copy */
  noun?: { one: string; many: string };
  /** classes drawn in neutral grey rather than given a palette colour */
  neutral?: Set<string>;
  /** when set, everything else is faded (e.g. what one query produced) */
  emphasis?: Set<string> | null;
  /** extra rows in the detail panel for the selected node */
  panelExtra?: (id: string) => ReactNode;
  /** controls shown after the class chips */
  toolbar?: ReactNode;
  /** Put class filters in an optional panel so the graph keeps its height. */
  compactLegend?: boolean;
}) {
  const legendId = useId();
  const [classesOpen, setClassesOpen] = useState(false);
  useEffect(() => {
    if (!compactLegend || !classesOpen) return;
    const closeClasses = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClassesOpen(false);
    };
    window.addEventListener("keydown", closeClasses);
    return () => window.removeEventListener("keydown", closeClasses);
  }, [compactLegend, classesOpen]);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [search, setSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Simulation<Node, Link> | null>(null);
  const nodes = useRef<Node[]>([]);
  const links = useRef<Link[]>([]);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const frame = useRef(0);

  const types = useMemo(() => [...new Set(data.map((n) => n.type))].sort(), [data]);
  // Neutral classes (values, classes in an evidence graph) stay grey and take no palette slot.
  const paletteTypes = useMemo(() => types.filter((t) => !neutral?.has(t)), [types, neutral]);
  const hueOf = (type: string) => (neutral?.has(type) ? "" : typeHue(paletteTypes, type, theme));
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of data) c.set(n.type, (c.get(n.type) ?? 0) + 1);
    return c;
  }, [data]);
  const byId = useMemo(() => new Map(data.map((n) => [n.id, n])), [data]);
  const neighbours = useMemo(() => {
    const m = new Map<string, { node: GraphNode; name: string }[]>();
    const add = (a: string, node: GraphNode, name: string) => {
      if (!m.has(a)) m.set(a, []);
      m.get(a)!.push({ node, name });
    };
    for (const e of dataEdges) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) continue;
      add(e.from, to, e.name);
      add(e.to, from, e.name);
    }
    return m;
  }, [dataEdges, byId]);

  // Drawing and the pointer handlers are bound once; they read the latest
  // state and helpers through this ref.
  const live = useRef({ hidden, selected: selectedId, hover: null as string | null, hueOf, emphasis });
  live.current = { hidden, selected: selectedId, hover: hover?.id ?? null, hueOf, emphasis };

  const draw = () => {
    frame.current = 0;
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const { x, y, k } = view.current;
    const style = getComputedStyle(c);
    const token = (name: string) => style.getPropertyValue(name).trim();
    const { hidden, selected, hover, hueOf, emphasis } = live.current;
    const strong = (id: string) => !emphasis || emphasis.has(id);
    const active = hover || selected;
    const near = new Set<string>(active ? [active] : []);
    if (active)
      for (const l of links.current) {
        const s = (l.source as Node).id;
        const t = (l.target as Node).id;
        if (s === active) near.add(t);
        if (t === active) near.add(s);
      }
    const shown = (n: Node) => !hidden.has(n.type);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    // Links: thin and recessive; a hovered or selected individual's links stand out.
    for (const l of links.current) {
      const s = l.source as Node;
      const t = l.target as Node;
      if (!shown(s) || !shown(t)) continue;
      const lit = !!active && (s.id === active || t.id === active);
      ctx.strokeStyle = lit ? token("--hf-text-2") : token("--hf-border-strong");
      ctx.globalAlpha = lit ? 0.9 : active ? 0.12 : strong(s.id) && strong(t.id) ? 0.55 : 0.08;
      ctx.lineWidth = (lit ? 1.6 : 1) / k;
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
    }
    // Individuals: a surface ring keeps overlapping dots apart.
    const surface = token("--hf-surface");
    const faint = token("--hf-faint");
    for (const n of nodes.current) {
      if (!shown(n)) continue;
      ctx.globalAlpha = active && !near.has(n.id) ? 0.2 : !active && !strong(n.id) ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fillStyle = hueOf(n.type) || faint;
      ctx.fill();
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = surface;
      ctx.stroke();
      if (n.id === selected) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 3 / k, 0, Math.PI * 2);
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = token("--hf-ink");
        ctx.stroke();
      }
    }
    // Labels with a surface halo, for the individuals in play or, once zoomed
    // in, for every one. The most important go first; a label that would
    // overlap one already placed is left out.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.font = `12px ${token("--hf-font-sans") || "sans-serif"}`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = surface;
    // Helix labels everything once zoomed in; a small graph is labelled throughout.
    const every = k >= 1.8 || nodes.current.filter(shown).length <= 30;
    const rank = (n: Node) => (n.id === active ? 3 : n.id === selected ? 2 : n.degree / 1e6);
    const labelled = nodes.current
      .filter((n) => shown(n) && (n.id === selected || (active ? near.has(n.id) : every)))
      .sort((a, b) => rank(b) - rank(a));
    const placed: number[][] = [];
    if (active) {
      ctx.font = `11px ${token("--hf-font-sans") || "sans-serif"}`;
      ctx.textAlign = "center";
      for (const l of links.current) {
        const a = l.source as Node;
        const b = l.target as Node;
        if (!l.name || (a.id !== active && b.id !== active) || !shown(a) || !shown(b)) continue;
        const mx = ((a.x! + b.x!) / 2) * k + x;
        const my = ((a.y! + b.y!) / 2) * k + y;
        const wdt = ctx.measureText(l.name).width;
        const box = [mx - wdt / 2 - 2, my - 7, mx + wdt / 2 + 2, my + 7];
        if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
        placed.push(box);
        ctx.strokeText(l.name, mx, my);
        ctx.fillStyle = token("--hf-muted");
        ctx.fillText(l.name, mx, my);
      }
      ctx.textAlign = "start";
      ctx.font = `12px ${token("--hf-font-sans") || "sans-serif"}`;
    }
    for (const n of labelled) {
      const sx = n.x! * k + x;
      const sy = n.y! * k + y;
      if (sx < -200 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      const text = n.label.length > 32 ? n.label.slice(0, 31) + "…" : n.label;
      const lx = sx + n.r * k + 4;
      const box = [lx - 2, sy - 8, lx + ctx.measureText(text).width + 2, sy + 8];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      ctx.strokeText(text, lx, sy);
      ctx.fillStyle = n.id === active ? token("--hf-text") : token("--hf-text-2");
      ctx.fillText(text, lx, sy);
    }
  };
  const redraw = () => {
    if (!frame.current) frame.current = requestAnimationFrame(() => fn.current.draw());
  };
  // The detail panel covers the right of the stage while an individual is open.
  const stageWidth = () => size.current.w - (live.current.selected && size.current.w > 720 ? PANEL_W : 0);
  const fit = () => {
    const list = nodes.current.filter((n) => !live.current.hidden.has(n.type));
    const w = stageWidth();
    const { h } = size.current;
    if (!list.length || !w) return;
    const xs = list.map((n) => n.x!);
    const ys = list.map((n) => n.y!);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(2.5, Math.max(0.1, Math.min(w / (x1 - x0 + 120), h / (y1 - y0 + 120))));
    view.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    redraw();
  };
  const zoom = (factor: number, cx = size.current.w / 2, cy = size.current.h / 2) => {
    const v = view.current;
    const k = Math.min(6, Math.max(0.1, v.k * factor));
    view.current = { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    redraw();
  };
  const centre = (id: string) => {
    const n = nodes.current.find((n) => n.id === id);
    if (!n) return;
    const k = Math.max(view.current.k, 1.4);
    const w = size.current.w - (size.current.w > 720 ? PANEL_W : 0);
    view.current = { k, x: w / 2 - n.x! * k, y: size.current.h / 2 - n.y! * k };
    redraw();
  };
  const fn = useRef({ draw, redraw, fit, zoom, centre });
  fn.current = { draw, redraw, fit, zoom, centre };

  // Lay out a new graph, keeping individuals that were already on screen in place.
  useEffect(() => {
    const previous = new Map(nodes.current.map((n) => [n.id, n]));
    const list: Node[] = data.map((n) => ({
      ...n,
      r: 4 + Math.min(9, Math.sqrt(n.degree) * 1.5),
      x: previous.get(n.id)?.x,
      y: previous.get(n.id)?.y,
    }));
    const ids = new Set(list.map((n) => n.id));
    const edges: Link[] = dataEdges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ source: e.from, target: e.to, name: e.name }));
    // Each class gathers around its own point on a circle, so classes read as
    // regions and the links between them as the lines that cross.
    const spread = 60 + Math.sqrt(list.length) * 9;
    const anchor = new Map(
      types.map((t, i) => {
        const a = (i / Math.max(types.length, 1)) * Math.PI * 2 - Math.PI / 2;
        return [t, types.length > 1 ? { x: Math.cos(a) * spread, y: Math.sin(a) * spread } : { x: 0, y: 0 }];
      }),
    );
    sim.current?.stop();
    const s = forceSimulation<Node, Link>(list)
      .force(
        "link",
        forceLink<Node, Link>(edges)
          .id((n) => n.id)
          .distance(28)
          .strength(0.35),
      )
      .force("charge", forceManyBody<Node>().strength(-26).distanceMax(260))
      .force("x", forceX<Node>((n) => anchor.get(n.type)!.x).strength(0.06))
      .force("y", forceY<Node>((n) => anchor.get(n.type)!.y).strength(0.06))
      .force(
        "collide",
        forceCollide<Node>((n) => n.r + 1.5),
      )
      .stop();
    const changed = list.length !== previous.size || list.some((n) => !previous.has(n.id));
    for (let i = 0; i < (previous.size ? 60 : 180); i++) s.tick();
    nodes.current = list;
    links.current = edges;
    sim.current = s;
    if (changed) fn.current.fit();
    s.alpha(0.12)
      .on("tick", () => fn.current.redraw())
      .restart();
    return () => {
      s.stop();
    };
  }, [data, dataEdges, types]);

  // The canvas follows its container.
  useEffect(() => {
    const c = canvas.current;
    const w = wrap.current;
    if (!c || !w) return;
    const resize = () => {
      const r = w.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = !size.current.w;
      size.current = { w: r.width, h: r.height };
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = r.width + "px";
      c.style.height = r.height + "px";
      if (first) fn.current.fit();
      fn.current.redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(w);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);
  const hoverId = hover?.id ?? null;
  useEffect(() => fn.current.redraw(), [hidden, selectedId, hoverId, types, theme, emphasis, neutral]);
  // A selection made elsewhere (the table, search, the panel) comes into view;
  // one clicked on the canvas stays where it is.
  const clicked = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId && selectedId !== clicked.current) fn.current.centre(selectedId);
    clicked.current = null;
  }, [selectedId]);

  // Wheel zooms around the pointer; dragging an individual moves it, dragging
  // the background pans; a click without movement selects or clears.
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const point = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hit = (p: { x: number; y: number }) => {
      const v = view.current;
      const gx = (p.x - v.x) / v.k;
      const gy = (p.y - v.y) / v.k;
      let best: Node | undefined;
      let bestD = Infinity;
      for (const n of nodes.current) {
        if (live.current.hidden.has(n.type)) continue;
        const d = Math.hypot(n.x! - gx, n.y! - gy);
        if (d < n.r + 5 / v.k && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    let drag: { node?: Node; start: { x: number; y: number }; moved: boolean } | undefined;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = point(e);
      drag = { node: hit(p), start: p, moved: false };
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const p = point(e);
      if (!drag) {
        const n = hit(p);
        c.style.cursor = n ? "pointer" : "grab";
        setHover((h) => (n ? { id: n.id, x: p.x, y: p.y } : h === null ? h : null));
        return;
      }
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        setHover(null);
      }
      c.style.cursor = "grabbing";
      if (drag.node) {
        const v = view.current;
        drag.node.fx = (p.x - v.x) / v.k;
        drag.node.fy = (p.y - v.y) / v.k;
        sim.current?.alphaTarget(0.15).restart();
      } else {
        view.current = { ...view.current, x: view.current.x + e.movementX, y: view.current.y + e.movementY };
        fn.current.redraw();
      }
    };
    const up = () => {
      if (!drag) return;
      if (drag.node && drag.moved) {
        drag.node.fx = null;
        drag.node.fy = null;
        sim.current?.alphaTarget(0);
      }
      if (!drag.moved) {
        clicked.current = drag.node?.id ?? null;
        select.current(drag.node?.id ?? null);
      }
      drag = undefined;
      c.style.cursor = "grab";
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e);
      fn.current.zoom(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    };
    const leave = () => setHover(null);
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
    };
  }, []);

  // Find: any individual, drawn or not. One outside the graph is shown with
  // what's around it.
  const term = search.trim().toLowerCase();
  const matches = term ? all.filter((n) => n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term)).slice(0, 8) : [];
  const matchTotal = term ? all.filter((n) => n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term)).length : 0;
  const choose = (n: GraphNode) => {
    if (hidden.has(n.type)) onToggleType(n.type);
    if (!byId.has(n.id)) onFocus?.(n.id);
    onSelect(n.id);
    setSearch("");
  };

  const current = selectedId ? byId.get(selectedId) : undefined;
  const hovered = hover ? byId.get(hover.id) : undefined;
  // Linked individuals by class and property, e.g. "Party · hasParty".
  const grouped = current
    ? [
        ...(neighbours.get(current.id) ?? [])
          .reduce((m, x) => {
            const key = x.node.type + "\u0000" + x.name;
            if (!m.has(key)) m.set(key, []);
            m.get(key)!.push(x.node);
            return m;
          }, new Map<string, GraphNode[]>())
          .entries(),
      ].map(([key, list]) => {
        const [type, name] = key.split("\u0000");
        return { key, type, name, list };
      })
    : [];

  return (
    <div className={`og${compactLegend ? " compact-legend" : ""}`}>
      <div className="og-bar">
        <div className="og-search">
          <label className="search">
            <IconSearch />
            <span className="sr-only">Find {article(noun.one)}</span>
            <input
              type="search"
              value={search}
              placeholder={`Find ${article(noun.one)}`}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={matches.length ? "graph-matches" : undefined}
              aria-expanded={matches.length > 0}
              aria-activedescendant={matches.length ? `graph-match-${Math.min(matchIndex, matches.length - 1)}` : undefined}
              onChange={(e) => {
                setSearch(e.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches.length) {
                  e.preventDefault();
                  choose(matches[Math.min(matchIndex, matches.length - 1)]);
                }
                if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
                  e.preventDefault();
                  setMatchIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
                }
                if (e.key === "Escape") setSearch("");
              }}
            />
          </label>
          {matches.length > 0 && (
            <ul id="graph-matches" className="og-matches" role="listbox" aria-label={`Matching ${noun.many}`}>
              {matches.map((n, i) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="option"
                    id={`graph-match-${i}`}
                    aria-selected={i === Math.min(matchIndex, matches.length - 1)}
                    onClick={() => choose(n)}
                  >
                    <span className="og-dot" style={{ background: hueOf(n.type) || undefined }} aria-hidden="true" />
                    <span className="og-match-name">{n.label}</span>
                    <small>{n.type}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {term && (
            <p className="og-search-status" role="status">
              {matches.length ? `${matchTotal} matching${matchTotal > 8 ? " · showing the first 8" : ""}` : `No matching ${noun.many}`}
            </p>
          )}
        </div>
        {compactLegend && (
          <button
            type="button"
            className="btn ghost sm og-class-toggle"
            aria-expanded={classesOpen}
            aria-controls={legendId}
            onClick={() => setClassesOpen((value) => !value)}
          >
            Classes{" "}
            <span>
              {types.length}
              {hidden.size ? ` · ${hidden.size} hidden` : ""}
            </span>
          </button>
        )}
        {(!compactLegend || classesOpen) && (
          <div className={compactLegend ? "og-classes-panel" : "og-class-list"} id={legendId}>
            {compactLegend && (
              <div className="og-classes-heading">
                <span>Show classes in the graph</span>
                <button type="button" className="icon-btn sm" aria-label="Close class filters" onClick={() => setClassesOpen(false)}>
                  <IconClose />
                </button>
              </div>
            )}
            <ul className="og-legend" aria-label="Classes">
              {types.map((t) => {
                const off = hidden.has(t);
                return (
                  <li key={t}>
                    <button
                      type="button"
                      aria-pressed={!off}
                      className={"og-type" + (off ? " is-off" : "")}
                      title={off ? `Show ${t}` : `Hide ${t}`}
                      onClick={() => onToggleType(t)}
                    >
                      <span className="og-dot" style={{ background: hueOf(t) || undefined }} aria-hidden="true" />
                      {t}
                      <span className="og-count">{counts.get(t) ?? 0}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {toolbar}
      </div>
      <p className="og-scope">
        {focus && onFocus ? (
          <>
            Individuals within{" "}
            <select className="og-hops" aria-label="Links away" value={focus.hops} onChange={(e) => onFocusHops?.(Number(e.target.value))}>
              {[1, 2, 3].map((h) => (
                <option key={h} value={h}>
                  {h} {h === 1 ? "link" : "links"}
                </option>
              ))}
            </select>{" "}
            of <strong>{focus.label}</strong> · {data.length} individuals
            <button type="button" className="og-link" onClick={() => onFocus(null)}>
              Show every individual
            </button>
          </>
        ) : !onFocus ? (
          <>
            {data.length} {data.length === 1 ? noun.one : noun.many} · {dataEdges.length} {dataEdges.length === 1 ? "link" : "links"}. Hover
            a {noun.one} to see its links, click it for details.
          </>
        ) : data.length < total ? (
          <>
            {data.length} of {total} individuals: the best-connected. Double-click an individual to see everything around it. Find searches
            every individual.
          </>
        ) : (
          <>
            {data.length} individuals · {dataEdges.length} {dataEdges.length === 1 ? "link" : "links"}. Double-click an individual to see
            only what’s around it.
          </>
        )}
      </p>
      {/* Double-click is a shortcut; the panel's "Show what's around it" button does the same. */}
      <div
        className="og-stage"
        ref={wrap}
        onDoubleClick={() => {
          if (onFocus && selectedId && byId.has(selectedId)) onFocus(selectedId);
        }}
      >
        <canvas ref={canvas} role="img" aria-label={`Graph of ${data.length} ${noun.many} and ${dataEdges.length} links.`} />
        {hovered && hover && hovered.id !== selectedId && (
          <div className="og-tip" style={{ left: hover.x + 14, top: hover.y + 14 }} aria-hidden="true">
            <strong>{hovered.label}</strong>
            <span>
              {hovered.type} · {hovered.degree} {hovered.degree === 1 ? "link" : "links"}
            </span>
          </div>
        )}
        <div className="og-zoom">
          <button type="button" className="icon-btn sm" aria-label="Zoom in" title="Zoom in" onClick={() => fn.current.zoom(1.4)}>
            <IconPlus />
          </button>
          <button type="button" className="icon-btn sm" aria-label="Zoom out" title="Zoom out" onClick={() => fn.current.zoom(1 / 1.4)}>
            <IconMinus />
          </button>
          <button type="button" className="icon-btn sm" aria-label="Fit to screen" title="Fit to screen" onClick={() => fn.current.fit()}>
            <IconMaximize />
          </button>
        </div>
        {current && showPanel && (
          <aside className="og-panel" aria-label={current.label}>
            <header>
              <span className="og-dot" style={{ background: hueOf(current.type) || undefined }} aria-hidden="true" />
              <div>
                <h2>{current.label}</h2>
                <p>
                  {current.type} · {current.degree} {current.degree === 1 ? "link" : "links"}
                </p>
              </div>
              <button type="button" className="icon-btn sm" aria-label="Close" title="Close" onClick={() => onSelect(null)}>
                <IconClose />
              </button>
            </header>
            {(onOpen || onFocus) && (
              <div className="og-actions">
                {onOpen && (
                  <button type="button" className="btn sm" onClick={() => onOpen(current.id)}>
                    Open details <IconArrowRight />
                  </button>
                )}
                {onFocus && focus?.id !== current.id && (
                  <button type="button" className="btn ghost sm" onClick={() => onFocus(current.id)}>
                    Show what’s around it
                  </button>
                )}
              </div>
            )}
            {panelExtra?.(current.id)}
            {grouped.length ? (
              grouped.map(({ key, type, name, list }) => (
                <section key={key}>
                  <h3>
                    {type}{" "}
                    <span>
                      · {name} · {list.length}
                    </span>
                  </h3>
                  <ul>
                    {list.slice(0, 8).map((n) => (
                      <li key={n.id}>
                        <button type="button" onClick={() => onSelect(n.id)}>
                          <span className="og-dot" style={{ background: hueOf(n.type) || undefined }} aria-hidden="true" />
                          <span className="og-match-name">{n.label}</span>
                          <small>{n.type}</small>
                        </button>
                      </li>
                    ))}
                    {list.length > 8 && <li className="og-more">and {list.length - 8} more</li>}
                  </ul>
                </section>
              ))
            ) : (
              <p className="og-none">{current.degree ? "Its links lead outside this view." : `No links to other ${noun.many}.`}</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
