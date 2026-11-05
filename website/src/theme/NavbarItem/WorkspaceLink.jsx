import React, { useEffect, useState } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { workspaceReturnPath } from "../../lib/workspace";
export default function WorkspaceLink({ className = "navbar__item navbar__link navbar-app-link", label = "← Back to workspace" }) {
  const base = useBaseUrl("/"),
    fallback = base.replace(/docs\/$/, "");
  const [href, setHref] = useState(fallback);
  useEffect(() => {
    const key = `ontolab-docs-return:${base}`;
    const requested = new URLSearchParams(window.location.search).get("returnTo");
    let saved;
    try {
      saved = sessionStorage.getItem(key);
    } catch {
      /* storage may be disabled */
    }
    const target = workspaceReturnPath(requested ?? saved, base, window.location.origin);
    setHref(target);
    if (requested)
      try {
        sessionStorage.setItem(key, target);
      } catch {
        /* navigation still works */
      }
  }, [base]);
  return (
    <a className={className} href={href}>
      {label}
    </a>
  );
}
