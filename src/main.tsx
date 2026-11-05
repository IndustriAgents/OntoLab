import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/workspace.css";
import "./styles/helix.css";
import { App } from "./App";

// Apply the persisted theme before first paint to avoid a flash. With no stored
// choice, follow the OS preference rather than assuming light.
function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("ontolab-theme") ?? localStorage.getItem("d2o-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* private browsing: fall through to the OS preference */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
document.documentElement.dataset.theme = initialTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
