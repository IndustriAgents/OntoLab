// One inspection state per project workspace. Its URL preserves the source,
// selected version and active tab across reload, browser Back and copied links.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import { evidenceApi } from "../../lib/evidenceApi";
import { applyDecisions, listFacts } from "../../lib/ontology/factReview";
import type { WorkingCopy } from "../../app/project";
import type { EvidenceRef, FactReview } from "../../types/abox";
import type { EvidenceTab, EvidenceTarget } from "../../types/evidence";
import { EvidenceInspector } from "./EvidenceInspector";
import "./evidence.css";

export function useDocNames(pid: string) {
  const docs = useQuery({ queryKey: qk.documents(pid), queryFn: () => api.listDocuments(pid) });
  return useMemo(() => new Map((docs.data ?? []).map((d) => [d.id, d.name])), [docs.data]);
}
interface EvidenceViewer {
  open: (ref: EvidenceRef, target?: EvidenceTarget) => void;
  openTarget: (target: EvidenceTarget, sourceIndex?: number) => void;
  openFact: (key: string, ref?: EvidenceRef) => Promise<void>;
  close: () => void;
  names: Map<string, string>;
  isOpen: boolean;
  panel: ReactNode;
  /** Compatibility with existing feature pages; the provider owns the single panel. */
  element: null;
}
const Context = createContext<EvidenceViewer | null>(null);
const allowedKinds = new Set(["fact", "term", "passage", "document", "answer", "reference"]);
function decode(value: string | null): EvidenceTarget | null {
  if (!value || value.length > 16000) return null;
  try {
    const target = JSON.parse(value);
    return target && typeof target === "object" && allowedKinds.has(target.kind) ? (target as EvidenceTarget) : null;
  } catch {
    return null;
  }
}
export function EvidenceProvider({ pid, working, children }: { pid: string; working: WorkingCopy; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const rawTarget = params.get("inspect");
  const target = useMemo(() => decode(rawTarget), [rawTarget]);
  const selectedSource = Number(params.get("evidenceSource") ?? 0);
  const sourceIndex = Number.isSafeInteger(selectedSource) && selectedSource >= 0 ? selectedSource : 0;
  const tab: EvidenceTab = params.get("evidenceTab") === "input" ? "input" : params.get("evidenceTab") === "history" ? "history" : "source";
  const expanded = params.get("evidenceExpanded") === "1";
  const embedded = /\/assistant$/.test(location.pathname);
  const isOpen = rawTarget !== null;
  const names = useDocNames(pid);
  const currentWorking = useRef(working);
  currentWorking.current = working;
  const trigger = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const [narrow, setNarrow] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<string | null>(null);
  const reviewedFrom = useRef<string | null>(null);
  const updateParams = useCallback(
    (changes: Record<string, string | null>, replace = true) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace, state: location.state },
      ),
    [setParams, location.state],
  );
  const close = useCallback(
    () => updateParams({ inspect: null, evidenceSource: null, evidenceTab: null, evidenceExpanded: null }),
    [updateParams],
  );
  const openTarget = useCallback(
    (next: EvidenceTarget, index = 0) => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpeningError(null);
      setLastDecision(null);
      reviewedFrom.current = null;
      updateParams(
        {
          inspect: JSON.stringify(next),
          evidenceSource: index ? String(index) : null,
          evidenceTab: null,
          evidenceExpanded: null,
          ...(next.kind === "fact" ? { rev: next.revisionId } : {}),
        },
        false,
      );
    },
    [updateParams],
  );
  const open = useCallback(
    (ref: EvidenceRef, next?: EvidenceTarget) =>
      openTarget(
        next ?? {
          kind: "reference",
          documentId: ref.documentId,
          runId: ref.runId,
          chunkId: ref.chunkId,
          quote: ref.quote,
          start: ref.start,
          end: ref.end,
          page: ref.page,
          stepKey: ref.stepKey,
        },
      ),
    [openTarget],
  );
  const openFact = useCallback(
    async (key: string, ref?: EvidenceRef) => {
      const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        const w = currentWorking.current;
        if (!w.revision) throw new Error("Select a graph version before inspecting its assertions.");
        const id = (await w.flush()) ?? w.revision.id;
        const fact = listFacts(w.content?.abox ?? { individuals: [] }).find((f) => f.key === key);
        const index = ref ? Math.max(0, fact?.evidence.findIndex((e) => e === ref || JSON.stringify(e) === JSON.stringify(ref)) ?? 0) : 0;
        openTarget({ kind: "fact", revisionId: id, factKey: key }, index);
        trigger.current = origin;
      } catch (error) {
        setOpeningError(error instanceof Error ? error.message : "Unable to open the assertion.");
      }
    },
    [openTarget],
  );
  const response = useQuery({
    queryKey: [
      "evidence-inspection",
      pid,
      target,
      sourceIndex,
      target?.kind === "fact" && working.revision?.id === target.revisionId ? working.revision.contentHash : null,
    ],
    queryFn: ({ signal }) => evidenceApi.inspect(pid, { target: target!, sourceIndex }, signal),
    enabled: !!target,
    staleTime: 30000,
    retry: false,
  });
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1050px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (isOpen && !wasOpen.current) panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    if (!isOpen && wasOpen.current && trigger.current?.isConnected) trigger.current.focus();
    wasOpen.current = isOpen;
    const mainElement = main.current;
    if (mainElement) mainElement.inert = isOpen && !embedded && (narrow || expanded);
    const siblings =
      embedded && isOpen && (narrow || expanded)
        ? [...(panelRef.current?.parentElement?.children ?? [])].filter(
            (element): element is HTMLElement => element instanceof HTMLElement && element !== panelRef.current,
          )
        : [];
    for (const element of siblings) element.inert = true;
    return () => {
      if (mainElement) mainElement.inert = false;
      for (const element of siblings) element.inert = false;
    };
  }, [isOpen, narrow, expanded, embedded]);
  useEffect(() => {
    if (!isOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      if (event.key !== "Tab" || !panelRef.current || (!narrow && !expanded)) return;
      const controls = [
        ...panelRef.current.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),select:not(:disabled),summary"),
      ].filter((e) => e.offsetParent !== null);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [isOpen, close, narrow, expanded, embedded]);
  const selectedRevision = params.get("rev");
  useEffect(() => {
    if (target?.kind !== "fact") return;
    if (reviewedFrom.current === target.revisionId && selectedRevision && selectedRevision !== target.revisionId) {
      // The editor can select its new draft before its revision query has settled.
      if (working.revision?.id !== selectedRevision) return;
      if (working.isDraft && working.revision.parentId === target.revisionId) {
        updateParams({ inspect: JSON.stringify({ ...target, revisionId: selectedRevision }), rev: selectedRevision });
        reviewedFrom.current = selectedRevision;
        return;
      }
    }
    if (selectedRevision !== target.revisionId) updateParams({ rev: target.revisionId });
  }, [target, selectedRevision, working.isDraft, working.revision, updateParams]);
  const factTarget = target?.kind === "fact" ? target : undefined;
  const ownerMatches =
    factTarget &&
    working.revision &&
    (working.revision.id === factTarget.revisionId ||
      (reviewedFrom.current === factTarget.revisionId && working.revision.parentId === factTarget.revisionId));
  const localFact = ownerMatches
    ? listFacts(working.content?.abox ?? { individuals: [] }).find((f) => f.key === factTarget.factKey)
    : undefined;
  const localReview: FactReview | undefined = localFact?.by
    ? { status: localFact.status, by: localFact.by, reason: localFact.reason, confidence: localFact.confidence }
    : undefined;
  const canReview = !!localFact && (working.isDraft || response.data?.revision?.current === true);
  // Autosave can finish before its new draft selection has reached this URL.
  // A saved confirmation must describe the same draft that the inspector links to.
  const decisionSaved = working.save === "saved" && working.isDraft && working.revision?.id === factTarget?.revisionId;
  const decide = (status: "accepted" | "rejected") => {
    const w = currentWorking.current;
    if (!factTarget || !canReview || !w.content?.abox) return;
    if (w.save === "conflict" || w.save === "error") {
      setOpeningError("Resolve the draft save error before reviewing more facts.");
      return;
    }
    const label = `${status === "accepted" ? "Accept" : "Reject"} ${response.data?.title ?? "assertion"}`;
    reviewedFrom.current = factTarget.revisionId;
    w.setContent(
      { ...w.content, abox: applyDecisions(w.content.abox, [{ key: factTarget.factKey, status }], new Date().toISOString()).abox },
      label,
    );
    setLastDecision(label);
  };
  const panel = isOpen ? (
    <aside
      ref={panelRef}
      className={`evidence-dock${expanded ? " is-expanded" : ""}${embedded ? " is-embedded gc-panel" : ""}`}
      role={narrow || expanded ? "dialog" : "complementary"}
      aria-modal={narrow || expanded ? true : undefined}
      aria-label="Evidence inspector panel"
    >
      <EvidenceInspector
        pid={pid}
        data={response.data}
        loading={!!target && response.isLoading}
        error={!target ? new Error("This evidence link is invalid. Select a citation or fact to inspect.") : response.error}
        retry={() => void response.refetch()}
        tab={tab}
        onTab={(t) => updateParams({ evidenceTab: t === "source" ? null : t })}
        onSource={(index) => updateParams({ evidenceSource: index ? String(index) : null })}
        onClose={close}
        expanded={expanded}
        onExpand={() => updateParams({ evidenceExpanded: expanded ? null : "1" })}
        embedded={embedded}
        review={localReview}
        canReview={canReview}
        onReview={decide}
        onUndo={
          lastDecision && working.canUndo && working.undoLabel === lastDecision
            ? () => {
                working.undo();
                setLastDecision(null);
              }
            : undefined
        }
        saveLabel={
          lastDecision
            ? decisionSaved
              ? "Decision saved to draft"
              : working.save === "saving" || working.save === "saved"
                ? "Saving draft decision…"
                : "Draft decision updated"
            : undefined
        }
        reviewError={openingError ?? working.saveError}
      />
    </aside>
  ) : null;
  return (
    <Context.Provider value={{ open, openTarget, openFact, close, names, isOpen, panel, element: null }}>
      <div className={`evidence-workspace${isOpen && !embedded ? " is-open" : ""}${expanded && !embedded ? " is-expanded" : ""}`}>
        <div className="evidence-main" ref={main}>
          {openingError && !isOpen && (
            <p className="banner warn" role="alert">
              {openingError}
            </p>
          )}
          {children}
        </div>
        {isOpen && !embedded && (
          <>
            <button className="ei-scrim" type="button" aria-label="Close evidence inspector" onClick={close} />
            {panel}
          </>
        )}
      </div>
    </Context.Provider>
  );
}
export function useEvidenceViewer(pid: string): EvidenceViewer {
  const viewer = useContext(Context);
  const names = useDocNames(pid);
  const unavailable = () => {
    throw new Error("Evidence inspection requires a project workspace.");
  };
  return (
    viewer ?? {
      open: unavailable,
      openTarget: unavailable,
      openFact: async () => unavailable(),
      close: unavailable,
      names,
      isOpen: false,
      panel: null,
      element: null,
    }
  );
}
