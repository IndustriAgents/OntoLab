import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ProjectDocument } from "../../types/project";
import { api, qk } from "../../lib/projectApi";
import { ErrorState, InlineError, LoadingState } from "../../components/ui/ui";
import { DocumentViewer } from "./DocumentViewer";
import { ParseBadge } from "./useDocumentUpload";
import { sourceDocumentName } from "../../lib/documentSources";
import { useEvidenceViewer } from "../evidence/useEvidence";

function OriginalFile({ pid, doc }: { pid: string; doc: ProjectDocument }) {
  const file = useQuery({ queryKey: ["original-file", pid, doc.id], queryFn: () => api.documentFile(pid, doc.id) });
  const [source, setSource] = useState<{ url: string; text?: string } | null>(null);
  useEffect(() => {
    if (!file.data) return;
    const url = URL.createObjectURL(file.data);
    let active = true;
    const isText = doc.kind === "text" || doc.kind === "html" || /xml|text\//.test(doc.mediaType);
    if (isText)
      void file.data.text().then((text) => {
        if (active) setSource({ url, text });
      });
    else setSource({ url });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file.data, doc.kind, doc.mediaType]);
  if (file.error) return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  if (!source) return <LoadingState label="Loading original file…" />;
  return (
    <div className="original-file">
      <div className="document-reader-toolbar">
        <span>Original file · unchanged</span>
        <a className="btn ghost sm" href={source.url} download={sourceDocumentName(doc)}>
          Download original
        </a>
      </div>
      {source.text !== undefined ? (
        <pre className="original-file-text">{source.text}</pre>
      ) : doc.kind === "pdf" ? (
        <object className="original-file-preview" data={source.url} type="application/pdf" aria-label={`Original ${doc.name}`}>
          <p>Download the original to view it in your PDF reader.</p>
        </object>
      ) : doc.kind === "image" ? (
        <img className="original-file-image" src={source.url} alt={doc.name} />
      ) : (
        <p className="document-reader-summary">Download the original to open it in its native application.</p>
      )}
    </div>
  );
}

export function DocumentInspection({
  pid,
  doc,
  highlight,
  page,
  onReprocess,
  readOnly = false,
  initialView = "text",
}: {
  pid: string;
  doc: ProjectDocument;
  highlight?: { start: number; end: number };
  page?: number;
  onReprocess?: () => Promise<ProjectDocument>;
  readOnly?: boolean;
  initialView?: "text" | "original";
}) {
  const [tab, setTab] = useState<"text" | "original">(initialView);
  const evidence = useEvidenceViewer(pid);
  const qc = useQueryClient();
  const reprocess = useMutation({
    mutationFn: () => (onReprocess ? onReprocess() : api.reprocessDocument(pid, doc.id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(pid) });
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
  });
  return (
    <div className="document-inspection">
      <nav className="document-view-tabs" aria-label="Document views">
        <button className="btn ghost sm" type="button" onClick={() => evidence.openTarget({ kind: "document", documentId: doc.id })}>
          Inspect evidence
        </button>
        <button className="btn ghost sm" aria-pressed={tab === "text"} onClick={() => setTab("text")}>
          Readable text
        </button>
        <button className="btn ghost sm" aria-pressed={tab === "original"} onClick={() => setTab("original")}>
          Original file
        </button>
      </nav>
      <section className="document-reparse" aria-label="Reparse original">
        <div>
          <strong>Original file retained</strong>
          <p>
            Reparse the original with the currently configured parser to create a separate processing version. Earlier parsed text, chunks
            and builds are preserved.
          </p>
          {doc.parsing && <p className="field-hint">Current parsing: {doc.parsing.version}</p>}
        </div>
        <button
          className="btn ghost sm"
          disabled={readOnly || reprocess.isPending || doc.parseState === "pending" || reprocess.isSuccess}
          onClick={() => reprocess.mutate()}
        >
          {reprocess.isPending ? "Creating processing version…" : "Reparse original"}
        </button>
        {reprocess.data && (
          <p>
            <Link to={`/p/${pid}/documents?doc=${reprocess.data.id}`}>Inspect new processing version →</Link>
          </p>
        )}
        <InlineError error={reprocess.error} />
      </section>
      {tab === "original" ? (
        <OriginalFile key={doc.id} pid={pid} doc={doc} />
      ) : (
        <>
          {doc.parseState === "parsed" ? (
            <DocumentViewer pid={pid} documentId={doc.id} highlight={highlight} page={page} />
          ) : (
            <div className="document-reader-summary">
              <ParseBadge doc={doc} />
              <p>{doc.parseError || "The original is stored. Text will appear here when automatic parsing finishes."}</p>
            </div>
          )}
          {doc.parsing?.warnings.map((w) => (
            <p className="document-parse-warning" key={w}>
              {w}
            </p>
          ))}
          <details className="document-processing-info">
            <summary>Processing version & source locations</summary>
            <p>
              {doc.parsing
                ? `${doc.parsing.version} · ${new Date(doc.parsing.createdAt).toLocaleString()}`
                : "This document predates parser version records."}
            </p>
            <p className="field-hint">
              Source locations refer to readable text. XML element paths, when available, are recorded with the extracted text. Reprocessing
              creates a separate version; existing runs keep their original inputs.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
