import { ChunkConfigurationControls } from "./ChunkConfigurationControls";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import { CHUNK_METHODS, chunkMetrics, chunkSettingsKey } from "../../lib/research";
import { chunkCoverage } from "../../lib/chunkCoverage";
import type { DocumentChunk, ProjectDocument } from "../../types/project";
import type { ChunkExperiment, ChunkMetrics, ChunkSettings } from "../../types/research";
import type { GenerationModelChoice } from "../../lib/buildPreparation";
import { ErrorState, InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { JsonDetails, ResultTable, saveJson } from "./ResearchResults";
import { validChunkSettings } from "../../lib/chunkBatch";
import { useEvidenceViewer } from "../evidence/useEvidence";

export function ChunkBrowser({
  chunks,
  documentLength,
  label = "Chunks",
  onInspect,
}: {
  chunks: DocumentChunk[];
  documentLength?: number;
  label?: string;
  onInspect?: (chunk: DocumentChunk) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const filtered = chunks.filter(
    (c) =>
      !filter ||
      c.text.toLowerCase().includes(filter.toLowerCase()) ||
      c.sectionPath?.join(" ").toLowerCase().includes(filter.toLowerCase()),
  );
  const chunk = filtered.find((c) => c.id === selected) ?? filtered[0];
  const coverage = useMemo(
    () => (documentLength === undefined ? undefined : chunkCoverage(chunks, documentLength)),
    [chunks, documentLength],
  );
  const isLastChunk = chunk && !chunks.some((c) => c.end > chunk.end || (c.end === chunk.end && c.ordinal > chunk.ordinal));
  const overlap = chunk?.overlap ?? 0;
  const pages = Math.max(1, Math.ceil(filtered.length / 30));
  const index = Math.min(page, pages - 1);
  const largest = chunks.reduce((max, c) => Math.max(max, c.end - c.start), 1);
  return (
    <div className="chunk-browser">
      {coverage && (
        <div className="chunk-coverage" role="status" aria-label="Parsed text coverage">
          <div>
            <strong>Parsed text coverage</strong>
            <p>
              {coverage.covered.toLocaleString()} / {coverage.total.toLocaleString()} characters covered · {chunks.length.toLocaleString()}{" "}
              chunks
            </p>
            <p className="chunk-coverage-note">
              {coverage.missing.toLocaleString()} characters missing. Overlap is counted once. Coverage includes all chunks, regardless of
              search or page.
            </p>
          </div>
          <StatusBadge tone={coverage.total === 0 ? "muted" : coverage.complete ? "ok" : "warn"}>
            {coverage.total === 0 ? "No parsed text" : coverage.complete ? "100% covered" : "Incomplete coverage"}
          </StatusBadge>
        </div>
      )}
      <div className="chunk-list">
        <label className="field">
          <span>Search {label.toLowerCase()}</span>
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            placeholder="Text or section heading"
          />
        </label>
        <div className="chunk-buttons">
          {filtered.slice(index * 30, index * 30 + 30).map((c) => (
            <button
              key={c.id}
              className={c.id === chunk?.id ? "is-selected" : ""}
              onClick={() => setSelected(c.id)}
              aria-pressed={c.id === chunk?.id}
            >
              <span>Chunk {c.ordinal + 1}</span>
              <small>
                {c.tokenization
                  ? `${c.tokenization.generation.count.toLocaleString()} ${c.tokenization.generation.exact ? "tokens" : "est. tokens"} · `
                  : ""}
                {(c.end - c.start).toLocaleString()} chars{c.page ? ` · p. ${c.page}${c.pageEnd ? `–${c.pageEnd}` : ""}` : ""}
              </small>
              <span className="chunk-size" style={{ width: `${Math.max(2, ((c.end - c.start) / largest) * 100)}%` }} />
            </button>
          ))}
        </div>
        {pages > 1 && (
          <div className="research-pagination">
            <button className="btn ghost sm" disabled={!index} onClick={() => setPage(index - 1)}>
              ←
            </button>
            <span>
              {index + 1}/{pages}
            </span>
            <button className="btn ghost sm" disabled={index + 1 >= pages} onClick={() => setPage(index + 1)}>
              →
            </button>
          </div>
        )}
      </div>
      <div className="chunk-content">
        {chunk ? (
          <>
            <div className="research-section-head">
              <h3>Chunk {chunk.ordinal + 1}</h3>
              {onInspect && (
                <button className="btn ghost sm" type="button" onClick={() => onInspect(chunk)}>
                  Inspect evidence
                </button>
              )}
              <StatusBadge tone="info">{(chunk.end - chunk.start).toLocaleString()} characters</StatusBadge>
            </div>
            <p className="field-hint">
              Offsets [{chunk.start.toLocaleString()}, {chunk.end.toLocaleString()}) · {chunk.overlap ?? 0} leading context characters ·{" "}
              {chunk.page ? `page ${chunk.page}${chunk.pageEnd ? `–${chunk.pageEnd}` : ""}` : "page unavailable"}
            </p>
            <p className="chunk-path">{chunk.sectionPath?.join(" / ") || "No detected section heading"}</p>
            <p className="field-hint">
              {overlap > 0 ? (
                <>
                  <mark>Highlighted text</mark> is carried over from the previous chunk as context.
                </>
              ) : chunk.ordinal === 0 ? (
                "First chunk: there is no previous text to carry over or highlight."
              ) : (
                "This chunk has no leading overlap to highlight."
              )}{" "}
              Offsets use JavaScript UTF-16 code units in the parsed text.{" "}
              {chunk.tokenization
                ? `Token budget: ${chunk.tokenization.generation.count.toLocaleString()} ${chunk.tokenization.generation.exact ? "tokens" : "estimated tokens"}; ${chunk.tokenization.embeddingPassages.length} embedding passages. Character offsets preserve source evidence.`
                : "This historical chunk uses character-based sizing."}
            </p>
            {chunk.tokenization && (
              <details className="research-json">
                <summary>Embedding passage boundaries & token counts</summary>
                <ResultTable
                  label="Embedding passages (heading context included)"
                  rows={chunk.tokenization.embeddingPassages.map((p) => ({ ...p }))}
                  columns={["start", "end", "tokens"]}
                />
              </details>
            )}
            <div className="chunk-text-scroll">
              <pre className="chunk-text">
                {overlap > 0 && <mark>{chunk.text.slice(0, overlap)}</mark>}
                {chunk.text.slice(overlap)}
              </pre>
              {isLastChunk && coverage && (
                <div className="chunk-end-marker" data-tone={coverage.complete ? "ok" : "warn"}>
                  <strong>{coverage.missingTail === 0 ? "End of document" : "End of available chunks"}</strong>
                  <p>
                    {coverage.missingTail > 0
                      ? `${coverage.missingTail.toLocaleString()} characters remain after this chunk.`
                      : coverage.complete
                        ? `All ${coverage.total.toLocaleString()} parsed characters are covered. Nothing remains after this chunk.`
                        : `Nothing remains after this chunk, but ${coverage.missing.toLocaleString()} characters are uncovered elsewhere in the document.`}
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="muted">No matching chunks. Empty or image-only documents may need OCR or vision extraction.</p>
        )}
      </div>
    </div>
  );
}

function MetricComparison({ baseline, preview }: { baseline: ChunkMetrics; preview?: ChunkMetrics }) {
  const metrics: { key: keyof ChunkMetrics; label: string }[] = [
    { key: "count", label: "Chunks" },
    { key: "meanChars", label: "Mean characters" },
    { key: "maxChars", label: "Largest chunk" },
    { key: "overlapPercent", label: "Leading context %" },
  ];
  return (
    <div className="research-metrics">
      {metrics.map(({ key, label }) => (
        <div key={key}>
          <small>{label}</small>
          <strong>
            {baseline[key].toLocaleString()}
            {preview && (
              <>
                <span className="muted"> → </span>
                {preview[key].toLocaleString()}
              </>
            )}
          </strong>
          <span>{preview ? "Stored → experiment" : "Stored chunks"}</span>
        </div>
      ))}
    </div>
  );
}

export function ChunkLab({
  pid,
  doc,
  defaults,
  onUseVariant,
  configure = false,
  onModelChoice,
}: {
  pid: string;
  doc: ProjectDocument;
  defaults: ChunkSettings;
  configure?: boolean;
  onUseVariant?: (doc: ProjectDocument) => void;
  onModelChoice?: (choice: GenerationModelChoice) => void;
}) {
  const text = useQuery({ queryKey: qk.documentText(pid, doc.id), queryFn: () => api.documentText(pid, doc.id) });
  const evidence = useEvidenceViewer(pid);
  const qc = useQueryClient();
  const [settings, setSettings] = useState<ChunkSettings>({ ...(doc.preprocessing?.settings ?? defaults), unit: "tokens" });
  const [show, setShow] = useState<"stored" | "experiment">("stored");
  const [detail, setDetail] = useState<"chunks" | "structure">("chunks");
  const previewSource = { hash: text.data?.textHash, parsing: doc.parsing, pages: text.data?.pages, sections: text.data?.sections };
  const previewKey = (s: ChunkSettings) => ["chunk-preview", pid, doc.id, previewSource, chunkSettingsKey(s)];
  const experiment = useQuery<ChunkExperiment>({
    queryKey: previewKey(settings),
    queryFn: () => api.previewChunks(pid, doc.id, settings),
    enabled: false,
    staleTime: Infinity,
  });
  const preview = useMutation({
    mutationFn: (s: ChunkSettings) =>
      qc.fetchQuery({
        queryKey: previewKey(s),
        queryFn: () => api.previewChunks(pid, doc.id, s),
        staleTime: Infinity,
      }),
    onSuccess: () => setShow("experiment"),
  });
  const save = useMutation({
    mutationFn: () => api.saveChunkVariant(pid, doc.id, experiment.data!.settings, experiment.data!.textHash),
    onSuccess: async (doc) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.documents(pid) }),
        qc.invalidateQueries({ queryKey: qk.documentText(pid, doc.id) }),
      ]);
      if (configure) onUseVariant?.(doc);
    },
  });
  const stored = useMemo(
    () => text.data?.chunks.map((c) => ({ ...c, projectId: pid, text: text.data!.text.slice(c.start, c.end) })) ?? [],
    [text.data, pid],
  );
  const savedCurrent = [doc, save.data].find(
    (d) =>
      d?.parseState === "parsed" &&
      d.chunkCount > 0 &&
      (d.id !== doc.id || stored.length === d.chunkCount) &&
      d.preprocessing?.textHash === text.data?.textHash &&
      d.preprocessing &&
      d.preprocessing.version === (settings.unit === "tokens" ? "chunking-tokens-v1" : "chunking-v1") &&
      chunkSettingsKey(settings) === chunkSettingsKey(d.preprocessing.settings),
  );
  const changed = !savedCurrent && !experiment.data && (!!doc.preprocessing || !!preview.data);
  const valid = validChunkSettings(settings);
  if (text.isLoading) return <LoadingState label="Loading parsed document and chunk boundaries…" />;
  if (text.error) return <ErrorState error={text.error} onRetry={() => void text.refetch()} />;
  return (
    <div className="research-stack">
      {!configure && (
        <section className="card">
          <div className="research-section-head">
            <div>
              <span className="research-eyebrow">01 / Preprocessing</span>
              <h2>From document to chunks</h2>
            </div>
            <StatusBadge tone={doc.preprocessing ? "ok" : "warn"}>
              {doc.preprocessing ? "Parameters recorded" : "Historical parameters unavailable"}
            </StatusBadge>
          </div>
          <div className="research-provenance">
            <span>
              <strong>Parser</strong>
              {doc.parser === "docling"
                ? "Docling · layout-aware"
                : doc.parser === "node"
                  ? ((
                      {
                        pdf: "PDF.js · text layer",
                        docx: "Mammoth · HTML structure",
                        html: "HTML block parser",
                        text: /\.md(?:$| ·)/i.test(doc.name) ? "Markdown structure parser" : "Plain text / heading heuristics",
                      } as Record<string, string>
                    )[doc.kind] ?? "Built-in Node parser")
                  : "Not recorded"}
            </span>
            <span>
              <strong>OCR</strong>
              {doc.ocr ? "Used" : "Not recorded as used"}
            </span>
            <span>
              <strong>Structure</strong>
              {text.data?.pages.length ?? 0} pages · {text.data?.sections?.length ?? 0} sections · {text.data?.tables?.length ?? 0} tables
            </span>
          </div>
          <p className="field-hint">
            {doc.preprocessing
              ? `Stored method: ${CHUNK_METHODS[doc.preprocessing.settings.method].name} · base budget ${(doc.preprocessing.settings.tokens?.generation.maxTokens ?? doc.preprocessing.settings.maxChars).toLocaleString()} ${doc.preprocessing.settings.unit === "tokens" ? "tokens per generation chunk" : "characters"} · requested overlap ${Math.round(doc.preprocessing.settings.overlap * 100)}%.`
              : "Stored chunk boundaries are available, but the original parameter values were not saved. The experiment controls below start from current server defaults."}
          </p>
          <MetricComparison baseline={chunkMetrics(stored)} preview={experiment.data?.metrics} />
          <details className="research-json">
            <summary>Source identity and preprocessing record</summary>
            <dl className="research-kv">
              <dt>Original SHA-256</dt>
              <dd>{doc.checksum}</dd>
              <dt>Parsed text SHA-256</dt>
              <dd>{doc.preprocessing?.textHash ?? "Not recorded"}</dd>
              <dt>Preprocessing duration</dt>
              <dd>{doc.preprocessing ? `${doc.preprocessing.durationMs} ms` : "Not recorded"}</dd>
              <dt>Source variant of</dt>
              <dd>{doc.variantOf ?? "Original document"}</dd>
            </dl>
          </details>
        </section>
      )}
      <section className="card">
        <div className="research-section-head">
          <div>
            <span className="research-eyebrow">{configure ? "Chunk configuration" : "Experiment controls"}</span>
            <h3>{configure ? "Choose how to divide this document" : "Compare a chunking configuration"}</h3>
          </div>
          <span className="muted">No model call</span>
        </div>
        <ChunkConfigurationControls pid={pid} settings={settings} onChange={setSettings} onModelChoice={onModelChoice} />
        <div className="row-actions">
          <button
            className="btn"
            disabled={!valid || !!savedCurrent || !!experiment.data || preview.isPending || save.isPending}
            onClick={() => {
              save.reset();
              preview.mutate(settings);
            }}
          >
            {preview.isPending
              ? configure
                ? "Generating chunks…"
                : "Computing…"
              : savedCurrent
                ? "Chunks up to date"
                : experiment.data
                  ? "Preview up to date"
                  : configure
                    ? "Generate chunks"
                    : "Preview experiment"}
          </button>
          <button
            className="btn ghost"
            disabled={save.isPending || preview.isPending || (savedCurrent ? !configure || !onUseVariant : !experiment.data || changed)}
            onClick={() => (savedCurrent ? onUseVariant?.(savedCurrent) : save.mutate())}
          >
            {save.isPending
              ? "Saving…"
              : savedCurrent
                ? configure
                  ? "Use existing chunks"
                  : "Configuration saved"
                : experiment.data?.reusedDocumentId
                  ? configure
                    ? "Use existing chunks"
                    : "Use saved configuration"
                  : configure
                    ? "Use these chunks"
                    : "Save as document variant"}
          </button>
          {experiment.data && (
            <button
              className="btn ghost"
              onClick={() =>
                saveJson({ sourceDocumentId: doc.id, sourceChecksum: doc.checksum, ...experiment.data }, "chunking-experiment.json")
              }
            >
              Export experiment
            </button>
          )}
        </div>
        {!valid && <p className="banner warn">Check model selection, size budgets and 0–30% overlap.</p>}
        {savedCurrent && (
          <p className="banner subtle" role="status">
            Using {savedCurrent.chunkCount} saved chunks. Change the settings to generate a different configuration.
          </p>
        )}
        {!savedCurrent && experiment.data?.reusedDocumentId && (
          <p className="banner subtle" role="status">
            This configuration is already saved. Use it to reuse the existing chunks.
          </p>
        )}
        {experiment.data?.tokenization && (
          <div className="token-preview-summary" role="status">
            <p>
              <strong>Full document coverage</strong> · {experiment.data.tokenization.embeddingPassages} embedding passages ·{" "}
              {experiment.data.chunks.length} generation chunks
            </p>
            <p>
              Generation chunks total (excluding prompts): {experiment.data.tokenization.generation.count.toLocaleString()}{" "}
              {experiment.data.tokenization.generation.exact ? "tokens · exact tokenizer" : "estimated tokens"} ·{" "}
              {experiment.data.tokenization.generation.tokenizer}
            </p>
            <p>
              Embedding passages total (including heading context): {experiment.data.tokenization.embedding.count.toLocaleString()}{" "}
              {experiment.data.tokenization.embedding.exact ? "tokens · exact tokenizer" : "estimated tokens"} ·{" "}
              {experiment.data.tokenization.embedding.tokenizer}
            </p>
            {experiment.data.tokenization.embedding.note && <p>{experiment.data.tokenization.embedding.note}</p>}
          </div>
        )}
        {changed && (
          <p className="banner subtle">
            {configure
              ? "Settings changed. Generate chunks again before using them."
              : "Controls changed. Preview again to inspect and save these settings."}
          </p>
        )}
        <InlineError error={preview.error ?? save.error} />
        {save.data && !configure && (
          <div className="banner subtle" role="status">
            Saved “{save.data.name}”.{" "}
            {onUseVariant ? (
              <button className="btn sm" onClick={() => onUseVariant(save.data!)}>
                Use this variant in this workflow
              </button>
            ) : (
              <>
                Select this variant instead of the original for your next <Link to={`/p/${pid}/workflows/abox`}>A-Box run</Link> or{" "}
                <Link to={`/p/${pid}/workflows/tbox`}>T-Box induction</Link>.
              </>
            )}
          </div>
        )}
        <p className="field-hint">
          Existing configurations are reused. New configurations create a separate variant; previous runs remain intact.
        </p>
      </section>
      <section className="card research-output">
        <div className="research-section-head">
          <h3>Inspect the result</h3>
          <div className="research-tabs" role="group" aria-label="Preprocessing output">
            <button aria-pressed={detail === "chunks"} onClick={() => setDetail("chunks")}>
              Chunks
            </button>
            <button aria-pressed={detail === "structure"} onClick={() => setDetail("structure")}>
              Parsed structure
            </button>
          </div>
        </div>
        {detail === "chunks" ? (
          <>
            <div className="research-tabs" role="group" aria-label="Chunk set">
              <button aria-pressed={show === "stored"} onClick={() => setShow("stored")}>
                Stored · {stored.length}
              </button>
              <button disabled={!experiment.data} aria-pressed={show === "experiment"} onClick={() => setShow("experiment")}>
                Experiment · {experiment.data?.chunks.length ?? "—"}
              </button>
            </div>
            {show === "experiment" && experiment.data && (
              <p className="field-hint">
                Showing {CHUNK_METHODS[experiment.data.settings.method].name}, {experiment.data.settings.maxChars} characters,{" "}
                {Math.round(experiment.data.settings.overlap * 100)}% overlap.
              </p>
            )}
            <ChunkBrowser
              key={`${show}-${preview.submittedAt}`}
              chunks={show === "experiment" && experiment.data ? experiment.data.chunks : stored}
              documentLength={text.data?.text.length}
              onInspect={(chunk) =>
                show === "experiment"
                  ? evidence.openTarget({
                      kind: "reference",
                      documentId: doc.id,
                      quote: chunk.text.slice(0, 4000),
                      start: chunk.start,
                      end: chunk.end,
                      preview: true,
                    })
                  : evidence.openTarget({ kind: "passage", documentId: doc.id, chunkId: chunk.id })
              }
            />
          </>
        ) : (
          <>
            <ResultTable
              label="Detected sections"
              rows={(text.data?.sections ?? []).map((s) => ({ ...s }))}
              columns={["title", "level", "path", "start", "end"]}
            />
            <ResultTable
              label="Table spans in parsed text"
              rows={(text.data?.tables ?? []).map((t) => ({ ...t, text: text.data!.text.slice(t.start, t.end) }))}
              columns={["page", "start", "end", "text"]}
            />
            <JsonDetails label="Inspect page spans" value={text.data?.pages} />
          </>
        )}
      </section>
    </div>
  );
}
