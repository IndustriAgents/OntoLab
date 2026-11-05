import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, qk } from "../../lib/projectApi";
import type { ProjectDocument } from "../../types/project";
import type { ResearchInputs } from "../../types/research";
import { Dropzone } from "../../components/Dropzone";
import { ConfirmButton, ErrorState, InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { useAuth } from "../../app/auth";
import { DocumentInspection } from "../documents/DocumentInspection";
import { ParseBadge, useDocumentUpload } from "../documents/useDocumentUpload";
import { ChunkBrowser, ChunkLab } from "../research/ChunkLab";
import { JsonDetails, ResultTable } from "../research/ResearchResults";
import { CHUNK_METHODS, chunkMetrics } from "../../lib/research";
import { MethodDetails } from "./MethodDetails";
import { buildSourceRelation } from "../../lib/buildChanges";
import type { GenerationModelChoice } from "../../lib/buildPreparation";
import { fmtSize } from "../../lib/format";
import { useEvidenceViewer } from "../evidence/useEvidence";
import {
  chunkConfigurationLabel,
  groupSourceDocuments,
  removeSourceDocuments,
  selectSourceConfiguration,
  sourceDocumentName,
} from "../../lib/documentSources";

export function DocumentSources({
  pid,
  documents,
  selected,
  onSelect,
  onInspect,
  previousBuild,
  preferredModel,
  loading = false,
}: {
  pid: string;
  documents: ProjectDocument[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onInspect: (id: string, view?: "text" | "original") => void;
  previousBuild?: { id: string; documentIds: string[]; documents?: ResearchInputs["documents"] };
  preferredModel?: GenerationModelChoice;
  loading?: boolean;
}) {
  const { config } = useAuth();
  const qc = useQueryClient();
  const upload = useDocumentUpload(pid);
  const [configurationChoices, setConfigurationChoices] = useState<Record<string, string>>({});
  const sources = groupSourceDocuments(documents);
  const unavailable = selected.filter((id) => !documents.some((document) => document.id === id));
  const selectedSources = groupSourceDocuments(
    selected.map(
      (id) =>
        documents.find((document) => document.id === id) ??
        previousBuild?.documents?.find((document) => document.id === id) ?? { id, name: id },
    ),
  );
  const referenceSources = [...new Map([...documents, ...(previousBuild?.documents ?? [])].map((d) => [d.id, d])).values()];
  const relation = (d: Pick<ProjectDocument, "id" | "variantOf">) =>
    previousBuild ? buildSourceRelation(d, previousBuild.documentIds, referenceSources) : "other";
  const retry = useMutation({
    mutationFn: (id: string) => api.retryDocument(pid, id),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: qk.documents(pid) });
      if (d.parseState === "parsed") onSelect([...new Set([...selected, d.id])]);
    },
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => removeSourceDocuments(pid, ids, api),
    onSuccess: (_result, ids) => {
      onSelect(selected.filter((selectedId) => !ids.includes(selectedId)));
      qc.setQueryData<ProjectDocument[]>(qk.documents(pid), (docs) => docs?.filter((doc) => !ids.includes(doc.id)));
      for (const id of ids) {
        qc.removeQueries({ queryKey: qk.documentText(pid, id) });
        qc.removeQueries({ queryKey: ["original-file", pid, id] });
      }
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.documents(pid) }),
  });
  return (
    <div className="workflow-stack">
      <Dropzone
        formats={["PDF", "DOCX", "XLSX", "XLS", "TXT", "MD", "HTML", "XML"]}
        title="Add source documents"
        hint="Upload originals → automatic parsing → inspect text → configure chunks. Generation starts only when you choose it."
        accept={
          config?.features?.docling
            ? ".pdf,.docx,.xlsx,.xls,.txt,.md,.html,.xml,.pptx,.png,.jpg"
            : ".pdf,.docx,.xlsx,.xls,.txt,.md,.html,.xml"
        }
        multiple
        onFiles={(files) => {
          if (!upload.busy) void upload.upload(files);
        }}
      />
      {upload.progress}
      {!loading && unavailable.length > 0 && (
        <div className="banner warn workflow-inspection-note" role="alert">
          <span>
            {unavailable.length} selected input{unavailable.length === 1 ? " is" : "s are"} no longer available in this project.
          </span>
          <button className="btn ghost sm" onClick={() => onSelect(selected.filter((id) => !unavailable.includes(id)))}>
            Remove unavailable inputs
          </button>
        </div>
      )}
      {previousBuild && (
        <section className="workflow-source-summary" aria-label="Next build inputs">
          <div className="workflow-section-title">
            <h3>Selected for the next build</h3>
            <StatusBadge tone="info">
              {selectedSources.length} document{selectedSources.length === 1 ? "" : "s"}
            </StatusBadge>
          </div>
          <p>
            {selected.length
              ? "Your previous document selection is carried forward. Manage the originals below, then review parsed text and saved settings in Parsed text and Chunks."
              : "No files selected. Choose originals below."}
          </p>
          <Link to={`/p/${pid}/workflows/tbox?run=${previousBuild.id}&step=sources`}>View the previous build’s recorded inputs</Link>
        </section>
      )}
      <div className="workflow-section-title">
        <h2>Original documents</h2>
        <span>
          {selectedSources.length} selected · {sources.length} document{sources.length === 1 ? "" : "s"}
        </span>
      </div>
      {!!documents.length && (
        <p className="field-hint">
          Upload, view or delete original files here. Select files for this build; review their parsed text and configure chunks in the next
          steps.
        </p>
      )}
      {!documents.length ? (
        loading ? (
          <LoadingState label="Loading original documents…" />
        ) : (
          <p className="muted">Your uploaded documents will appear here.</p>
        )
      ) : (
        <div className="workflow-document-list">
          {sources.map((source) => {
            const selectedConfigurations = source.configurations.filter((configuration) => selected.includes(configuration.id));
            const included = selectedConfigurations.length > 0;
            const preferred =
              source.configurations.find((configuration) => {
                const generation = configuration.preprocessing?.settings.tokens?.generation;
                return (
                  configuration.preprocessing?.settings.unit === "tokens" &&
                  generation?.provider === preferredModel?.provider &&
                  generation?.model === preferredModel?.model
                );
              }) ??
              source.configurations.find((configuration) => previousBuild?.documentIds.includes(configuration.id)) ??
              source.document;
            const configuration =
              selectedConfigurations[0] ??
              source.configurations.find((configuration) => configuration.id === configurationChoices[source.id]) ??
              preferred;
            const d = source.document;
            return (
              <div className={`workflow-source${included ? " is-selected" : ""}`} data-source-id={source.id} key={source.id}>
                <div className="workflow-document" data-document-id={source.id}>
                  <label className="check" aria-label={`Select ${source.name}`}>
                    <input
                      type="checkbox"
                      disabled={((d.parseState !== "parsed" || !d.charCount) && !included) || remove.isPending}
                      checked={included}
                      onChange={(e) => {
                        setConfigurationChoices((previous) => ({ ...previous, [source.id]: configuration.id }));
                        onSelect(selectSourceConfiguration(selected, documents, source.id, e.target.checked ? configuration.id : null));
                      }}
                    />
                    <span>
                      <strong>{source.name}</strong>
                      <small>Original file · {fmtSize(d.sizeBytes)}</small>
                      {d.parseState === "failed" && <small className="row-error">{d.parseError}</small>}
                      {previousBuild && (
                        <small className="workflow-document-history">
                          {source.configurations.some((configuration) => relation(configuration) !== "other")
                            ? "Used in the previous build"
                            : "Not selected in the previous build"}
                        </small>
                      )}
                    </span>
                  </label>
                  <div className="workflow-document-status">
                    <StatusBadge tone={included ? "info" : "muted"}>{included ? "Selected" : "Not selected"}</StatusBadge>
                    <ParseBadge doc={d} />
                  </div>
                  <div className="workflow-document-actions" role="group" aria-label={`Actions for ${source.name}`}>
                    <button className="btn ghost sm" onClick={() => onInspect(d.id, "original")}>
                      View original
                    </button>
                    {d.parseState === "parsed" ? (
                      <button className="btn ghost sm" onClick={() => onInspect(configuration.id)}>
                        Inspect parsed text
                      </button>
                    ) : d.parseState === "failed" ? (
                      <button className="btn ghost sm" disabled={retry.isPending} onClick={() => retry.mutate(d.id)}>
                        Retry parsing
                      </button>
                    ) : (
                      <span className="muted">Original stored</span>
                    )}
                    <ConfirmButton
                      label={remove.isPending && remove.variables?.includes(d.id) ? "Deleting…" : "Delete file"}
                      confirmLabel="Delete file & configurations"
                      disabled={remove.isPending}
                      onConfirm={() => remove.mutate(source.configurations.map((configuration) => configuration.id))}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <InlineError error={remove.error ?? retry.error} />
      <MethodDetails>
        <p>
          Upload stores the original file with a SHA-256 identity. Parsing then runs automatically; chunking starts after you configure it.
          PDF.js reads PDF text layers; Mammoth converts DOCX to structured HTML. Excel workbooks become sheet sections and tables. HTML and
          Markdown use block/heading parsers. XML is extracted into reading text with element paths retained; the original stays available.
          When configured, Docling performs layout-aware extraction and OCR. Inspect the next step to see which parser actually ran.
        </p>
        <p>
          Deleting a file also removes its saved configurations from the project. Files used by an active build cannot be deleted until that
          build is cancelled or finishes.
        </p>
      </MethodDetails>
    </div>
  );
}

export function SavedChunkConfigurations({
  doc,
  documents,
  selected,
  onUseVariant,
}: {
  doc: ProjectDocument;
  documents: ProjectDocument[];
  selected: string[];
  onUseVariant?: (doc: ProjectDocument) => void;
}) {
  const sourceId = doc.variantOf ?? doc.id;
  const configurations = documents.filter((candidate) => (candidate.variantOf ?? candidate.id) === sourceId);
  if (!configurations.some((candidate) => candidate.chunkCount > 0)) return null;
  const multipleSelected = configurations.filter((candidate) => selected.includes(candidate.id)).length > 1;
  const settings = doc.preprocessing?.settings;
  const tokens = settings?.unit === "tokens" ? settings.tokens : undefined;
  return (
    <section className="card workflow-chunk-configurations" aria-label="Saved chunk configurations">
      <h3>Saved chunk configurations</h3>
      <p className="field-hint">Choose a saved configuration for this document, or adjust the settings below to create one.</p>
      <label className="field">
        <span>Configuration for this build</span>
        <select
          aria-label={`Chunk configuration for ${sourceDocumentName(doc, documents)}`}
          value={multipleSelected ? "" : doc.id}
          disabled={!onUseVariant}
          onChange={(event) => {
            const configuration = configurations.find((candidate) => candidate.id === event.target.value);
            if (configuration) onUseVariant?.(configuration);
          }}
        >
          {multipleSelected && (
            <option value="" disabled>
              Choose one configuration
            </option>
          )}
          {configurations.map((candidate) => (
            <option key={candidate.id} value={candidate.id} disabled={candidate.parseState !== "parsed" || !candidate.charCount}>
              {candidate.chunkCount ? chunkConfigurationLabel(candidate) : "Configure from parsed text"}
            </option>
          ))}
        </select>
      </label>
      {multipleSelected ? (
        <p className="banner warn" role="alert">
          Multiple configurations are selected for this document. Choose one to avoid including the same source twice.
        </p>
      ) : (
        <div className="workflow-configuration-metadata">
          <span>{doc.chunkCount} chunks</span>
          {settings && (
            <>
              <span>
                Budget: {(tokens?.generation.maxTokens ?? settings.maxChars).toLocaleString()} {tokens ? "tokens" : "characters"} ·{" "}
                {Math.round(settings.overlap * 100)}% overlap
              </span>
              <span>Method: {CHUNK_METHODS[settings.method].name}</span>
            </>
          )}
          {tokens && <span>Embedding: {tokens.embedding.profile}</span>}
        </div>
      )}
    </section>
  );
}

export function PreprocessingStep({
  pid,
  doc,
  mode,
  snapshot,
  runId,
  onUseVariant,
  onModelChoice,
  initialView = "text",
  documents = [],
  selectedDocumentIds = [],
}: {
  pid: string;
  doc: ProjectDocument | ResearchInputs["documents"][number];
  mode: "parse" | "chunks";
  snapshot?: ResearchInputs | null;
  runId?: string;
  onUseVariant?: (doc: ProjectDocument) => void;
  onModelChoice?: (choice: GenerationModelChoice) => void;
  initialView?: "text" | "original";
  documents?: ProjectDocument[];
  selectedDocumentIds?: string[];
}) {
  const evidence = useEvidenceViewer(pid);
  const text = useQuery({
    queryKey: qk.documentText(pid, doc.id),
    queryFn: () => api.documentText(pid, doc.id),
    enabled: !snapshot && doc.parseState === "parsed",
  });
  const defaults = useQuery({ queryKey: ["chunk-defaults", pid], queryFn: () => api.chunkDefaults(pid) });
  const savedText = snapshot?.documentTexts?.[doc.id];
  const currentText = savedText ?? (!snapshot ? text.data : undefined);
  const chunks = snapshot
    ? snapshot.chunks.filter((c) => c.documentId === doc.id)
    : (text.data?.chunks ?? []).map((c) => ({ ...c, projectId: pid, text: text.data!.text.slice(c.start, c.end) }));
  const stats = chunkMetrics(chunks);
  const inspectingOriginal = mode === "parse" && initialView === "original";
  if (!snapshot && !inspectingOriginal && text.isLoading) return <LoadingState />;
  if (!snapshot && !inspectingOriginal && text.error) return <ErrorState error={text.error} onRetry={() => void text.refetch()} />;
  return (
    <div className="workflow-stack">
      <div className="workflow-section-title">
        <div>
          <h2>{mode === "parse" ? "The text your pipeline reads" : "The passages used for generation"}</h2>
          <p>{sourceDocumentName(doc)}</p>
        </div>
        <StatusBadge tone="info">{snapshot ? "Saved run input" : "Current document"}</StatusBadge>
      </div>
      <div className="workflow-inline-stats">
        {mode === "parse" ? (
          <>
            <span>
              Parser{" "}
              <strong>
                {doc.parser === "node"
                  ? ((
                      {
                        pdf: "PDF.js · text layer",
                        docx: "Mammoth · HTML structure",
                        xlsx: "SheetJS · worksheets and tables",
                        xls: "SheetJS · worksheets and tables",
                        html: "HTML block parser",
                        text: /\.xml$/i.test(doc.name)
                          ? "Structured XML parser"
                          : /\.md$/i.test(doc.name)
                            ? "Markdown structure parser"
                            : "Plain text parser",
                      } as Record<string, string>
                    )[doc.kind] ?? "Built-in parser")
                  : (doc.parser ?? "Not recorded")}
              </strong>
            </span>
            <span>
              <strong>{currentText?.pages.length ?? doc.pageCount ?? "—"}</strong> pages
            </span>
            <span>
              <strong>{currentText?.sections?.length ?? doc.sectionCount ?? "—"}</strong> sections
            </span>
            <span>
              OCR <strong>{doc.ocr ? "used" : "not recorded as used"}</strong>
            </span>
          </>
        ) : (
          <>
            <span>
              <strong>{stats.count}</strong> chunks
            </span>
            <span>
              <strong>{stats.meanChars.toLocaleString()}</strong> mean characters
            </span>
            <span>
              <strong>{stats.overlapPercent}%</strong> leading context
            </span>
          </>
        )}
      </div>
      {mode === "parse" ? (
        <>
          <div className="workflow-text-output">
            {snapshot ? (
              savedText ? (
                <pre>{savedText.text}</pre>
              ) : (
                <p className="muted">
                  This older run saved chunks but not the complete parsed text. Inspect Chunks to view its recorded input.
                </p>
              )
            ) : (
              <DocumentInspection key={`${doc.id}-${initialView}`} pid={pid} doc={doc as ProjectDocument} initialView={initialView} />
            )}
          </div>
          <MethodDetails title="Parser output, page boundaries & detected structure">
            <p>
              Parsing is separate from the language model. Page offsets refer to the extracted text, not the PDF byte positions. Headings in
              PDF text layers are heuristic; OCR and reading order can affect every later stage.
            </p>
            <ResultTable
              label="Detected sections"
              rows={(currentText?.sections ?? []).map((s) => ({ ...s }))}
              columns={["title", "level", "start", "end"]}
            />
            <ResultTable
              label="Detected tables"
              rows={(currentText?.tables ?? []).map((s) => ({ ...s, text: currentText?.text.slice(s.start, s.end) }))}
              columns={["page", "start", "end", "text"]}
            />
            <JsonDetails
              label="Page spans & source identity"
              value={{
                checksum: doc.checksum,
                parsing: doc.parsing,
                preprocessing: doc.preprocessing,
                pages: currentText?.pages,
                sourceSpans: currentText?.sourceSpans,
              }}
            />
          </MethodDetails>
        </>
      ) : (
        <>
          {!snapshot && (
            <SavedChunkConfigurations
              doc={doc as ProjectDocument}
              documents={documents}
              selected={selectedDocumentIds}
              onUseVariant={onUseVariant}
            />
          )}
          {!snapshot && defaults.data && (
            <ChunkLab
              key={doc.id}
              configure
              pid={pid}
              doc={doc as ProjectDocument}
              defaults={defaults.data}
              onUseVariant={onUseVariant}
              onModelChoice={onModelChoice}
            />
          )}
          {snapshot && (
            <>
              <div className="stage-method-summary">
                <strong>
                  Chunking method:{" "}
                  {doc.preprocessing ? CHUNK_METHODS[doc.preprocessing.settings.method].name : "Not recorded for this document"}
                </strong>
                {doc.preprocessing && (
                  <>
                    <p>{CHUNK_METHODS[doc.preprocessing.settings.method].description}</p>
                    <p>
                      Base size:{" "}
                      {(doc.preprocessing.settings.tokens?.generation.maxTokens ?? doc.preprocessing.settings.maxChars).toLocaleString()}{" "}
                      {doc.preprocessing.settings.unit === "tokens" ? "tokens" : "characters"} · requested overlap:{" "}
                      {Math.round(doc.preprocessing.settings.overlap * 100)}%. Boundaries follow document structure and the saved size
                      budget.
                    </p>
                  </>
                )}
              </div>
              <ChunkBrowser
                chunks={chunks}
                documentLength={currentText?.text.length}
                onInspect={
                  snapshot && runId
                    ? (chunk) => evidence.openTarget({ kind: "passage", runId, documentId: doc.id, chunkId: chunk.id })
                    : undefined
                }
              />
              <ResultTable
                label="Chunk boundary measurements"
                rows={chunks.map((c) => ({
                  chunk: c.ordinal + 1,
                  start: c.start,
                  end: c.end,
                  characters: c.end - c.start,
                  overlapCharacters: c.overlap ?? 0,
                  section: c.sectionPath?.join(" > ") ?? "—",
                }))}
                columns={["chunk", "start", "end", "characters", "overlapCharacters", "section"]}
              />
              <MethodDetails>
                <p>
                  {doc.preprocessing
                    ? CHUNK_METHODS[doc.preprocessing.settings.method].description
                    : "Original chunking settings were not captured for this older document."}
                </p>
                <dl className="workflow-key-values">
                  <dt>Base character budget</dt>
                  <dd>{doc.preprocessing?.settings.maxChars ?? "Not recorded"}</dd>
                  <dt>Requested overlap</dt>
                  <dd>{doc.preprocessing ? `${Math.round(doc.preprocessing.settings.overlap * 100)}%` : "Not recorded"}</dd>
                  <dt>Offset unit</dt>
                  <dd>UTF-16 code units in parsed text; not model tokens</dd>
                </dl>
                <p>
                  Overlap is added after packing and can exceed the base budget. Inspect results near chunk boundaries before increasing
                  overlap. No method guarantees better extraction on every domain.
                </p>
                <JsonDetails value={{ metrics: stats, preprocessing: doc.preprocessing }} />
              </MethodDetails>
            </>
          )}
        </>
      )}
    </div>
  );
}
