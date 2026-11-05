// SPDX-License-Identifier: Apache-2.0
// Modified for OntoLab from the Helix Foundry palette.
// Categorical class colours for the Explore graph (the Helix Foundry palette,
// validated for both themes). Classes take them in alphabetical order of the
// classes on screen; a ninth class and beyond share the neutral grey (""
// here, so callers fall back to the faint token).
const HUES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** `types` is every class name on screen, sorted. */
export function typeHue(types: string[], type: string, theme: "light" | "dark"): string {
  const i = types.indexOf(type);
  const hues = HUES[theme];
  return i >= 0 && i < hues.length ? hues[i] : "";
}
