import { useCallback, useEffect, useState } from "react";
import { fetchProviders, CancelledError, NetworkError, type ProviderInfo, type ProviderId } from "../lib/api";
import { providerGroups } from "../lib/providerGroups";

export type ProvidersStatus = "loading" | "ready" | "error";

export interface ProviderSelection {
  providers: ProviderInfo[];
  status: ProvidersStatus;
  /** Set when the provider list could not be loaded — distinct from "no keys configured". */
  error: string | null;
  reload: () => void;
  provider: ProviderId;
  model: string;
  reasoningEffort: string;
  models: string[];
  setProvider: (id: ProviderId) => void;
  setModel: (m: string) => void;
  setReasoningEffort: (effort: string) => void;
  /** the currently selected provider's info */
  selected?: ProviderInfo;
  providerEnabled: boolean;
  anyEnabled: boolean;
}

/**
 * Loads the provider list and keeps the provider/model selection valid.
 *
 * `status` matters: a failed fetch used to look identical to "no API keys
 * configured", so the UI told people to edit .env when in fact the server was
 * simply not running.
 */
export function useProviders(): ProviderSelection {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [status, setStatus] = useState<ProvidersStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProviderState] = useState<ProviderId>("claude");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("default");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setError(null);
    fetchProviders(controller.signal)
      .then((list) => {
        setProviders(providerGroups(list, window.location.hostname).flatMap((group) => group.providers));
        setStatus("ready");
      })
      .catch((e) => {
        if (e instanceof CancelledError) return;
        setProviders([]);
        setStatus("error");
        setError(e instanceof NetworkError ? e.message : e instanceof Error ? e.message : "Could not load providers");
      });
    return () => controller.abort();
  }, [reloadKey]);

  // Keep the selection pointing at an enabled provider with a valid model.
  useEffect(() => {
    if (!providers.length) return;
    const current = providers.find((p) => p.id === provider);
    if (current?.enabled) {
      if (!current.models.includes(model)) setModel(current.models[0] ?? "");
      return;
    }
    const firstEnabled = providers.find((p) => p.enabled);
    if (firstEnabled) {
      setProviderState(firstEnabled.id);
      setModel(firstEnabled.models[0] ?? "");
    }
  }, [providers, provider, model]);

  const setProvider = useCallback(
    (id: ProviderId) => {
      setProviderState(id);
      const p = providers.find((x) => x.id === id);
      setModel(p?.models[0] ?? "");
    },
    [providers],
  );

  const selected = providers.find((p) => p.id === provider);
  useEffect(() => {
    if (status === "ready" && reasoningEffort !== "default" && !selected?.reasoningEfforts?.[model]?.includes(reasoningEffort))
      setReasoningEffort("default");
  }, [status, selected, model, reasoningEffort]);
  return {
    providers,
    status,
    error,
    reload: () => setReloadKey((k) => k + 1),
    provider,
    model,
    reasoningEffort,
    models: selected?.models ?? [],
    setProvider,
    setModel,
    setReasoningEffort,
    selected,
    providerEnabled: selected?.enabled ?? false,
    anyEnabled: providers.some((p) => p.enabled),
  };
}
