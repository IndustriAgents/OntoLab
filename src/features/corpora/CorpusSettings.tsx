import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { api, qk } from "../../lib/projectApi";
import { corpusApi, type CorpusDetail } from "../../lib/corpusApi";
import type { ChunkSettings } from "../../types/research";
import { TokenChunkControls } from "../research/TokenChunkControls";
import { InlineError, StatusBadge } from "../../components/ui/ui";
import { useModelChoice, selectProps } from "../../app/providers";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
export function CorpusSettings({ pid, detail, refresh }: { pid: string; detail: CorpusDetail; refresh: () => void }) {
  const location = useLocation();
  const p = detail.corpus,
    meta = p.settings.corpus!,
    choice = useModelChoice();
  const [name, setName] = useState(p.name),
    [ontology, setOntology] = useState(meta.requestedOntologyRevisionId),
    [chunking, setChunking] = useState<ChunkSettings>(
      meta.chunking ?? { method: "section", maxChars: 12000, overlap: 0.12, unit: "tokens" },
    );
  const versions = useQuery({ queryKey: qk.revisions(meta.parentProjectId), queryFn: () => api.listRevisions(meta.parentProjectId) });
  const save = useMutation({
    mutationFn: () =>
      corpusApi.settings(pid, {
        name,
        ontologyRevisionId: ontology,
        chunking,
        provider: chunking.unit === "tokens" ? chunking.tokens!.generation.provider : choice.provider,
        model: chunking.unit === "tokens" ? chunking.tokens!.generation.model : choice.model,
      }),
    onSuccess: refresh,
  });
  const current = detail.graph.content.corpus!.ontology;
  return (
    <div className="corpus-settings">
      <section className="card">
        <h2>Graph identity and ontology</h2>
        <p className="field-hint">The published graph keeps its current ontology until an upgrade is extracted, reviewed and saved.</p>
        <div className="corpus-form">
          <label className="field">
            <span>Graph name</span>
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Ontology for the next update</span>
            <select value={ontology} onChange={(e) => setOntology(e.target.value)}>
              {versions.data
                ?.filter((v) => v.status === "committed" && v.stats.modules > 0)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    Ontology version {v.tboxVersion ?? v.number} · {v.summary}
                  </option>
                ))}
            </select>
          </label>
          <p>
            Current graph uses{" "}
            <Link
              to={`/p/${current.projectId}/ontology?tab=review&rev=${current.revisionId}`}
              state={{ graphReturn: { id: pid, name: p.name, to: location.pathname + location.search } }}
            >
              ontology version {current.number}
            </Link>
            .
          </p>
          {ontology !== current.revisionId && (
            <div className="banner warn">
              The extraction plan will show the sources and graph changes affected by this upgrade. The current graph remains available.
            </div>
          )}
        </div>
      </section>
      <section className="card">
        <h2>Preparation and extraction defaults</h2>
        <p className="field-hint">
          Choose models and separate token budgets before preparing source documents. A change marks affected sources for reprocessing;
          previously published versions remain intact.
        </p>
        <TokenChunkControls pid={pid} settings={chunking} onChange={setChunking} />
        {chunking.unit !== "tokens" && <ProviderModelSelect {...selectProps(choice)} structuredOnly />}
        <label className="field">
          <span>Chunk boundaries</span>
          <select value={chunking.method} onChange={(e) => setChunking({ ...chunking, method: e.target.value as ChunkSettings["method"] })}>
            <option value="section">Sections and paragraphs</option>
            <option value="paragraph">Paragraphs</option>
            <option value="fixed">Fixed windows</option>
          </select>
        </label>
      </section>
      <section className="card">
        <h2>Review policy</h2>
        <StatusBadge tone="info">Only accepted facts appear in answers and exports</StatusBadge>
        <p className="field-hint">
          New extraction claims are proposed for review. A located quote, an automatic entailment check and a person's decision are shown
          separately. Rejected claims and unresolved relationships remain in history.
        </p>
      </section>
      <div className="row-actions">
        <button className="btn" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save graph settings"}
        </button>
        {save.isSuccess && <span role="status">Settings saved. Review the updated extraction plan.</span>}
      </div>
      <InlineError error={save.error ?? versions.error} />
    </div>
  );
}
