import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import type { ProjectDocument } from "../../types/project";
import { errorMessage, StatusBadge } from "../../components/ui/ui";

export const processingPoll = (q: { state: { data?: ProjectDocument[] } }) =>
  q.state.data?.some((d) => d.parseState === "pending") ? 2000 : false;

export function ParseBadge({ doc }: { doc: ProjectDocument }) {
  if (doc.parseState === "failed")
    return (
      <StatusBadge tone="alert" title={doc.parseError}>
        Parsing failed
      </StatusBadge>
    );
  if (doc.parseState === "pending")
    return (
      <StatusBadge tone="info">
        {doc.processing?.stage === "queued" ? "Queued for parsing" : doc.processing?.stage === "chunking" ? "Creating chunks…" : "Parsing…"}
      </StatusBadge>
    );
  return <StatusBadge tone={doc.charCount ? "ok" : "warn"}>{doc.charCount ? "Text ready" : "No readable text"}</StatusBadge>;
}

export function useDocumentUpload(
  pid: string,
  custom?: { upload: (file: File) => Promise<{ duplicate?: boolean; message?: string }>; onUploaded: () => void },
) {
  const qc = useQueryClient();
  const [items, setItems] = useState<
    { id: number; name: string; state: "waiting" | "uploading" | "uploaded" | "duplicate" | "failed"; error?: string; note?: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const upload = async (files: File[]) => {
    if (busy) return;
    setBusy(true);
    setItems(files.map((f, id) => ({ id, name: f.name, state: "waiting" })));
    try {
      for (const [id, file] of files.entries()) {
        setItems((items) => items.map((i) => (i.id === id ? { ...i, state: "uploading" } : i)));
        try {
          const result = custom ? await custom.upload(file) : undefined;
          if (!custom) await api.uploadDocument(pid, file);
          setItems((items) =>
            items.map((i) => (i.id === id ? { ...i, state: result?.duplicate ? "duplicate" : "uploaded", note: result?.message } : i)),
          );
          custom?.onUploaded();
        } catch (e) {
          setItems((items) => items.map((i) => (i.id === id ? { ...i, state: "failed", error: errorMessage(e) } : i)));
        }
        await qc.invalidateQueries({ queryKey: qk.documents(pid) });
      }
      void qc.invalidateQueries({ queryKey: qk.usage });
    } finally {
      setBusy(false);
    }
  };
  const uploadedCount = items.filter((i) => i.state === "uploaded").length;
  const progressItems = items.filter((i) => i.state !== "uploaded");
  const visibleItems = progressItems.slice(0, 10);
  const progress = items.length ? (
    <>
      {uploadedCount > 0 && (
        <p className="field-hint" role="status">
          {uploadedCount} file{uploadedCount === 1 ? "" : "s"} uploaded.
        </p>
      )}
      {progressItems.length > 0 && (
        <ul className="upload-list" aria-live="polite">
          {visibleItems.map((i) => (
            <li key={i.id}>
              <span className="grow">{i.name}</span>
              <StatusBadge tone={i.state === "failed" ? "alert" : "info"}>
                {i.state === "waiting"
                  ? "Waiting to upload"
                  : i.state === "uploading"
                    ? "Uploading…"
                    : i.state === "duplicate"
                      ? "Already in this corpus"
                      : "Upload failed"}
              </StatusBadge>
              {i.note && <span className="row-sub">{i.note}</span>}
              {i.error && <span className="row-error">{i.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {progressItems.length > visibleItems.length && (
        <p className="field-hint">{progressItems.length - visibleItems.length} more files in this upload batch.</p>
      )}
    </>
  ) : null;
  return { upload, busy, progress };
}
