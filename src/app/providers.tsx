// App-wide provider/model selection (Settings decides the default; pages can
// change it for a single action). The choice survives reloads.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useProviders, type ProviderSelection } from "../hooks/useProviders";
import type { ProviderId } from "../lib/api";

const KEY = "ontolab-model";
const Ctx = createContext<ProviderSelection | null>(null);

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const sel = useProviders();
  const [restored, setRestored] = useState(false);
  const { status, providers, setProvider, setModel, setReasoningEffort, provider, model, reasoningEffort } = sel;

  // restore the saved choice once the list is known
  useEffect(() => {
    if (status !== "ready") return;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
        provider?: ProviderId;
        model?: string;
        reasoningEffort?: string;
      } | null;
      const p = providers.find((x) => x.id === saved?.provider && x.enabled);
      if (p) {
        setProvider(p.id);
        if (saved?.model && p.models.includes(saved.model)) setModel(saved.model);
        if (saved?.reasoningEffort && p.reasoningEfforts?.[saved.model ?? ""]?.includes(saved.reasoningEffort))
          setReasoningEffort(saved.reasoningEffort);
      }
    } catch {
      /* ignore */
    }
    setRestored(true);
    // only on load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || !restored || !model) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ provider, model, reasoningEffort }));
    } catch {
      /* ignore */
    }
  }, [status, restored, provider, model, reasoningEffort]);

  return <Ctx.Provider value={status === "ready" && !restored ? { ...sel, status: "loading" } : sel}>{children}</Ctx.Provider>;
}

export function useModelChoice(): ProviderSelection {
  const v = useContext(Ctx);
  if (!v) throw new Error("useModelChoice outside ProvidersProvider");
  return v;
}

/** Props for the shared ProviderModelSelect component. */
export function selectProps(sel: ProviderSelection) {
  return {
    providers: sel.providers,
    provider: sel.provider,
    model: sel.model,
    models: sel.models,
    onProvider: sel.setProvider,
    onModel: sel.setModel,
  };
}
