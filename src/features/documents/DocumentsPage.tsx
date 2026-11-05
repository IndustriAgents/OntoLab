// Documents: searchable table with type, size, parsing and extraction state;
// upload (limits explained up front), preview, retry and removal.

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { api, qk } from "../../lib/projectApi";
import type { RunView } from "../../types/project";
import { fmtSize } from "../../lib/format";
import { Dropzone } from "../../components/Dropzone";
import { ConfirmButton, EmptyState, ErrorState, Inspector, InlineError, LoadingState, PageHead, fmtDate } from "../../components/ui/ui";
import { IconSearch } from "../../components/icons";
import { DocumentInspection } from "./DocumentInspection";
import { DocumentViewer } from "./DocumentViewer";
import { evidenceApi } from "../../lib/evidenceApi";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { ParseBadge, processingPoll, useDocumentUpload } from "./useDocumentUpload";
import { RunStatusBadge } from "../runs/RunStatusBadge";
import { chunkConfigurationLabel, groupSourceDocuments, removeSourceDocuments, sourceDocumentName } from "../../lib/documentSources";
import "./documents.css";

export default function DocumentsPage() {
  const { pid } = useProject();
  const { config } = useAuth();
  const qc = useQueryClient();
  const evidence = useEvidenceViewer(pid);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const uploads = useDocumentUpload(pid);
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid), refetchInterval: processingPoll });
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const limits = config?.limits;

  const openId = params.get("doc");
  const savedRun = params.get("run");
  const saved = useQuery({
    queryKey: ["saved-evidence-text", pid, savedRun, openId],
    queryFn: () => evidenceApi.text(pid, savedRun!, openId!),
    enabled: !!savedRun && !!openId,
    staleTime: Infinity,
    retry: false,
  });
  const hlStart = Number(params.get("start"));
  const hlEnd = Number(params.get("end"));
  const highlight = Number.isFinite(hlStart) && Number.isFinite(hlEnd) && hlEnd > hlStart ? { start: hlStart, end: hlEnd } : undefined;
  const page = Number(params.get("page")) || undefined;
  const open = (id: string | null, view: "text" | "original" = "text") =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      ["doc", "start", "end", "page", "view", "run"].forEach((k) => next.delete(k));
      if (id) next.set("doc", id);
      if (id && view === "original") next.set("view", view);
      return next;
    });

  const lastRun = useMemo(() => {
    const m = new Map<string, RunView>();
    for (const r of runs.data ?? []) for (const id of r.documentIds) if (!m.has(id)) m.set(id, r);
    return m;
  }, [runs.data]);

  const retry = useMutation({
    mutationFn: (id: string) => api.retryDocument(pid, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(pid) });
      void qc.invalidateQueries({ queryKey: qk.documentText(pid, retry.variables ?? "") });
    },
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => removeSourceDocuments(pid, ids, api),
    onSuccess: (_d, ids) => {
      if (openId && ids.includes(openId)) open(null);
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.documents(pid) }),
  });

  const sources = groupSourceDocuments(docs.data ?? []);
  const list = sources.filter((source) => !filter || source.name.toLowerCase().includes(filter.toLowerCase()));
  const opened = docs.data?.find((d) => d.id === openId);
  const atLimit = !!limits && (docs.data?.length ?? 0) >= limits.maxDocumentsPerProject;

  if (savedRun && openId)
    return (
      <div className="page">
        <div className="page-wide">
          <PageHead title={saved.data?.name ?? "Retained source"}>
            Retained run snapshot. This reader uses the source saved with the run.
          </PageHead>
          {saved.isLoading ? (
            <LoadingState label="Opening retained source…" />
          ) : saved.error ? (
            <ErrorState title="Historical source unavailable" error={saved.error} onRetry={() => void saved.refetch()} />
          ) : (
            saved.data && (
              <>
                <p className="field-hint">
                  {saved.data.parsing?.version ?? "Parser version not recorded"} · run {savedRun}
                </p>
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={() =>
                    evidence.open({
                      runId: savedRun,
                      documentId: openId,
                      quote: highlight ? saved.data!.text.slice(highlight.start, highlight.end) : "",
                      status: "legacy",
                      ...highlight,
                      page,
                    })
                  }
                >
                  Inspect evidence
                </button>
                <DocumentViewer pid={pid} documentId={openId} snapshot={saved.data} highlight={highlight} page={page} />
              </>
            )
          )}
        </div>
      </div>
    );

  return (
    <div className="page-split">
      <div className="page">
        <div className="page-wide">
          <PageHead title="Documents">
            Contracts, reports, notes, manuals, papers — whatever the graph should be built from. Originals are stored first, then parsed
            automatically. Inspect readable text, configure chunks, and choose inputs before generation.
          </PageHead>

          {!atLimit ? (
            <Dropzone
              title="Add documents"
              hint={
                limits
                  ? `PDF, DOCX, Excel, HTML, XML or text · up to ${fmtSize(limits.maxFileBytes)} per file · ${limits.maxDocumentsPerProject} documents per project`
                  : "PDF, DOCX, Excel, HTML, XML or text files"
              }
              accept={
                config?.features?.docling
                  ? ".pdf,.docx,.xlsx,.xls,.html,.xml,.htm,.txt,.md,.pptx,.png,.jpg,.jpeg,.tif,.tiff"
                  : ".pdf,.docx,.xlsx,.xls,.html,.xml,.htm,.txt,.md"
              }
              formats={
                config?.features?.docling
                  ? ["PDF", "DOCX", "XLSX", "XLS", "HTML", "XML", "TXT", "MD", "PPTX", "images"]
                  : ["PDF", "DOCX", "XLSX", "XLS", "HTML", "XML", "TXT", "MD"]
              }
              multiple
              onFiles={(f) => {
                if (!uploads.busy) void uploads.upload(f);
              }}
            />
          ) : (
            <div className="banner subtle" role="status">
              This project has reached the limit of {limits?.maxDocumentsPerProject} documents. Remove some to add more.
            </div>
          )}

          {uploads.progress}

          <div className="table-toolbar">
            <label className="search">
              <IconSearch />
              <span className="sr-only">Search documents</span>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by name" />
            </label>
            <span className="muted">
              {sources.length} uploaded document{sources.length === 1 ? "" : "s"} ·{" "}
              {(docs.data ?? []).filter((document) => document.chunkCount > 0).length} saved chunk configurations
            </span>
          </div>

          {docs.isLoading ? (
            <LoadingState />
          ) : docs.error ? (
            <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />
          ) : !docs.data?.length ? (
            <EmptyState title="No documents yet">
              Upload the documents the knowledge graph should be built from. Nothing is sent to an AI provider until you start a run.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">Project documents</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Size</th>
                    <th scope="col">Parsing</th>
                    <th scope="col">Extraction</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((source) => {
                    const d = source.document;
                    const run =
                      (runs.data ?? []).find((candidate) =>
                        source.configurations.some((configuration) => candidate.documentIds.includes(configuration.id)),
                      ) ?? lastRun.get(d.id);
                    return (
                      <tr
                        key={source.id}
                        className={source.configurations.some((configuration) => configuration.id === openId) ? "is-selected" : ""}
                      >
                        <td data-label="Name">
                          <button className="row-link" onClick={() => open(d.id)} aria-label={`Preview ${source.name}`}>
                            {source.name}
                          </button>
                          <div className="row-sub">
                            {d.parseState === "parsed"
                              ? `${d.pageCount ? `${d.pageCount} pages · ` : ""}${d.sectionCount ? `${d.sectionCount} section${d.sectionCount === 1 ? "" : "s"} · ` : ""}${d.tableCount ? `${d.tableCount} table${d.tableCount === 1 ? "" : "s"} · ` : ""}${d.chunkCount} part${d.chunkCount === 1 ? "" : "s"} · ${d.ocr ? "OCR · " : ""}${d.parser === "docling" ? "layout parser · " : ""}${d.kind === "pdf" && d.charCount === 0 ? "no text layer (scanned?) · " : ""}`
                              : ""}
                            added {fmtDate(d.createdAt)}
                          </div>
                          {d.parseState === "failed" && <div className="row-error">{d.parseError}</div>}
                          <details className="document-configurations">
                            <summary>
                              {source.configurations.filter((configuration) => configuration.chunkCount > 0).length} saved chunk
                              configurations
                            </summary>
                            <ul>
                              {source.configurations.map((configuration) => (
                                <li key={configuration.id}>
                                  <span>{chunkConfigurationLabel(configuration)}</span>
                                  <small>{configuration.chunkCount} chunks</small>
                                  <div className="row-actions">
                                    <Link to={`/p/${pid}/research?view=documents&doc=${configuration.id}`}>Inspect configuration</Link>
                                    {configuration.variantOf && (
                                      <ConfirmButton
                                        label="Remove configuration"
                                        confirmLabel="Remove this configuration"
                                        disabled={remove.isPending}
                                        onConfirm={() => remove.mutate([configuration.id])}
                                      />
                                    )}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </td>
                        <td data-label="Type">{d.kind.toUpperCase()}</td>
                        <td data-label="Size">{fmtSize(d.sizeBytes)}</td>
                        <td data-label="Parsing">
                          <ParseBadge doc={d} />
                        </td>
                        <td data-label="Extraction">
                          {run ? (
                            <Link to={`/p/${pid}/runs/${run.id}`} className="badge-link">
                              <RunStatusBadge status={run.status} resumable={run.resumable} />
                            </Link>
                          ) : (
                            <span className="muted">Not extracted</span>
                          )}
                        </td>
                        <td className="row-actions">
                          <button className="btn ghost sm" onClick={() => open(d.id, "original")}>
                            Original file
                          </button>
                          {d.parseState === "parsed" && (
                            <Link className="btn ghost sm" to={`/p/${pid}/research?view=documents&doc=${d.id}`}>
                              Inspect chunks
                            </Link>
                          )}
                          {d.parseState === "failed" && (
                            <button className="btn ghost sm" onClick={() => retry.mutate(d.id)} disabled={retry.isPending}>
                              Retry
                            </button>
                          )}
                          <ConfirmButton
                            label="Remove"
                            confirmLabel="Remove document & configurations"
                            disabled={remove.isPending}
                            onConfirm={() => remove.mutate(source.configurations.map((configuration) => configuration.id))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <InlineError error={retry.error ?? remove.error} />
        </div>
      </div>

      <Inspector title={opened ? sourceDocumentName(opened, docs.data ?? []) : "Document"} open={!!openId} onClose={() => open(null)}>
        {opened ? (
          <DocumentInspection
            key={`${opened.id}-${params.get("view")}`}
            pid={pid}
            doc={opened}
            highlight={highlight}
            page={page}
            initialView={params.get("view") === "original" ? "original" : "text"}
          />
        ) : (
          <LoadingState />
        )}
      </Inspector>
    </div>
  );
}
