import type { OntologyRevision } from "../types/project";

export const ontologySelectionKey = (pid: string) => `ontolab-selected-ontology:${pid}`;
export function rememberedOntology(pid: string): string | null {
  try {
    return localStorage.getItem(ontologySelectionKey(pid));
  } catch {
    return null;
  }
}
export function rememberOntology(pid: string, id: string | null) {
  try {
    if (id) localStorage.setItem(ontologySelectionKey(pid), id);
    else localStorage.removeItem(ontologySelectionKey(pid));
  } catch {
    /* Storage is optional. */
  }
}
export function selectedOntology(
  revisions: OntologyRevision[],
  current: string | null | undefined,
  requested: string | null,
  remembered: string | null,
) {
  const candidate = requested ?? remembered;
  return revisions.some((r) => r.id === candidate) ? candidate : (current ?? revisions.find((r) => r.stats.modules > 0)?.id ?? null);
}

/** Keep the ontology tool, clearing run-specific state when switching versions. */
export function switchOntologyHref(pid: string, revision: string, pathname: string, search: string): string {
  const base = `/p/${encodeURIComponent(pid)}`;
  const path = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : "";
  const params = new URLSearchParams({ rev: revision });
  if (path === "ontology") {
    const tab = new URLSearchParams(search).get("tab");
    if (tab && ["terms", "history", "review", "workspace"].includes(tab)) params.set("tab", tab);
    return `${base}/ontology?${params}`;
  }
  if (path === "validate") return `${base}/validate?${params}`;
  if (path === "workflows/tbox") {
    params.set("start", "previous");
    return `${base}/workflows/tbox?${params}`;
  }
  if (path === "workflows/alignment") return `${base}/workflows/alignment?${params}`;
  return `${base}/ontology/overview?${params}`;
}
