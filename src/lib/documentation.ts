/** Bundled help shares the app origin, including installations under /ontolab. */
export const DOCUMENTATION_URL = `${import.meta.env.BASE_URL}docs/`;

export function documentationForPath(path: string, search = "", hash = ""): string {
  const guides: [string, string][] = [
    ["/workflows/tbox", "guides/build-tbox/"],
    ["/workflows/abox", "guides/extract-abox/"],
    ["/workflows/alignment", "guides/align-merge/"],
    ["/documents", "guides/documents/"],
    ["/ontology", "guides/manual-editing/"],
    ["/explore", "guides/review/"],
    ["/validate", "concepts/validation/"],
    ["/assistant", "guides/ask/"],
    ["/sparql", "guides/ask/"],
    ["/export", "guides/export/"],
    ["/research", "research/experiments/"],
    ["/runs", "help/troubleshooting/"],
    ["/project-settings", "reference/settings/"],
    ["/graphs", "concepts/knowledge-graphs/"],
    ["/activity", "help/troubleshooting/"],
    ["/ontology/overview", "guides/manual-editing/"],
  ];
  const params = new URLSearchParams(search);
  const guide =
    hash === "#requirements"
      ? "concepts/requirements/"
      : path.endsWith("/settings") && params.get("section") === "connections"
        ? "guides/graph-connections/"
        : path.endsWith("/settings")
          ? "reference/settings/"
          : path.endsWith("/graph")
            ? params.get("tab") === "settings"
              ? "reference/settings/"
              : params.get("tab") === "history"
                ? "concepts/revisions/"
                : params.get("tab") === "updates"
                  ? "guides/extract-abox/"
                  : "guides/documents/"
            : (guides.find(([suffix]) => path.endsWith(suffix))?.[1] ?? "start/introduction/");
  const returnTo = `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}${search}${hash}`;
  return `${DOCUMENTATION_URL}${guide}?${new URLSearchParams({ returnTo })}`;
}
