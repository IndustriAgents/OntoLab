// Local workspace identity and the request identity interface used by the API.
import type http from "node:http";
import type { User } from "../src/types/project.ts";

export interface AuthResult {
  user: User;
  accessToken?: string;
}

export interface Authenticator {
  mode: "local";
  authenticate(req: http.IncomingMessage): Promise<AuthResult | null>;
}

export const LOCAL_USER: User = { id: "local-user", name: "Local user" };

export function createLocalAuth(): Authenticator {
  return { mode: "local", authenticate: async () => ({ user: LOCAL_USER }) };
}
