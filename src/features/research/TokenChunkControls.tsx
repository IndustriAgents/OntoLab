import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModelChoice } from "../../app/providers";
import { api } from "../../lib/projectApi";
import type { ChunkSettings, GenerationTokenBudget } from "../../types/research";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { InlineError } from "../../components/ui/ui";
import { DEFAULT_CONTEXT_TOKENS, defaultGenerationBudget as defaults } from "../../lib/generationLimits";
import type { GenerationModelChoice } from "../../lib/buildPreparation";

export function TokenChunkControls({
  pid,
  settings,
  onChange,
  onModelChoice,
}: {
  pid: string;
  settings: ChunkSettings;
  onChange: (s: ChunkSettings) => void;
  onModelChoice?: (choice: GenerationModelChoice) => void;
}) {
  const choice = useModelChoice();
  const profiles = useQuery({ queryKey: ["chunk-models", pid], queryFn: () => api.chunkModels(pid) });
  const tokens = settings.tokens;
  const list = useMemo(() => profiles.data?.embeddings ?? [], [profiles.data]);
  useEffect(() => {
    if (settings.unit !== "tokens" || tokens || !list.length || !choice.model || choice.status !== "ready") return;
    onChange({
      ...settings,
      tokens: {
        embedding: { profile: list[0].id, maxTokens: Math.min(256, list[0].inputLimit) },
        generation: defaults(choice.provider, choice.model),
      },
    });
  }, [settings, tokens, list, choice.provider, choice.model, choice.status, onChange]);
  const generation = tokens?.generation;
  const modelContext = choice.providers.find((entry) => entry.id === generation?.provider)?.contextWindows?.[generation?.model ?? ""];
  const profile = list.find((p) => p.id === tokens?.embedding.profile);
  const update = (patch: Partial<GenerationTokenBudget>) => {
    if (tokens && generation) onChange({ ...settings, tokens: { ...tokens, generation: { ...generation, ...patch } } });
  };
  return (
    <div className="token-chunk-controls">
      <label className="field">
        <span>Size unit</span>
        <select
          value={settings.unit ?? "characters"}
          onChange={(e) => onChange({ ...settings, unit: e.target.value as ChunkSettings["unit"] })}
        >
          <option value="tokens">Tokens · model aware</option>
          <option value="characters">Characters · legacy</option>
        </select>
      </label>
      {settings.unit === "tokens" && (
        <>
          <div className="token-budget-section">
            <h4>1. Select models before chunking</h4>
            <label className="field">
              <span>Embedding model</span>
              <select
                value={tokens?.embedding.profile ?? ""}
                disabled={!list.length}
                onChange={(e) => {
                  const p = list.find((p) => p.id === e.target.value)!;
                  if (tokens)
                    onChange({
                      ...settings,
                      tokens: { ...tokens, embedding: { profile: p.id, maxTokens: Math.min(tokens.embedding.maxTokens, p.inputLimit) } },
                    });
                }}
              >
                {!tokens && <option value="">Loading models…</option>}
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-hint">
              {profile
                ? `${profile.tokenizer} · passage limit ${profile.inputLimit.toLocaleString()} tokens`
                : "Loading embedding profiles…"}
            </p>
            {generation && (
              <ProviderModelSelect
                providers={choice.providers}
                provider={generation.provider as typeof choice.provider}
                model={generation.model}
                models={choice.providers.find((p) => p.id === generation.provider)?.models ?? []}
                structuredOnly
                reasoningEffort={choice.reasoningEffort}
                onReasoningEffort={(reasoningEffort) => {
                  choice.setReasoningEffort(reasoningEffort);
                  onModelChoice?.({ provider: generation.provider, model: generation.model, reasoningEffort });
                }}
                onProvider={(provider) => {
                  const model = choice.providers.find((p) => p.id === provider)?.models[0] ?? "";
                  choice.setProvider(provider);
                  choice.setModel(model);
                  choice.setReasoningEffort("default");
                  onModelChoice?.({ provider, model, reasoningEffort: "default" });
                  update({ ...defaults(provider, model) });
                }}
                onModel={(model) => {
                  choice.setProvider(generation.provider as typeof choice.provider);
                  choice.setModel(model);
                  const reasoningEffort = choice.providers
                    .find((provider) => provider.id === generation.provider)
                    ?.reasoningEfforts?.[model]?.includes(choice.reasoningEffort)
                    ? choice.reasoningEffort
                    : "default";
                  choice.setReasoningEffort(reasoningEffort);
                  onModelChoice?.({ provider: generation.provider, model, reasoningEffort });
                  update({ model });
                }}
              />
            )}
          </div>
          {tokens && generation && (
            <div className="token-budget-section">
              <div className="token-budget-heading">
                <h4>2. Set separate token budgets</h4>
                <span>All values in tokens</span>
              </div>
              <div className="token-sizing-grid">
                <label className="field">
                  <span>Embedding passage</span>
                  <input
                    type="number"
                    min={8}
                    max={profile?.inputLimit}
                    value={tokens.embedding.maxTokens}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        tokens: { ...tokens, embedding: { ...tokens.embedding, maxTokens: e.target.valueAsNumber } },
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Generation chunk</span>
                  <input
                    type="number"
                    min={32}
                    max={60000}
                    value={generation.maxTokens}
                    onChange={(e) => update({ maxTokens: e.target.valueAsNumber })}
                  />
                </label>
              </div>
              <p className="token-budget-explainer">
                Use smaller passages for embedding and larger chunks for generation. Overlap stays within the chunk budget.
              </p>
              {generation?.provider.endsWith("-cli") && (
                <p className="field-hint">
                  CLI token checks are estimates with an allowance for native context. The output reserve is a planning allowance; the CLI
                  controls its actual output limit.
                </p>
              )}
              <details className="method-details">
                <summary>Advanced settings · request limits and token allocation</summary>
                <div className="token-request-heading">Generation request budget</div>
                <div className="token-context-grid">
                  <label className="field">
                    <span>Context limit</span>
                    <input
                      type="number"
                      min={256}
                      max={2000000}
                      aria-label="Context limit"
                      value={generation.contextTokens}
                      onChange={(e) => update({ contextTokens: e.target.valueAsNumber })}
                    />
                    <span className="field-hint">
                      Default: {DEFAULT_CONTEXT_TOKENS.toLocaleString()} tokens.
                      {modelContext ? ` Reported model capacity: ${modelContext.toLocaleString()} tokens.` : ""}
                      {generation.contextTokens !== DEFAULT_CONTEXT_TOKENS && (
                        <button className="btn ghost sm" type="button" onClick={() => update({ contextTokens: DEFAULT_CONTEXT_TOKENS })}>
                          Reset to default
                        </button>
                      )}
                    </span>
                  </label>
                  <label className="field">
                    <span>Output reserve (includes reasoning)</span>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={generation.outputTokens}
                      onChange={(e) => update({ outputTokens: e.target.valueAsNumber })}
                    />
                  </label>
                  <label className="field">
                    <span>Prompt & ontology reserve</span>
                    <input
                      type="number"
                      min={0}
                      max={1000000}
                      value={generation.promptReserveTokens}
                      onChange={(e) => update({ promptReserveTokens: e.target.valueAsNumber })}
                    />
                  </label>
                </div>
                {Number.isFinite(generation.maxTokens + generation.outputTokens + generation.promptReserveTokens) &&
                  Number.isFinite(generation.contextTokens) && (
                    <div className="token-budget-allocation" aria-live="polite">
                      <span>
                        Planned request{" "}
                        <strong>
                          {(generation.maxTokens + generation.outputTokens + generation.promptReserveTokens).toLocaleString()} /{" "}
                          {generation.contextTokens.toLocaleString()}
                        </strong>
                      </span>
                      <span>
                        {Math.max(
                          0,
                          generation.contextTokens - generation.maxTokens - generation.outputTokens - generation.promptReserveTokens,
                        ).toLocaleString()}{" "}
                        tokens available
                      </span>
                    </div>
                  )}
                <p className="token-budget-explainer">
                  The request includes the chunk, prompt, ontology and reserved output. Confirm the context limit for your selected model;
                  the full request is checked again before generation.
                </p>
              </details>
              {generation.maxTokens + generation.outputTokens + generation.promptReserveTokens > generation.contextTokens && (
                <p className="banner warn">Chunk, prompt reserve and output reserve exceed the context budget.</p>
              )}
              <p className="token-budget-note">
                Token counts are labelled as estimates when an exact tokenizer is unavailable. Chunking does not run ontology generation or
                embedding inference.
              </p>
            </div>
          )}
        </>
      )}
      <InlineError error={profiles.error} />
    </div>
  );
}
