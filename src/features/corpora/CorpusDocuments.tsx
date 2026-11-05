import { useRef, useState, useCallback, useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { corpusApi, type CorpusDetail } from "../../lib/corpusApi";
import { api } from "../../lib/projectApi";
import type { CorpusPlan, CorpusSourceView } from "../../types/corpus";
import type { ProjectDocument } from "../../types/project";
import { InlineError, Modal, StatusBadge, LoadingState } from "../../components/ui/ui";
import { DocumentInspection } from "../documents/DocumentInspection";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { useDocumentUpload } from "../documents/useDocumentUpload";
import { ChunkLab } from "../research/ChunkLab";

function SourceActions({ name, children }: { name: string; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target) && ref.current) ref.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <details
      className="corpus-source-actions"
      ref={ref}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
    >
      <summary aria-label={`Document actions for ${name}`} title="Document actions">
        <span aria-hidden="true">•••</span>
      </summary>
      <div className="corpus-source-menu">
        {children(() => {
          if (ref.current) ref.current.open = false;
          ref.current?.querySelector("summary")?.focus();
        })}
      </div>
    </details>
  );
}

const labels = {
  new: "Ready to extract",
  preparing: "Preparing…",
  included: "Included in graph",
  updated: "Ready to update",
  attention: "Needs attention",
  "removal-pending": "Removal pending",
  removed: "Removed",
} as const;

function SourceList({ sources, render }: { sources: CorpusSourceView[]; render: (source: CorpusSourceView) => ReactNode }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const filtered = sources.filter((source) => source.member.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const current = Math.min(page, pages - 1);
  return (
    <div className="corpus-stack">
      {(sources.length > 25 || search) && (
        <label className="field corpus-source-search">
          <span>Search documents</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
      )}
      {filtered.length ? (
        <div className="corpus-source-list">{filtered.slice(current * 25, (current + 1) * 25).map(render)}</div>
      ) : (
        <p>No matching documents.</p>
      )}
      {filtered.length > 25 && (
        <nav className="corpus-source-pagination" aria-label="Document pages">
          <span>
            {current * 25 + 1}–{Math.min((current + 1) * 25, filtered.length)} of {filtered.length} documents
          </span>
          <button className="btn ghost sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <button className="btn ghost sm" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
export function CorpusDocuments({
  pid,
  detail,
  plan,
  onPlan,
  selected,
  onSelected,
  refresh,
}: {
  pid: string;
  detail: CorpusDetail;
  plan?: CorpusPlan;
  onPlan: () => void;
  selected: string[];
  onSelected: (ids: string[]) => void;
  refresh: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const evidence = useEvidenceViewer(pid);
  const input = useRef<HTMLInputElement>(null),
    versionInput = useRef<HTMLInputElement>(null);
  const [versionMember, setVersionMember] = useState<string | null>(null),
    [inspect, setInspect] = useState<ProjectDocument | null>(null),
    [chunks, setChunks] = useState<CorpusSourceView | null>(null),
    [remove, setRemove] = useState<CorpusSourceView | null>(null);
  const upload = useDocumentUpload(pid, { upload: (file) => corpusApi.upload(pid, file), onUploaded: refresh });
  const action = useMutation({
    mutationFn: async (arg: { source: CorpusSourceView; action: "retry" | "prepare" | "restore" }) =>
      arg.action === "retry"
        ? api.retryDocument(pid, arg.source.document!.id)
        : arg.action === "prepare"
          ? corpusApi.prepare(pid, arg.source.member.id)
          : corpusApi.member(pid, arg.source.member.id, { removed: false }),
    onSuccess: refresh,
  });
  const version = useMutation({
    mutationFn: (file: File) => corpusApi.upload(pid, file, versionMember!),
    onSuccess: () => {
      setVersionMember(null);
      refresh();
    },
  });
  const attach = useMutation({
    mutationFn: ({ source, document }: { source: CorpusSourceView; document: ProjectDocument }) =>
      corpusApi.preparation(pid, source.member.id, document.id),
    onSuccess: () => {
      setChunks(null);
      refresh();
    },
  });
  const restoreVersion = useMutation({
    mutationFn: ({ member, document }: { member: string; document: string }) =>
      corpusApi.member(pid, member, { documentId: document, removed: false }),
    onSuccess: refresh,
  });
  const impact = useQuery({
    queryKey: ["corpus-impact", pid, remove?.member.id, detail.graph.id],
    queryFn: () => corpusApi.impact(pid, remove!.member.id),
    enabled: !!remove,
  });
  const removal = useMutation({
    mutationFn: () => corpusApi.member(pid, remove!.member.id, { removed: true }),
    onSuccess: () => {
      setRemove(null);
      refresh();
    },
  });
  const requestedDoc = params.get("doc");
  useEffect(() => {
    if (requestedDoc) {
      const doc = detail.documents.find((d) => d.id === requestedDoc);
      if (doc) setInspect(doc);
    }
  }, [requestedDoc, detail.documents]);
  const closeInspect = useCallback(() => {
      setInspect(null);
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          for (const key of ["doc", "start", "end", "page"]) n.delete(key);
          return n;
        },
        { replace: true },
      );
    }, [setParams]),
    closeChunks = useCallback(() => setChunks(null), []),
    closeRemove = useCallback(() => setRemove(null), []);
  const rows =
    plan?.sources ??
    detail.corpus.settings.corpus!.members.map((member) => ({
      member,
      document: detail.documents.find((d) => d.id === member.headDocumentId) ?? null,
      status: member.removed ? ("removed" as const) : ("preparing" as const),
      reason: "Loading source status…",
      fingerprint: "",
    }));
  const current = rows.filter((s) => !s.member.removed),
    removed = rows.filter((s) => s.member.removed);
  const render = (source: CorpusSourceView) => {
    const { member, document: doc, status } = source;
    const sourceVersion = member.versions.find((v) => v.documentId === member.headDocumentId);
    return (
      <article className="corpus-source" key={member.id}>
        <div className="corpus-source-main">
          <h3>
            {doc ? (
              <button className="corpus-source-name" title={member.name} onClick={() => setInspect(doc)}>
                {member.name}
              </button>
            ) : (
              member.name
            )}
          </h3>
          <div className="corpus-source-meta">
            <StatusBadge
              tone={
                status === "included"
                  ? "ok"
                  : status === "attention"
                    ? "alert"
                    : status === "updated" || status === "removal-pending"
                      ? "warn"
                      : "info"
              }
            >
              {labels[status]}
            </StatusBadge>
            <span>
              Version {sourceVersion?.number ?? 1}
              {sourceVersion?.preparation ? " · updated preparation" : ""}
            </span>
            {!!doc?.chunkCount && <span>{doc.chunkCount} chunks</span>}
          </div>
          {(status === "attention" || status === "preparing") && <p>{source.reason}</p>}
          <details>
            <summary>{member.versions.length === 1 ? "Details" : `Details & history · ${member.versions.length} versions`}</summary>
            <p>{source.reason}</p>
            <p>
              {doc?.charCount.toLocaleString() ?? 0} characters · {doc?.chunkCount ?? 0} chunks
            </p>
            {!member.removed && doc?.parseState === "parsed" && (
              <button className="btn ghost sm" onClick={() => setChunks(source)}>
                Inspect chunks
              </button>
            )}
            {!member.removed && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.includes(member.id)}
                  onChange={(e) => onSelected(e.target.checked ? [...selected, member.id] : selected.filter((id) => id !== member.id))}
                />
                Reprocess this source
              </label>
            )}
            {member.versions
              .slice()
              .reverse()
              .map((v) => (
                <div key={v.documentId}>
                  <span>
                    Version {v.number}
                    {v.preparation ? " · chunk preparation" : ""}
                    {v.documentId === member.headDocumentId ? " · current" : ""}
                  </span>
                  <div className="row-actions">
                    <button
                      className="btn ghost sm"
                      onClick={() => setInspect(detail.documents.find((d) => d.id === v.documentId) ?? null)}
                    >
                      Inspect
                    </button>
                    {v.documentId !== member.headDocumentId && (
                      <button
                        className="btn ghost sm"
                        disabled={restoreVersion.isPending}
                        onClick={() => restoreVersion.mutate({ member: member.id, document: v.documentId })}
                      >
                        Use this version
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </details>
        </div>
        <div className="row-actions corpus-source-tools">
          {status === "attention" && doc?.parseState === "failed" && (
            <button className="btn ghost sm" disabled={action.isPending} onClick={() => action.mutate({ source, action: "retry" })}>
              Retry preparation
            </button>
          )}
          {status === "attention" && doc?.parseState === "parsed" && doc.charCount > 0 && (
            <button className="btn ghost sm" disabled={action.isPending} onClick={() => action.mutate({ source, action: "prepare" })}>
              Prepare chunks
            </button>
          )}
          {!member.removed ? (
            <SourceActions name={member.name}>
              {(close) => (
                <>
                  <button
                    className="btn ghost sm"
                    disabled={version.isPending}
                    onClick={() => {
                      close();
                      setVersionMember(member.id);
                      versionInput.current?.click();
                    }}
                  >
                    Replace document
                  </button>
                  <button
                    className="btn ghost sm danger"
                    onClick={() => {
                      close();
                      setRemove(source);
                    }}
                  >
                    Remove document
                  </button>
                </>
              )}
            </SourceActions>
          ) : (
            <button className="btn ghost sm" disabled={action.isPending} onClick={() => action.mutate({ source, action: "restore" })}>
              Restore source
            </button>
          )}
        </div>
      </article>
    );
  };
  return (
    <div className="corpus-stack">
      <input
        ref={input}
        hidden
        multiple
        type="file"
        accept=".pdf,.docx,.txt,.md,.html,.htm,.xml,.pptx,.xlsx,.xls,.png,.jpg,.jpeg"
        onChange={(e) => {
          void upload.upload(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <input
        ref={versionInput}
        hidden
        type="file"
        accept=".pdf,.docx,.txt,.md,.html,.htm,.xml,.pptx,.xlsx,.xls,.png,.jpg,.jpeg"
        onChange={(e) => {
          if (e.target.files?.[0]) version.mutate(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <div className="corpus-action-bar">
        <div>
          <h2>Source documents</h2>
          <p>Add new documents or replace an existing one. Preparation is automatic; your saved graph stays available.</p>
        </div>
        <div className="row-actions">
          <button className="btn ghost" disabled={upload.busy} onClick={() => input.current?.click()}>
            {upload.busy ? "Uploading…" : "Add documents"}
          </button>
        </div>
      </div>
      {upload.progress}
      {version.isPending && <p role="status">Uploading a new source version…</p>}
      {version.data?.message && <p className="banner warn">{version.data.message}</p>}
      {version.data && !version.data.duplicate && (
        <p className="banner" role="status">
          Replacement uploaded. Update the knowledge graph to review its effect. The previous document and saved graph remain in history.
        </p>
      )}
      <InlineError error={action.error ?? version.error ?? attach.error ?? restoreVersion.error} />
      {!current.length ? (
        <div className="corpus-empty">
          <h2>Add the documents for this knowledge graph</h2>
          <p>Ontology source documents stay in their own workflow. Identical files are detected by their contents.</p>
          <button className="btn" disabled={upload.busy} onClick={() => input.current?.click()}>
            Choose documents
          </button>
        </div>
      ) : (
        <SourceList sources={current} render={render} />
      )}
      {!!removed.length && (
        <details>
          <summary>Removed sources · {removed.length}</summary>
          <p className="field-hint">Files remain available to earlier graph versions. Restore a source to include it in a future update.</p>
          <SourceList sources={removed} render={render} />
        </details>
      )}
      <details className="method-details">
        <summary>Advanced processing</summary>
        <div className="method-details-body">
          <p>Reprocess selected documents or rebuild the graph using your current settings.</p>
          <button className="btn ghost sm" onClick={onPlan}>
            Advanced update options
          </button>
        </div>
      </details>
      {inspect && (
        <Modal title={inspect.name} onClose={closeInspect} wide suspended={evidence.isOpen}>
          <DocumentInspection
            pid={pid}
            doc={inspect}
            highlight={
              params.has("start") && params.has("end") ? { start: Number(params.get("start")), end: Number(params.get("end")) } : undefined
            }
            readOnly={!detail.corpus.settings.corpus!.members.some((m) => !m.removed && m.headDocumentId === inspect.id)}
            onReprocess={async () => {
              const member = detail.corpus.settings.corpus!.members.find((m) => !m.removed && m.headDocumentId === inspect.id)!;
              const doc = await corpusApi.reparse(pid, member.id);
              refresh();
              return doc;
            }}
          />
        </Modal>
      )}
      {chunks?.document && (
        <Modal title={`Chunks · ${chunks.member.name}`} onClose={closeChunks} wide suspended={evidence.isOpen}>
          <p className="field-hint">
            Changing preparation creates an independent variant. Use it here to mark this source for reprocessing.
          </p>
          <ChunkLab
            key={chunks.document.id}
            pid={pid}
            doc={chunks.document}
            defaults={detail.corpus.settings.corpus!.chunking ?? { method: "section", maxChars: 12000, overlap: 0.12 }}
            configure
            onUseVariant={(doc) => attach.mutate({ source: chunks, document: doc })}
          />
          <InlineError error={attach.error} />
        </Modal>
      )}
      {remove && (
        <Modal
          title="Remove document from graph workspace"
          onClose={closeRemove}
          footer={
            <>
              <button className="btn ghost" onClick={closeRemove}>
                Keep source
              </button>
              <button
                className="btn danger"
                disabled={impact.isLoading || removal.isPending || !!impact.error}
                onClick={() => removal.mutate()}
              >
                Remove document
              </button>
            </>
          }
        >
          <p>
            <strong>{remove.member.name}</strong>
          </p>
          {impact.isLoading ? (
            <LoadingState label="Checking source contributions…" />
          ) : (
            <>
              <p>{impact.data?.retained ?? 0} facts retain support from another source or manual knowledge.</p>
              <p>{impact.data?.lost ?? 0} facts would lose their source support and need a decision in the proposed graph update.</p>
            </>
          )}
          <p>The published graph changes only after you review and save an update. Earlier graph versions keep their evidence.</p>
          <InlineError error={impact.error ?? removal.error} />
        </Modal>
      )}
    </div>
  );
}
