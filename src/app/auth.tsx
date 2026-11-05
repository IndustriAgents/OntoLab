import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ClientConfig } from "../types/project";
import { api } from "../lib/projectApi";

interface WorkspaceState {
  status: "loading" | "ready" | "error";
  config: ClientConfig | null;
  error: string | null;
  retry: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useAuth(): WorkspaceState {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useAuth outside AuthProvider");
  return workspace;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WorkspaceState["status"]>("loading");
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void api.config().then(
      (value) => {
        if (cancelled) return;
        setConfig(value);
        setStatus("ready");
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not reach the server.");
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <WorkspaceContext.Provider value={{ status, config, error, retry: () => setAttempt((a) => a + 1) }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
