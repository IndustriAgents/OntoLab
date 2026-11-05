import React, { useEffect, useRef, useState } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";

let loading;
function loadSearch(base) {
  if (window.PagefindUI) return Promise.resolve();
  if (!loading)
    loading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${base}pagefind/pagefind-ui.css`;
      document.head.append(css);
      const script = document.createElement("script");
      script.src = `${base}pagefind/pagefind-ui.js`;
      script.onload = resolve;
      script.onerror = () => {
        loading = null;
        script.remove();
        css.remove();
        reject(new Error("Search is unavailable. Please reload or use the navigation."));
      };
      document.head.append(script);
    });
  return loading;
}
export default function SearchBar() {
  const base = useBaseUrl("/");
  const dialog = useRef(null);
  const container = useRef(null);
  const search = useRef(null);
  const [error, setError] = useState("");
  const open = async () => {
    if (!dialog.current.open) dialog.current.showModal();
    setError("");
    try {
      await loadSearch(base);
      if (!search.current)
        search.current = new window.PagefindUI({
          element: container.current,
          baseUrl: base,
          bundlePath: `${base}pagefind/`,
          showSubResults: true,
          showImages: false,
          resetStyles: false,
        });
      dialog.current.querySelector("input")?.focus();
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        void open();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [base]);
  useEffect(() => () => search.current?.destroy(), []);
  return (
    <>
      <button className="docs-search" type="button" onClick={open} aria-label="Search documentation">
        <span>⌕</span> Search documentation <kbd>⌘ K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="search-dialog"
        aria-label="Search documentation"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <div className="search-dialog-head">
          <strong>Search OntoLab</strong>
          <button type="button" onClick={() => dialog.current.close()} aria-label="Close search">
            Close <kbd>Esc</kbd>
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div
          ref={container}
          onClick={(e) => {
            if (e.target.closest("a")) dialog.current.close();
          }}
        />
        <p className="search-hint">Search guides, concepts and reference. Your search stays in this browser.</p>
      </dialog>
    </>
  );
}
