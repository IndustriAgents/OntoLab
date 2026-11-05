import { resolve } from "node:path";
import { DATA_DIR } from "../config.ts";

let localWorkspace = false;

export function enableLocalConnections(): void {
  localWorkspace = true;
}

/** The web and desktop entry points both serve loopback-only workspaces. */
export function localConnectionInstall(): boolean {
  const desktopDir = process.env.ONTOLAB_DESKTOP_DATA_DIR;
  return localWorkspace || !!(desktopDir && resolve(desktopDir) === resolve(DATA_DIR));
}
