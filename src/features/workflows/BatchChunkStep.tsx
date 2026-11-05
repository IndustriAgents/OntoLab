import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import type { ProjectDocument } from "../../types/project";
import type { ChunkSettings } from "../../types/research";
import type { GenerationModelChoice } from "../../lib/buildPreparation";
import { chunkSettingsKey } from "../../lib/research";
import { groupSourceDocuments, sourceDocumentName } from "../../lib/documentSources";
import { hasMatchingChunks, previewChunkBatch, saveChunkBatch, validChunkSettings, type ChunkBatchItem } from "../../lib/chunkBatch";
import { ErrorState, InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { ChunkConfigurationControls } from "../research/ChunkConfigurationControls";
import { PreprocessingStep } from "./DocumentSteps";
import { ChunkBrowser } from "../research/ChunkLab";

interface Props {
  pid: string;
  documents: ProjectDocument[];
  allDocuments: ProjectDocument[];
  selected: string[];
  onUseVariants: (documents: ProjectDocument[]) => void;
  onModelChoice: (choice: GenerationModelChoice) => void;
}

export function BatchChunkStep(props: Props) {
  const defaults = useQuery({
    queryKey: ["chunk-defaults", props.pid],
    queryFn: () => api.chunkDefaults(props.pid),
    enabled: props.documents.length > 0,
  });
  return (
    <div className="workflow-stack">
      <div className="workflow-section-title">
        <div>
          <h2>Chunk all selected documents</h2>
          <p>Choose shared settings once. Generate and save chunks for every selected file, then inspect individual results if needed.</p>
        </div>
      </div>
      {!props.documents.length ? (
        <p className="muted">Select original files in Documents before configuring chunks.</p>
      ) : defaults.isLoading ? (
        <LoadingState label="Loading chunk settings…" />
      ) : defaults.error ? (
        <ErrorState error={defaults.error} onRetry={() => void defaults.refetch()} />
      ) : (
        defaults.data && <BatchChunkControls {...props} defaults={defaults.data} />
      )}
    </div>
  );
}

function BatchChunkControls({
  pid,
  documents,
  allDocuments,
  selected,
  onUseVariants,
  onModelChoice,
  defaults,
}: Props & { defaults: ChunkSettings }) {
  const qc = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const groups = groupSourceDocuments(documents);
  const sources = groups.map((group) => group.document);
  const duplicateSources = groups.some((group) => group.configurations.length > 1);
  const missingSources = selected.filter((id) => !documents.some((document) => document.id === id)).length;
  const [settings, setSettings] = useState<ChunkSettings>(() => {
    const saved = documents.find((document) => document.preprocessing)?.preprocessing?.settings;
    return { ...(saved ?? defaults), unit: saved?.unit ?? (saved ? "characters" : "tokens") };
  });
  const [inspected, setInspected] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (inspected) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [inspected]);
  const key = JSON.stringify([
    sources.map((document) => [document.id, document.checksum, document.parsing?.textHash]),
    chunkSettingsKey(settings),
  ]);
  const [batch, setBatch] = useState<{ key: string; items: ChunkBatchItem[] } | null>(null);
  const items = batch?.key === key ? batch.items : [];
  const publish = (items: ChunkBatchItem[]) => setBatch({ key, items });
  const preview = useMutation({
    mutationFn: () => previewChunkBatch(pid, sources, settings, api, items, publish),
    onSuccess: publish,
  });
  const save = useMutation({
    mutationFn: () => saveChunkBatch(pid, items, api, publish),
    onSuccess: async (results) => {
      publish(results);
      if (!results.length || !results.every((item) => !!item.saved)) return;
      const prepared = results.map((item) => item.saved!);
      // Publish the new records before navigating to variant IDs.
      await qc.invalidateQueries({ queryKey: qk.documents(pid) });
      await Promise.all(
        [...new Set([...sources, ...prepared].map((document) => document.id))].map((id) =>
          qc.invalidateQueries({ queryKey: qk.documentText(pid, id) }),
        ),
      );
      if (!mounted.current) return;
      setInspected(null);
      onUseVariants(prepared);
    },
  });
  const busy = preview.isPending || save.isPending;
  const valid = validChunkSettings(settings);
  const alreadySaved = sources.every((document) => hasMatchingChunks(document, settings));
  const allPreviewed = items.length === sources.length && items.every((item) => !!item.preview);
  const errors = items.filter((item) => item.error).length;
  const ready = items.filter((item) => !!item.preview).length;
  const complete = items.filter((item) => !!item.saved).length;
  const current = sources.find((document) => document.id === inspected);
  const currentPreview = items.find((item) => item.document.id === inspected)?.preview;
  return (
    <>
      <section className="card chunk-batch-settings">
        <div className="research-section-head">
          <div>
            <span className="research-eyebrow">All selected files</span>
            <h3>Shared chunk settings</h3>
          </div>
          <StatusBadge tone="info">
            {sources.length} document{sources.length === 1 ? "" : "s"}
          </StatusBadge>
        </div>
        <p className="field-hint">
          These settings apply to all {sources.length} selected files. Each file keeps its own chunk boundaries and original.
        </p>
        <fieldset className="chunk-batch-controls" disabled={busy}>
          <legend className="sr-only">Shared chunk settings</legend>
          <ChunkConfigurationControls pid={pid} settings={settings} onChange={setSettings} onModelChoice={onModelChoice} />
        </fieldset>
        <div className="row-actions">
          <button
            className="btn"
            disabled={busy || !valid || duplicateSources || missingSources > 0 || alreadySaved || (allPreviewed && !errors)}
            onClick={() => preview.mutate()}
          >
            {preview.isPending
              ? "Generating chunks…"
              : alreadySaved
                ? "Chunks up to date"
                : errors
                  ? "Retry failed files"
                  : "Generate chunks for all"}
          </button>
          <button
            className="btn ghost"
            disabled={busy || duplicateSources || missingSources > 0 || (!alreadySaved && !allPreviewed)}
            onClick={() => (alreadySaved ? onUseVariants(sources) : save.mutate())}
          >
            {save.isPending
              ? "Saving chunks…"
              : alreadySaved
                ? "Use existing chunks for all"
                : errors
                  ? "Retry saving chunks"
                  : "Use these chunks for all"}
          </button>
          <span className="field-hint">Ontology generation starts separately in Generate.</span>
        </div>
        {!valid && <p className="banner warn">Check model selection, size budgets and 0–30% overlap.</p>}
        {missingSources > 0 && (
          <p className="banner warn" role="alert">
            {missingSources} selected input{missingSources === 1 ? " is" : "s are"} unavailable. Update the file selection in Documents
            before generating chunks.
          </p>
        )}
        {duplicateSources && (
          <p className="banner warn" role="alert">
            Multiple configurations of the same file are selected. Use Inspect or customize below to choose one per file.
          </p>
        )}
        {batch && batch.key !== key && <p className="banner subtle">Settings changed. Generate chunks again before using them.</p>}
        {items.length > 0 && (
          <p className={errors ? "banner warn" : "banner subtle"} role="status">
            {complete ? `${complete} of ${sources.length} saved` : `${ready} of ${sources.length} prepared`}
            {errors ? ` · ${errors} failed. Successful files are kept when retrying.` : ""}
          </p>
        )}
        <InlineError error={preview.error ?? save.error} />
        {busy && (
          <progress
            className="chunk-batch-progress"
            max={sources.length}
            value={
              items.filter((item) =>
                save.isPending
                  ? item.phase === "saved" || item.phase === "error"
                  : item.phase === "ready" || item.phase === "saved" || item.phase === "error",
              ).length
            }
            aria-label={save.isPending ? "Saving chunks progress" : "Generating chunks progress"}
          />
        )}
      </section>
      <section className="card chunk-batch-results" aria-label="Chunk results by document">
        <div className="research-section-head">
          <h3>Selected documents</h3>
          <span className="field-hint">Inspect or customize individual files</span>
        </div>
        <div className="chunk-batch-list">
          {sources.map((document) => {
            const item = items.find((item) => item.document.id === document.id);
            const phase = item?.phase;
            const count = item?.preview?.chunks.length ?? document.chunkCount;
            const label =
              phase === "preparing"
                ? "Generating…"
                : phase === "saving"
                  ? "Saving…"
                  : phase === "error"
                    ? "Failed"
                    : phase === "ready"
                      ? item?.preview?.reusedDocumentId
                        ? "Saved configuration available"
                        : "Ready to use"
                      : phase === "saved" || hasMatchingChunks(document, settings)
                        ? "Saved"
                        : document.chunkCount
                          ? "Saved · different settings"
                          : "Not configured";
            return (
              <div className="chunk-batch-row" key={document.id} data-chunk-document-id={document.id}>
                <div className="chunk-batch-file">
                  <strong>{sourceDocumentName(document, allDocuments)}</strong>
                  <span>{count.toLocaleString()} chunks</span>
                  {item?.error && (
                    <p className="row-error" role="alert">
                      {item.error}
                    </p>
                  )}
                </div>
                <StatusBadge
                  tone={
                    phase === "error"
                      ? "alert"
                      : phase === "saved" || phase === "ready" || hasMatchingChunks(document, settings)
                        ? "ok"
                        : "info"
                  }
                >
                  {label}
                </StatusBadge>
                <button
                  className="btn ghost sm"
                  aria-expanded={inspected === document.id}
                  disabled={busy}
                  onClick={() => setInspected(inspected === document.id ? null : document.id)}
                >
                  Inspect or customize
                </button>
              </div>
            );
          })}
        </div>
      </section>
      {current && !busy && (
        <section
          ref={detailRef}
          className="card chunk-batch-detail"
          aria-label={`Individual settings for ${sourceDocumentName(current, allDocuments)}`}
        >
          <div className="research-section-head">
            <h3>Individual document</h3>
            <button className="btn ghost sm" onClick={() => setInspected(null)}>
              Close individual view
            </button>
          </div>
          {currentPreview ? (
            <ChunkBrowser chunks={currentPreview.chunks} documentLength={current.charCount} label="Prepared chunks" />
          ) : (
            <SavedChunkPreview pid={pid} document={current} />
          )}
          <details className="chunk-batch-customize">
            <summary>Customize this document</summary>
            <PreprocessingStep
              key={current.id}
              pid={pid}
              doc={current}
              mode="chunks"
              documents={allDocuments}
              selectedDocumentIds={selected}
              onModelChoice={onModelChoice}
              onUseVariant={(document) => onUseVariants([document])}
            />
          </details>
        </section>
      )}
    </>
  );
}

function SavedChunkPreview({ pid, document }: { pid: string; document: ProjectDocument }) {
  const text = useQuery({ queryKey: qk.documentText(pid, document.id), queryFn: () => api.documentText(pid, document.id) });
  if (text.isLoading) return <LoadingState label="Loading saved chunks…" />;
  if (text.error) return <ErrorState error={text.error} onRetry={() => void text.refetch()} />;
  const chunks = (text.data?.chunks ?? []).map((chunk) => ({
    ...chunk,
    projectId: pid,
    text: text.data!.text.slice(chunk.start, chunk.end),
  }));
  return <ChunkBrowser chunks={chunks} documentLength={text.data?.text.length} label="Saved chunks" />;
}
