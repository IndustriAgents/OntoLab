/** Only workspace paths on this origin are valid return destinations. */
export function workspaceReturnPath(candidate, docsBase, origin) {
  const base = docsBase.replace(/docs\/$/, "");
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return base;
  try {
    const url = new URL(candidate, origin);
    if (url.origin !== origin || !url.pathname.startsWith(base)) return base;
    const path = url.pathname.slice(base.length);
    return path === "" || path === "settings" || path.startsWith("p/") ? url.pathname + url.search + url.hash : base;
  } catch {
    return base;
  }
}
