import { useId } from "react";
import type { ProviderId, ProviderInfo } from "../../lib/api";
import { providerGroups } from "../../lib/providerGroups";

interface Props {
  providers: ProviderInfo[];
  provider: ProviderId;
  model: string;
  models: string[];
  onProvider: (id: ProviderId) => void;
  onModel: (m: string) => void;
  reasoningEffort?: string;
  onReasoningEffort?: (effort: string) => void;
  /** hide models that cannot do structured extraction */
  structuredOnly?: boolean;
  disabled?: boolean;
  compact?: boolean;
  showProviderHint?: boolean;
}

/**
 * The provider + model picker. Previously duplicated in six components, each
 * with its own labelling and enabled-state rules.
 */
export function ProviderModelSelect({
  providers,
  provider,
  model,
  models,
  onProvider,
  onModel,
  reasoningEffort,
  onReasoningEffort,
  structuredOnly,
  disabled,
  compact,
  showProviderHint = true,
}: Props) {
  const providerId = useId();
  const modelId = useId();
  const effortId = useId();
  const selected = providers.find((p) => p.id === provider);
  const chatOnly = new Set(structuredOnly ? (selected?.chatOnlyModels ?? []) : []);
  const usable = models.filter((m) => !chatOnly.has(m));
  const groups = providerGroups(providers, window.location.hostname);
  const efforts = selected?.reasoningEfforts?.[model] ?? [];

  return (
    <div className={"provider-select" + (compact ? " compact" : "")}>
      <div className="field">
        <label htmlFor={providerId}>Provider</label>
        <select
          id={providerId}
          value={provider}
          title={selected?.label}
          disabled={disabled}
          onChange={(e) => onProvider(e.target.value as ProviderId)}
        >
          {groups.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.enabled} title={p.disabledReason}>
                  {p.label}
                  {p.enabled ? "" : p.kind === "cli" ? " (unavailable)" : " (no key)"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={modelId}>Model</label>
        <select id={modelId} value={model} title={model} disabled={disabled || !usable.length} onChange={(e) => onModel(e.target.value)}>
          {usable.map((m) => (
            <option key={m} value={m}>
              {m === "default" && selected?.kind === "cli" ? "Provider default" : m}
            </option>
          ))}
        </select>
      </div>
      {provider === "codex-cli" && onReasoningEffort && (
        <div className="field">
          <label htmlFor={effortId}>Reasoning effort</label>
          <select
            id={effortId}
            value={reasoningEffort ?? "default"}
            disabled={disabled || !efforts.length}
            onChange={(event) => onReasoningEffort(event.target.value)}
          >
            <option value="default">Model default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {{
                  none: "None",
                  minimal: "Minimal",
                  low: "Low",
                  medium: "Medium",
                  high: "High",
                  xhigh: "Extra high",
                  max: "Max",
                  ultra: "Ultra",
                }[effort] ?? effort}
              </option>
            ))}
          </select>
          {!efforts.length && <p className="field-hint">Select a named Codex model to choose its reasoning effort.</p>}
        </div>
      )}
      {showProviderHint && !compact && selected?.kind === "cli" && (
        <p className="field-hint">
          Runs on the server using its CLI login and account quota. Login is checked on the first request; model inference normally uses the
          provider’s cloud.
        </p>
      )}
    </div>
  );
}
