// Per-project retrieval, evidence, grounding and fact review preferences.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { api, qk } from "../../lib/projectApi";
import type { EmbeddingsChoice, NliChoice, ProjectSettings } from "../../types/project";
import { InlineError } from "../../components/ui/ui";
import "./projectSettings.css";

const GROUNDING = [
  { id: "wikidata", name: "Wikidata", description: "People, organisations, products and works" },
  { id: "geonames", name: "GeoNames", description: "Places and geographical features" },
  { id: "umls", name: "UMLS", description: "Clinical and biomedical concepts" },
];

export function ProjectSettingsCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { pid, project } = useProject();
  const { config } = useAuth();
  const qc = useQueryClient();
  const s = project?.settings ?? {};
  const [embeddings, setEmbeddings] = useState<EmbeddingsChoice | "">(s.models?.embeddings ?? "");
  const [nli, setNli] = useState<NliChoice | "">(s.models?.nli ?? "");
  const [grounding, setGrounding] = useState<string[]>(s.grounding ?? []);
  const [policy, setPolicy] = useState<NonNullable<ProjectSettings["reviewPolicy"]>>(s.reviewPolicy ?? "exclude-rejected");
  const savedQuality = JSON.stringify({ models: s.models, grounding: s.grounding, reviewPolicy: s.reviewPolicy });
  useEffect(() => {
    setEmbeddings(s.models?.embeddings ?? "");
    setNli(s.models?.nli ?? "");
    setGrounding(s.grounding ?? []);
    setPolicy(s.reviewPolicy ?? "exclude-rejected");
    // Saving another section must not erase this editor's unfinished changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedQuality]);

  const available = new Set(config?.features?.grounding ?? ["wikidata"]);
  const next: ProjectSettings = {
    ...s,
    models: { ...(embeddings ? { embeddings } : {}), ...(nli ? { nli } : {}) },
    grounding,
    reviewPolicy: policy,
  };
  const save = useMutation({
    mutationFn: () => api.updateProject(pid, { settings: next }),
    onSuccess: (p) => qc.setQueryData(qk.project(pid), p),
  });
  const dirty =
    embeddings !== (s.models?.embeddings ?? "") ||
    nli !== (s.models?.nli ?? "") ||
    [...grounding].sort().join(",") !== [...(s.grounding ?? [])].sort().join(",") ||
    policy !== (s.reviewPolicy ?? "exclude-rejected");
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  return (
    <section className="card span-2 project-quality-settings" aria-label="Quality settings">
      <div className="pqs-section">
        <div className="pqs-section-info">
          <h4 id="pqs-models">Retrieval and evidence</h4>
          <p>Choose how passages are found and claims are checked against their source text.</p>
        </div>
        <fieldset className="pqs-fields" aria-labelledby="pqs-models">
          <div className="field-row">
            <div className="field">
              <label htmlFor="m-emb">Retrieval embeddings</label>
              <select id="m-emb" value={embeddings} onChange={(e) => setEmbeddings(e.target.value as EmbeddingsChoice | "")}>
                <option value="">Server default ({config?.features?.embeddings ?? "local"})</option>
                <option value="local">Local model (private, free)</option>
                <option value="provider">Provider API</option>
                <option value="hash">Lexical only</option>
                <option value="off">Off</option>
              </select>
              <p className="pqs-hint">Find relevant passages by meaning.</p>
            </div>
            <div className="field">
              <label htmlFor="m-nli">Evidence check</label>
              <select id="m-nli" value={nli} onChange={(e) => setNli(e.target.value as NliChoice | "")}>
                <option value="">Server default ({config?.features?.nli ?? "local"})</option>
                <option value="local">Local entailment model</option>
                <option value="provider">The run's model as judge</option>
                <option value="lexical">Lexical only</option>
                <option value="off">Off</option>
              </select>
              <p className="pqs-hint">Check whether a source supports a claim.</p>
            </div>
          </div>
        </fieldset>
      </div>
      <details className="pqs-advanced">
        <summary>Advanced settings · external references{grounding.length ? ` · ${grounding.length} enabled` : ""}</summary>
        <div className="pqs-section">
          <div className="pqs-section-info">
            <h4 id="pqs-grounding">External references</h4>
            <p>Match entities to identifiers in external registries to help resolve duplicates.</p>
          </div>
          <fieldset className="pqs-fields" aria-labelledby="pqs-grounding">
            <div className="pqs-grounding-options">
              {GROUNDING.map(({ id, name, description }) => (
                <label
                  key={id}
                  className={`pqs-grounding-option${grounding.includes(id) ? " is-selected" : ""}${available.has(id) ? "" : " is-unavailable"}`}
                >
                  <span className="pqs-grounding-name">
                    <strong>{name}</strong>
                    <input
                      type="checkbox"
                      aria-label={name}
                      disabled={!available.has(id)}
                      checked={grounding.includes(id)}
                      onChange={(e) => setGrounding((g) => (e.target.checked ? [...g, id] : g.filter((x) => x !== id)))}
                    />
                  </span>
                  <span className="pqs-grounding-description">{description}</span>
                  <span className={available.has(id) ? "pqs-source-status is-available" : "pqs-source-status"}>
                    {available.has(id) ? "Available" : "Not configured"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <p className="pqs-integration-help">
          Wikidata needs no credentials. To enable GeoNames, configure a GeoNames username on the server (GEONAMES_USERNAME). UMLS requires
          a licensed API key (UMLS_API_KEY). Restart the server after configuration. Lookups send entity names to the selected service.
        </p>
      </details>
      <div className="pqs-section">
        <div className="pqs-section-info">
          <h4 id="pqs-review">Fact review</h4>
          <p>Control which facts power queries, exports, validation and assistant answers.</p>
        </div>
        <fieldset className="pqs-fields" aria-labelledby="pqs-review">
          <div className="field">
            <label htmlFor="rv-policy">Include in the graph</label>
            <select id="rv-policy" value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
              <option value="exclude-rejected">Every fact except rejected ones</option>
              <option value="accepted-only">Only accepted facts (commits wait for review)</option>
              <option value="all">Every fact, rejected ones too</option>
            </select>
          </div>
          <details className="pqs-details">
            <summary>How fact review works</summary>
            <p>
              Extraction trusts a fact when its quote entails it and no validation finding points at it; the rest wait for review in
              Explore. This setting decides what export, queries, validation, reasoning and Ask use.
            </p>
          </details>
        </fieldset>
      </div>
      <div className="pqs-footer">
        <span className="pqs-save-status" role="status">
          {save.isPending ? "Saving your settings…" : dirty ? "Unsaved changes" : save.isSuccess ? "Settings saved" : "No unsaved changes"}
        </span>
        <InlineError error={save.error} />
        {dirty && (
          <button
            className="btn ghost"
            disabled={save.isPending}
            onClick={() => {
              setEmbeddings(s.models?.embeddings ?? "");
              setNli(s.models?.nli ?? "");
              setGrounding(s.grounding ?? []);
              setPolicy(s.reviewPolicy ?? "exclude-rejected");
              save.reset();
            }}
          >
            Discard changes
          </button>
        )}
        <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}
