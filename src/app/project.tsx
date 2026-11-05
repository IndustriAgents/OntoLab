import { watchWorkspace } from "../lib/workspaceUpdates";
// Project workspace state shared by every page of a project:
//
//  - the project and its revisions (server state, TanStack Query)
//  - the SELECTED revision (URL `?rev=`; defaults to the current committed one)
//  - the WORKING copy of that revision: edits are buffered with undo/redo and
//    auto-saved. Editing a committed revision transparently starts a draft —
//    committed revisions are never modified.
//  - the run driver, which keeps advancing an extraction run one bounded step
//    at a time while this tab is open (closing the tab stops it; reopening
//    offers Resume).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router";
import type { ABoxResult } from "../types/abox";
import type { TBoxModel } from "../types/tbox";
import type { OntoModule } from "../types/validation";
import type { OntologyRevision, Project, RevisionContent, RevisionWithContent, RunView } from "../types/project";
import { api, qk } from "../lib/projectApi";
import { ApiError, NetworkError } from "../lib/http";
import { parseTBox, mergeTBox } from "../lib/ontology/tboxParser";
import { rememberedOntology, rememberOntology, selectedOntology } from "../lib/ontologySelection";
import { useUndoable } from "../hooks/useUndoable";

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export interface WorkingCopy {
  revision: RevisionWithContent | null;
  content: RevisionContent | null;
  tbox: TBoxModel | null;
  baseIri: string;
  isDraft: boolean;
  setAbox: (next: ABoxResult, label?: string) => void;
  setModules: (modules: OntoModule[], label?: string) => void;
  /** replace the whole content (A-Box plus review data such as merge candidates) */
  setContent: (next: RevisionContent, label?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  save: SaveState;
  saveError: string | null;
  /** write pending edits now (before commit / navigation) */
  flush: () => Promise<string | null>;
}

export interface RunDriver {
  runId: string | null;
  driving: boolean;
  error: string | null;
  start: (runId: string) => void;
  stop: () => void;
}

interface ProjectState {
  pid: string;
  project: Project | undefined;
  projectError: unknown;
  revisions: OntologyRevision[];
  current: OntologyRevision | null;
  drafts: OntologyRevision[];
  selectedId: string | null;
  select: (id: string | null) => void;
  working: WorkingCopy;
  driver: RunDriver;
  activeRun: RunView | null;
}

const Ctx = createContext<ProjectState | null>(null);

export function useProject(): ProjectState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProject outside ProjectProvider");
  return v;
}

const tboxCache = new Map<string, TBoxModel | null>();
export function tboxFromModules(modules: OntoModule[], baseIri: string): TBoxModel | null {
  const key = JSON.stringify([modules.map((m) => [m.id, m.turtle]), baseIri]);
  if (tboxCache.has(key)) return tboxCache.get(key)!;
  const models: TBoxModel[] = [];
  for (const m of modules) {
    try {
      models.push(parseTBox(m.turtle));
    } catch {
      /* reported by ontology validation */
    }
  }
  const merged = models.length ? mergeTBox(models, baseIri || undefined) : null;
  tboxCache.set(key, merged);
  if (tboxCache.size > 20) tboxCache.delete(tboxCache.keys().next().value!);
  return merged;
}

const ACTIVE = new Set(["queued", "running", "awaiting_answers"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function useRunDriver(pid: string): RunDriver {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  const stop = useCallback(() => {
    token.current++;
    setRunId(null);
  }, []);

  const start = useCallback(
    (id: string) => {
      const mine = ++token.current;
      setRunId(id);
      setError(null);
      void (async () => {
        let networkFailures = 0;
        while (token.current === mine) {
          try {
            const { run, waitMs } = await api.advance(pid, id);
            networkFailures = 0;
            qc.setQueryData(qk.run(pid, id), run);
            void qc.invalidateQueries({ queryKey: qk.runs(pid) });
            if (!ACTIVE.has(run.status) || run.status === "awaiting_answers") {
              if (run.status === "ready_for_review") void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
              break;
            }
            if (waitMs) await sleep(waitMs);
          } catch (e) {
            if (e instanceof NetworkError && networkFailures < 5) {
              // free hosting may be waking up or restarting: back off and continue
              networkFailures++;
              setError(`Connection lost — retrying (${networkFailures}/5)…`);
              await sleep(3000 * networkFailures);
              continue;
            }
            setError(e instanceof Error ? e.message : "The run could not continue.");
            void qc.invalidateQueries({ queryKey: qk.run(pid, id) });
            break;
          }
        }
        if (token.current === mine) setRunId(null);
      })();
    },
    [pid, qc],
  );

  // stop dispatching when leaving the project
  useEffect(() => () => void token.current++, [pid]);

  return { runId, driving: !!runId, error, start, stop };
}

export function ProjectProvider({ pid, children }: { pid: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const projectQ = useQuery({ queryKey: qk.project(pid), queryFn: () => api.getProject(pid) });
  const revisionsQ = useQuery({ queryKey: qk.revisions(pid), queryFn: () => api.listRevisions(pid), enabled: !!projectQ.data });
  const runsQ = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid), enabled: !!projectQ.data, refetchInterval: 15_000 });
  useEffect(() => {
    const controller = new AbortController();
    void watchWorkspace(
      pid,
      () => {
        void qc.invalidateQueries({ predicate: (query) => query.queryKey.includes(pid) });
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [pid, qc]);
  const project = projectQ.data;
  const revisions = useMemo(() => revisionsQ.data ?? [], [revisionsQ.data]);

  const current = revisions.find((r) => r.id === project?.currentRevisionId) ?? null;
  const drafts = revisions.filter((r) => r.status === "draft");
  const requested = params.get("rev");
  const [rememberedRevision, setRememberedRevision] = useState(() => rememberedOntology(pid));
  const selectedId = project?.settings.corpus
    ? requested && revisions.some((r) => r.id === requested)
      ? requested
      : project.currentRevisionId
    : selectedOntology(revisions, project?.currentRevisionId, requested, rememberedRevision);
  useEffect(() => {
    if (project?.settings.corpus || !requested || !revisions.some((r) => r.id === requested)) return;
    rememberOntology(pid, requested);
    setRememberedRevision(requested);
  }, [pid, requested, revisions, project?.settings.corpus]);

  const select = useCallback(
    (id: string | null) => {
      if (!project?.settings.corpus) {
        rememberOntology(pid, id);
        setRememberedRevision(id);
      }
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id && id !== project?.currentRevisionId) next.set("rev", id);
          else next.delete("rev");
          return next;
        },
        { replace: true, state: location.state },
      );
    },
    [pid, setParams, project?.currentRevisionId, project?.settings.corpus, location.state],
  );

  const revisionQ = useQuery({
    queryKey: qk.revision(pid, selectedId ?? "none"),
    queryFn: () => api.getRevision(pid, selectedId!),
    enabled: !!selectedId,
  });
  const revision = revisionQ.data ?? null;

  /* ── working copy ── */

  const buffer = useUndoable<RevisionContent | null>(null);
  const serverHash = useRef("");
  const owner = useRef<string | null>(null); // revision id the buffer belongs to
  const draftId = useRef<string | null>(null); // draft the buffer saves into
  const dirty = useRef(false);
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<string | null> | null>(null);

  // Load the selected revision into the buffer — unless the buffer already
  // owns it (a draft we just created from local edits).
  useEffect(() => {
    if (!revision) {
      if (!selectedId) {
        owner.current = null;
        draftId.current = null;
        buffer.reset(null);
      }
      return;
    }
    if (owner.current === revision.id) {
      if (!dirty.current && !saving.current && serverHash.current !== revision.contentHash) {
        serverHash.current = revision.contentHash;
        buffer.reset(revision.content);
      }
      // The draft we were saving into has just been committed: further edits
      // must start a new draft rather than write to an immutable revision.
      if (revision.status !== "draft" && draftId.current === revision.id) {
        draftId.current = null;
        setSave("idle");
        setSaveError(null);
      }
      return;
    }
    serverHash.current = revision.contentHash;
    owner.current = revision.id;
    draftId.current = revision.status === "draft" ? revision.id : null;
    dirty.current = false;
    buffer.reset(revision.content);
    setSave("idle");
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, selectedId]);

  const content = buffer.value;
  const latest = useRef(content);
  latest.current = content;

  const doSave = useCallback(async (): Promise<string | null> => {
    if (saving.current) await saving.current;
    if (!dirty.current || !latest.current) return draftId.current;
    const snapshot = latest.current;
    dirty.current = false;
    setSave("saving");
    const p = (async () => {
      try {
        if (!draftId.current) {
          const created = await api.createDraft(pid, snapshot, "Manual edits", "manual");
          serverHash.current = created.contentHash;
          draftId.current = created.id;
          owner.current = created.id;
          qc.setQueryData(qk.revision(pid, created.id), { ...created, content: snapshot });
          void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
          select(created.id);
        } else {
          const updated = await api.saveDraft(
            pid,
            draftId.current,
            snapshot,
            undefined,
            serverHash.current,
          );
          serverHash.current = updated.contentHash;
          qc.setQueryData(qk.revision(pid, updated.id), { ...updated, content: snapshot });
          void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
          void qc.invalidateQueries({ queryKey: qk.report(pid, updated.id) });
        }
        setSave(dirty.current ? "saving" : "saved");
        setSaveError(null);
        return draftId.current;
      } catch (e) {
        dirty.current = true;
        const conflict = e instanceof ApiError && e.status === 409;
        setSave(conflict ? "conflict" : "error");
        setSaveError(e instanceof Error ? e.message : "Could not save.");
        return null;
      }
    })();
    saving.current = p;
    try {
      return await p;
    } finally {
      saving.current = null;
    }
  }, [pid, qc, select]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSave(), 800);
  }, [doSave]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const saved = await doSave();
    if (dirty.current) throw new Error("Your editor changes could not be saved. Resolve the save conflict before continuing.");
    return saved;
  }, [doSave]);

  // Save before the tab goes away; warn if that may not complete.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      void doSave();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [doSave]);

  // Flush when leaving the project.
  useEffect(() => () => void (dirty.current && doSave()), [doSave]);

  const setAbox = useCallback(
    (next: ABoxResult, label?: string) => {
      if (!latest.current) return;
      buffer.set({ ...latest.current, abox: next }, label);
      schedule();
    },
    [buffer, schedule],
  );
  const setModules = useCallback(
    (modules: OntoModule[], label?: string) => {
      if (!latest.current) return;
      buffer.set({ ...latest.current, modules }, label);
      schedule();
    },
    [buffer, schedule],
  );
  const setContent = useCallback(
    (next: RevisionContent, label?: string) => {
      if (!latest.current) return;
      buffer.set(next, label);
      schedule();
    },
    [buffer, schedule],
  );
  const undo = useCallback(() => {
    buffer.undo();
    schedule();
  }, [buffer, schedule]);
  const redo = useCallback(() => {
    buffer.redo();
    schedule();
  }, [buffer, schedule]);

  const tbox = useMemo(() => (content ? tboxFromModules(content.modules, content.baseIri) : null), [content]);
  const baseIri = content?.baseIri || tbox?.baseIri || "";

  const working: WorkingCopy = {
    revision,
    content,
    tbox,
    baseIri,
    isDraft: revision?.status === "draft",
    setAbox,
    setModules,
    setContent,
    undo,
    redo,
    canUndo: buffer.canUndo,
    canRedo: buffer.canRedo,
    undoLabel: buffer.undoLabel,
    save,
    saveError,
    flush,
  };

  const driver = useRunDriver(pid);
  const activeRun = (runsQ.data ?? []).find((r) => ACTIVE.has(r.status)) ?? null;
  const activeRunLive = useQuery({
    queryKey: qk.run(pid, activeRun?.id ?? "none"),
    queryFn: () => api.getRun(pid, activeRun!.id),
    enabled: !!activeRun,
    initialData: activeRun ?? undefined,
  }).data;

  const value: ProjectState = {
    pid,
    project,
    projectError: projectQ.error,
    revisions,
    current,
    drafts,
    selectedId,
    select,
    working,
    driver,
    activeRun: activeRunLive && ACTIVE.has(activeRunLive.status) ? activeRunLive : (activeRun ?? null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
