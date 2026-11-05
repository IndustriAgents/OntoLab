import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNavigation } from "../src/app/ProjectNavigation";
import type { ProjectNavInfo } from "../src/app/AppShell";
import { corpusKeys } from "../src/lib/corpusApi";
import { qk } from "../src/lib/projectApi";

const parent: ProjectNavInfo = { id: "science", name: "Science", save: "idle", saveError: null, activity: null };
const graph: ProjectNavInfo = { ...parent, id: "research", name: "Research", corpus: { parentId: "science", parentName: "Science" } };
function render(project: ProjectNavInfo, location: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: 0 } } });
  client.setQueryData(corpusKeys.list("science"), [
    { id: "research", name: "Research", archived: false, settings: { corpus: { members: [] } } },
  ]);
  client.setQueryData(qk.runs("science"), []);
  client.setQueryData(qk.runs("research"), []);
  const markup = renderToStaticMarkup(h(QueryClientProvider, { client }, h(StaticRouter, { location }, h(ProjectNavigation, { project }))));
  client.clear();
  return markup;
}
afterEach(() => vi.unstubAllGlobals());

describe("sidebar scope", () => {
  it("restores both collapsed sections even when their pages are active", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "ontolab-navigation-expanded:science" ? JSON.stringify({ ontology: false, graphs: false }) : null),
    });
    for (const location of ["/p/science/graphs", "/p/science/ontology/overview"]) {
      const html = render(parent, location);
      expect(html).not.toContain('id="ontology-navigation"');
      expect(html).not.toContain('id="knowledge-graph-navigation"');
      expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    }
  });
  it("remembers each section independently across project and graph pages", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "ontolab-navigation-expanded:science" ? JSON.stringify({ ontology: true, graphs: false }) : null),
    });
    for (const [project, location] of [
      [parent, "/p/science/graphs"],
      [graph, "/p/research/graph?tab=documents"],
    ] as const) {
      const html = render(project, location);
      expect(html).toContain('id="ontology-navigation"');
      expect(html).not.toContain('id="knowledge-graph-navigation"');
    }
  });
  it("ignores malformed preferences and preferences from other projects", () => {
    for (const saved of ["invalid-json", JSON.stringify({ ontology: "false", graphs: 1 }), null]) {
      vi.stubGlobal("localStorage", {
        getItem: (key: string) =>
          key === "ontolab-navigation-expanded:another-project" ? JSON.stringify({ ontology: false, graphs: false }) : saved,
      });
      const html = render(graph, "/p/research/graph?tab=documents");
      expect(html).toContain('id="knowledge-graph-navigation"');
      expect(html).not.toContain('id="ontology-navigation"');
    }
  });
  it("links graph tools to the selected graph without a project settings sidebar entry", () => {
    const html = render(graph, "/p/research/graph?tab=settings");
    expect(html).toContain('href="/p/research/graph?tab=settings"');
    expect(html).not.toContain('href="/p/science/project-settings"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*><span>Graph settings/);
  });
  it("does not highlight graph settings while editing project settings", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key.includes("selected-graph") ? "research" : "graphs") });
    const html = render(parent, "/p/science/project-settings");
    expect(html).toContain("Selected graph");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/<a\b[^>]*href="\/p\/science"[^>]*>/)?.[0]).toContain('aria-current="page"');
    expect(html.match(/<a\b[^>]*href="\/p\/research\/graph\?tab=settings"[^>]*>/)?.[0]).not.toContain("aria-current");
  });
  it("keeps Explore active across Graph, Ask and SPARQL without adding duplicate navigation", () => {
    for (const path of ["explore", "assistant", "sparql"]) {
      const html = render(graph, `/p/research/${path}`);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toMatch(/aria-current="page"[^>]*><span>Explore/);
      expect(html).not.toContain("Graph tools");
      expect(html).not.toContain("Extract ABox");
    }
  });
});
