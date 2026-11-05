export type NavigationArea = "ontology" | "graphs";

export const ontologyNavigation = [
  { id: "build", label: "Build & sources", path: "workflows/tbox" },
  { id: "terms", label: "Terms & relations", path: "ontology?tab=terms" },
  { id: "alignment", label: "Align & merge", path: "workflows/alignment" },
  { id: "validation", label: "Validation", path: "validate" },
  { id: "versions", label: "Versions", path: "ontology?tab=history" },
] as const;

export const graphNavigation = [
  { id: "documents", label: "Documents", path: "graph?tab=documents" },
  { id: "updates", label: "Extract & review", path: "graph?tab=updates" },
  { id: "explore", label: "Explore", path: "explore" },
  { id: "validation", label: "Validation", path: "validate" },
  { id: "evaluate", label: "Evaluate", path: "evaluate" },
  { id: "history", label: "Versions", path: "graph?tab=history" },
  { id: "settings", label: "Graph settings", path: "graph?tab=settings" },
] as const;

export function graphTab(search: string) {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const selected = (["documents", "updates", "history", "settings"] as const).find((value) => value === tab);
  return selected ?? (params.has("run") || params.has("rev") ? "updates" : "documents");
}

export function navigationSelection(pathname: string, search: string, isGraph: boolean) {
  const path = pathname.replace(/^\/p\/[^/]+\/?/, "");
  if (isGraph) {
    const id =
      path === "evaluate"
        ? "evaluate"
        : ["explore", "assistant", "sparql", "export"].includes(path)
          ? "explore"
          : path === "validate"
            ? "validation"
            : path === "project-settings"
              ? "settings"
              : graphTab(search);
    return { area: "graphs" as const, id, label: graphNavigation.find((item) => item.id === id)!.label };
  }
  if (!path) return { area: null, id: "overview", label: "Overview" };
  if (path === "graphs" || path === "workflows/abox") return { area: "graphs" as const, id: "graphs", label: "Knowledge graphs" };
  if (path === "activity" || path.startsWith("runs")) return { area: null, id: "activity", label: "Activity" };
  if (path === "project-settings") return { area: null, id: "overview", label: "Overview" };
  if (path === "ontology/overview") return { area: "ontology" as const, id: "ontology", label: "Ontology" };
  const tab = new URLSearchParams(search).get("tab");
  const id =
    path === "workflows/tbox" || path === "documents" || path === "research" || tab === "induce"
      ? "build"
      : path === "workflows/alignment"
        ? "alignment"
        : path === "validate"
          ? "validation"
          : tab === "history"
            ? "versions"
            : "terms";
  return { area: "ontology" as const, id, label: ontologyNavigation.find((item) => item.id === id)!.label };
}

/** Keep the destination, never another graph's document, run, revision or conversation. */
export function switchGraphHref(id: string, pathname: string, search: string, fromGraph: boolean) {
  const base = `/p/${encodeURIComponent(id)}`;
  if (!fromGraph) return `${base}/graph?tab=documents`;
  const path = pathname.replace(/^\/p\/[^/]+\/?/, "");
  if (["explore", "assistant", "sparql", "export", "validate", "evaluate"].includes(path)) {
    const view = new URLSearchParams(search).get("view");
    return `${base}/${path}${path === "explore" && ["table", "turtle"].includes(view ?? "") ? `?view=${view}` : ""}`;
  }
  return `${base}/graph?tab=${path === "project-settings" ? "settings" : graphTab(search)}`;
}

export type GraphReturn = { id: string; name: string; to: string };
export function graphReturnState(value: unknown): GraphReturn | null {
  const candidate = (value as { graphReturn?: GraphReturn } | null)?.graphReturn;
  return candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.to === "string" &&
    candidate.to.startsWith(`/p/${encodeURIComponent(candidate.id)}/`)
    ? candidate
    : null;
}
