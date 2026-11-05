import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { IconChevronsUpDown, IconFile, IconSettings } from "../components/icons";
import { documentationForPath } from "../lib/documentation";
import { accountInitials } from "./settingsNavigation";

export function AccountMenu({
  placement = "sidebar",
  beforeDocs,
}: {
  placement?: "sidebar" | "topbar";
  beforeDocs?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const [docsError, setDocsError] = useState("");
  const [openingDocs, setOpeningDocs] = useState(false);
  const docsHref = documentationForPath(location.pathname, location.search, location.hash);
  const name = "This computer";
  const detail = "Local workspace";

  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(".account-menu-actions a")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div
      className={`account-control ${placement === "sidebar" ? "sidebar-foot" : "account-topbar"}`}
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {open && (
        <div className="account-popover" id="account-menu" role="dialog" aria-label="Account menu">
          <div className="account-menu-identity">
            <strong>{name}</strong>
            <span>{detail}</span>
          </div>
          <nav className="account-menu-actions" aria-label="Account actions">
            <Link to="/settings" state={{ settingsReturnTo: location.pathname + location.search }} onClick={() => setOpen(false)}>
              <IconSettings />
              <span>Account & workspace settings</span>
            </Link>
            <a
              href={docsHref}
              aria-disabled={openingDocs}
              onClick={async (event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (openingDocs) return;
                setOpeningDocs(true);
                setDocsError("");
                try {
                  if (beforeDocs && !(await beforeDocs())) throw new Error("Save your changes before opening documentation.");
                  window.location.assign(docsHref);
                } catch (e) {
                  setDocsError(e instanceof Error ? e.message : "Could not open documentation.");
                  setOpeningDocs(false);
                }
              }}
            >
              <IconFile />
              <span>{openingDocs ? "Opening docs…" : "Docs"}</span>
            </a>
            {docsError && (
              <p className="field-error" role="alert">
                {docsError}
              </p>
            )}
          </nav>

        </div>
      )}
      <button
        ref={trigger}
        className={"account account-trigger" + (open ? " is-open" : "")}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Account menu for ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="account-menu"
      >
        <span className="account-avatar" aria-hidden="true">
          {accountInitials(name)}
        </span>
        <span className="account-text">
          <strong>{name}</strong>
          <small>Account & workspace</small>
        </span>
        <IconChevronsUpDown className="ws-chevron" />
      </button>
    </div>
  );
}
