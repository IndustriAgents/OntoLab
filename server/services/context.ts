// What every service call needs: the user-bound store, a clock (injectable so
// lease expiry is testable) and a structured logger that never sees content.

import { randomUUID } from "node:crypto";
import type { User } from "../../src/types/project.ts";
import type { UserStore } from "../store/types.ts";

export interface LogFields {
  requestId?: string;
  projectId?: string;
  runId?: string;
  step?: string;
  [k: string]: string | number | boolean | undefined;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ t: new Date().toISOString(), level: "warn", event, ...fields })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export interface ServiceCtx {
  store: UserStore;
  user: User;
  now: () => Date;
  log: Logger;
  requestId: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const iso = (d: Date) => d.toISOString();
