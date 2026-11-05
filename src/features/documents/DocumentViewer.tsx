// Shows a document's extracted text with page markers and, when given, a
// highlighted passage that is scrolled into view — the target of every
// evidence link in the app.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import type { EvidenceRef, DocumentText } from "../../types/project";
import { ErrorState, LoadingState, StatusBadge } from "../../components/ui/ui";

const WINDOW = 6000;

export function EvidenceStatusBadge({ status }: { status: EvidenceRef["status"] }) {
  if (status === "verified")
    return (
      <StatusBadge tone="ok" title="The quote was found in the source text">
        Quote located
      </StatusBadge>
    );
  if (status === "vision")
    return (
      <StatusBadge tone="info" title="Read from the PDF as an image; there is no text to check it against">
        Vision only
      </StatusBadge>
    );
  if (status === "legacy")
    return (
      <StatusBadge tone="muted" title="Imported without a source location">
        No location
      </StatusBadge>
    );
  return (
    <StatusBadge tone="warn" title="The model's quote could not be found in the cited text">
      Unverified
    </StatusBadge>
  );
}

export function DocumentViewer({
  pid,
  documentId,
  highlight,
  page,
  snapshot,
  scrollMode = "page",
  onSelectPassage,
}: {
  pid: string;
  documentId: string;
  highlight?: { start: number; end: number };
  page?: number;
  snapshot?: Pick<DocumentText, "text" | "pages">;
  /** Embedded inspectors scroll their own text pane, preserving page position. */
  scrollMode?: "page" | "container";
  onSelectPassage?: (passage: { text: string; start: number; end: number }) => void;
}) {
  const q = useQuery({
    queryKey: qk.documentText(pid, documentId),
    queryFn: () => api.documentText(pid, documentId),
    staleTime: 5 * 60_000,
    enabled: !snapshot,
  });
  const source = snapshot ?? q.data;
  const readerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ text: string; start: number; end: number } | null>(null);
  const [fullText, setFullText] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentId = useId();
  useEffect(() => {
    setSelection(null);
    setFullText(false);
    setCollapsed(false);
    setExpanded(false);
  }, [documentId]);
  useEffect(() => {
    if (expanded) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [expanded]);
  const markRef = useRef<HTMLElement>(null);

  // Long documents: render a window around the highlight (or the requested page).
  const view = useMemo(() => {
    const data = source;
    if (!data) return null;
    const text = data.text;
    let anchor = highlight?.start ?? (page ? (data.pages.find((p) => p.page === page)?.start ?? 0) : 0);
    anchor = Math.max(0, Math.min(anchor, text.length));
    const from = fullText || expanded || text.length <= WINDOW * 2 ? 0 : Math.max(0, anchor - WINDOW);
    const to = fullText || expanded || text.length <= WINDOW * 2 ? text.length : Math.min(text.length, anchor + WINDOW);
    // split [from, to) into segments at page starts and the highlight bounds
    const cuts = new Set<number>([from, to]);
    for (const p of data.pages) if (p.start > from && p.start < to) cuts.add(p.start);
    if (highlight) {
      if (highlight.start > from && highlight.start < to) cuts.add(highlight.start);
      if (highlight.end > from && highlight.end < to) cuts.add(highlight.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const segs: { start: number; end: number; page?: number; hl: boolean }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const s = points[i];
      const e = points[i + 1];
      const pageStart = data.pages.find((p) => p.start === s)?.page;
      segs.push({ start: s, end: e, page: pageStart, hl: !!highlight && s >= highlight.start && e <= highlight.end });
    }
    const firstPage = data.pages.find((p) => from >= p.start && from <= p.end)?.page;
    return { text, segs, from, to, firstPage };
  }, [source, highlight, page, fullText, expanded]);

  useEffect(() => {
    if (scrollMode === "container") {
      const mark = markRef.current;
      const container = mark?.closest<HTMLElement>(".doc-viewer");
      if (mark && container)
        container.scrollTop += mark.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2;
      return;
    }
    markRef.current?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [view, scrollMode]);

  useEffect(() => {
    const readSelection = () => {
      const container = readerRef.current;
      if (!container) return;
      if (!onSelectPassage || !source) return;
      const selected = window.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) return;
      const range = selected.getRangeAt(0);
      const offset = (node: Node, position: number) => {
        const element = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
          "[data-text-start]",
        );
        if (!element || !container.contains(element)) return null;
        const prefix = document.createRange();
        prefix.setStart(element, 0);
        prefix.setEnd(node, position);
        return Number(element.dataset.textStart) + prefix.toString().length;
      };
      const start = offset(range.startContainer, range.startOffset),
        end = offset(range.endContainer, range.endOffset);
      setSelection(start != null && end != null && end - start >= 5 ? { start, end, text: source.text.slice(start, end) } : null);
    };
    document.addEventListener("selectionchange", readSelection);
    return () => document.removeEventListener("selectionchange", readSelection);
  }, [source, onSelectPassage]);

  if (!snapshot && q.isLoading) return <LoadingState label="Loading document…" />;
  if (!snapshot && q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!view) return null;
  let firstHl = true;
  const content = (
    <div className="doc-viewer" role="document" aria-label="Document text">
      {view.from > 0 && <p className="doc-gap">… {view.from.toLocaleString()} characters before</p>}
      {view.firstPage && !view.segs[0]?.page && <div className="doc-page">Page {view.firstPage}</div>}
      {view.segs.map((s) => {
        const body = view.text.slice(s.start, s.end);
        const mark =
          s.hl && firstHl ? (
            <mark key={`m${s.start}`} ref={markRef as React.RefObject<HTMLElement>} data-text-start={s.start}>
              {body}
            </mark>
          ) : s.hl ? (
            <mark key={`m${s.start}`} data-text-start={s.start}>
              {body}
            </mark>
          ) : (
            <span key={`t${s.start}`} data-text-start={s.start}>
              {body}
            </span>
          );
        if (s.hl) firstHl = false;
        return s.page ? (
          <span key={`p${s.start}`}>
            <span className="doc-page" role="heading" aria-level={3}>
              Page {s.page}
            </span>
            {mark}
          </span>
        ) : (
          mark
        );
      })}
      {view.to < view.text.length && <p className="doc-gap">… {(view.text.length - view.to).toLocaleString()} characters after</p>}
    </div>
  );
  const truncated = view.from > 0 || view.to < view.text.length;
  return (
    <div className="document-reader" ref={readerRef}>
      <div className="document-reader-toolbar">
        <div>
          <strong>Document text</strong>
          <small>
            {view.text.length.toLocaleString()} characters · {truncated ? "Preview" : "Full text"}
          </small>
        </div>
        <div className="document-reader-actions">
          {onSelectPassage && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={!selection}
              onClick={() => {
                if (selection) onSelectPassage(selection);
              }}
            >
              Use selected passage
            </button>
          )}
          {view.text.length > WINDOW * 2 && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setFullText(!fullText);
                setCollapsed(false);
              }}
            >
              {fullText ? "Show preview" : "Show full text"}
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => setExpanded(true)}>
            Expand viewer
          </button>
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "Show text" : "Collapse"}
          </button>
        </div>
      </div>
      <div id={contentId} hidden={collapsed || expanded}>
        {content}
      </div>
      {collapsed && <p className="document-reader-summary">Text hidden. Choose Show text to continue reading.</p>}
      <dialog
        className="document-reader-dialog"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        onCancel={() => setExpanded(false)}
        onClose={() => setExpanded(false)}
      >
        <div className="document-reader-toolbar">
          <div>
            <strong>Full document text</strong>
            <small>{view.text.length.toLocaleString()} characters</small>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setExpanded(false)}>
            Close expanded viewer
          </button>
        </div>
        {onSelectPassage && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={!selection}
            onClick={() => {
              if (selection) {
                onSelectPassage(selection);
                setExpanded(false);
              }
            }}
          >
            Use selected passage
          </button>
        )}
        {expanded && content}
      </dialog>
    </div>
  );
}

/** One evidence reference, rendered as a quote with its location and a link to open it. */
export function EvidenceItem({ ev, docName, onOpen }: { ev: EvidenceRef; docName?: string; onOpen?: (ev: EvidenceRef) => void }) {
  const where = [docName, ev.page ? `page ${ev.page}` : null].filter(Boolean).join(", ");
  const openable = !!ev.documentId && !!onOpen;
  return (
    <div className="evidence-item">
      <blockquote>“{ev.quote}”</blockquote>
      <div className="evidence-meta">
        <EvidenceStatusBadge status={ev.status} />
        {ev.confidence !== undefined && (
          <StatusBadge tone={ev.review ? "warn" : "ok"} title={ev.claim ? `Checked claim: ${ev.claim}` : undefined}>
            {ev.review ? "doubtful" : "supported"} {Math.round(ev.confidence * 100)}%
          </StatusBadge>
        )}
        {where && <span className="muted">{where}</span>}
        {openable && (
          <button type="button" className="btn ghost sm" onClick={() => onOpen!(ev)}>
            Inspect evidence
          </button>
        )}
      </div>
    </div>
  );
}
