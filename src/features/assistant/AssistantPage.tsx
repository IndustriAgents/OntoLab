import { hasCitation } from "../../lib/answerCitations";
import type { AnswerPassage } from "../../types/sourceEvidence";
// Assistant with two explicit modes:
//   Ask              — graph chat (from kg_chatbot): the assistant answers by
//                      running SPARQL on the project graph (or the GraphDB
//                      repository the project publishes to) and searching the
//                      documents. Each step streams in, and the evidence window
//                      shows every query, its results, the evidence graph and
//                      the trace. Answers cite queries [Q1] and passages [C1].
//   Propose changes  — a draft revision with a diff and its validation impact;
//                      nothing changes until the draft is committed.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { useTheme } from "../../app/theme";
import { useModelChoice, selectProps } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import type { AssistantMode, Citation, Conversation, ConversationMessage } from "../../types/project";
import type { GraphSource } from "../../types/graphChat";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { ConfirmButton, EmptyState, InlineError, StatusBadge, fmtDate } from "../../components/ui/ui";
import { IconArrowRight, IconPlus, IconTrash } from "../../components/icons";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { CommitDialog } from "../revisions/RevisionBar";
import { EvidenceStatusBadge } from "../documents/DocumentViewer";
import { EvidencePanel, type PanelTab } from "./EvidencePanel";
import { Markdown } from "./Markdown";
import { applyEvent, formatMs, newTurn, plural, queryLine, streamChat, toolLabel, turnFromMessage, type Turn } from "./graphChat";
import "./assistant.css";
import "./ask-workspace.css";

const ROUTE_LABEL = { single: "passages", multi: "graph walk", aggregate: "graph query" } as const;

function ComposerHelp({ mode }: { mode: AssistantMode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="gc-composer-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="icon-btn"
        aria-label={mode === "ask" ? "About Ask mode" : "About Propose changes mode"}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7v1" />
        </svg>
      </button>
      {open && (
        <span className="gc-composer-tooltip" id={id} role="tooltip">
          {mode === "ask"
            ? "Read-only: the assistant queries your graph and searches available documents. Answers cite the queries [Q1] and passages [C1] used."
            : "Creates a draft revision with a diff. Nothing changes until you apply it."}
        </span>
      )}
    </div>
  );
}

/** Answers stored before graph chat: plain text with [C1] and [[id]] links. */
function renderLegacy(text: string, citations: Citation[], onCite: (c: Citation) => void, onEntity: (id: string) => void): ReactNode[] {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  return text.split(/(\[C\d+\]|\[\[[^\]]+\]\])/g).map((part, i) => {
    const c = /^\[(C\d+)\]$/.exec(part);
    if (c) {
      const cit = byRef.get(c[1]);
      return cit ? (
        <button key={i} className="cite cite-src" onClick={() => onCite(cit)} title={`Open source: “${cit.evidence.quote}”`}>
          {c[1]}
        </button>
      ) : (
        <span key={i}>{part}</span>
      );
    }
    const e = /^\[\[([^\]]+)\]\]$/.exec(part);
    if (e)
      return (
        <button key={i} className="cite" onClick={() => onEntity(e[1])} title="Show in Explore">
          {e[1]}
        </button>
      );
    return <span key={i}>{part}</span>;
  });
}

function Proposal({ msg }: { msg: ConversationMessage }) {
  const { pid, revisions } = useProject();
  const qc = useQueryClient();
  const [committing, setCommitting] = useState(false);
  const p = msg.proposal!;
  const rev = revisions.find((r) => r.id === p.draftRevisionId);
  const discard = useMutation({
    mutationFn: () => api.discardDraft(pid, p.draftRevisionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.revisions(pid) }),
  });
  const state = !rev ? "gone" : rev.status === "committed" ? "applied" : "pending";
  const d = p.diff.individuals;
  const delta = (a: number, b: number) => (b === a ? "unchanged" : b > a ? `+${b - a}` : `${b - a}`);
  return (
    <div className="proposal">
      <div className="proposal-head">
        <b>Proposed change</b>
        {state === "applied" ? (
          <StatusBadge tone="ok">Applied as revision {rev?.number}</StatusBadge>
        ) : state === "gone" ? (
          <StatusBadge tone="muted">Discarded</StatusBadge>
        ) : (
          <StatusBadge tone="warn">Not applied</StatusBadge>
        )}
      </div>
      <ul className="diff-summary">
        {d.added.length > 0 && (
          <li>
            Add {d.added.length}: {d.added.slice(0, 8).join(", ")}
            {d.added.length > 8 ? "…" : ""}
          </li>
        )}
        {d.removed.length > 0 && (
          <li>
            Remove {d.removed.length}: {d.removed.slice(0, 8).join(", ")}
            {d.removed.length > 8 ? "…" : ""}
          </li>
        )}
        {d.changed.length > 0 && (
          <li>
            Change {d.changed.length}:{" "}
            {d.changed
              .slice(0, 6)
              .map((c) => `${c.id} (${c.changes.join(", ")})`)
              .join("; ")}
          </li>
        )}
      </ul>
      <p className="small">
        Validation errors: {p.validation.before.errors} → {p.validation.after.errors} (
        {delta(p.validation.before.errors, p.validation.after.errors)}); warnings: {p.validation.before.warnings} →{" "}
        {p.validation.after.warnings}
      </p>
      {state === "pending" && rev && (
        <div className="row-actions">
          <Link className="btn ghost sm" to={`/p/${pid}/explore?rev=${rev.id}`}>
            Review in Explore
          </Link>
          <ConfirmButton label="Discard" confirmLabel="Discard proposal" onConfirm={() => discard.mutate()} />
          <button className="btn sm" onClick={() => setCommitting(true)}>
            Apply…
          </button>
        </div>
      )}
      {committing && rev && <CommitDialog revision={rev} onClose={() => setCommitting(false)} />}
    </div>
  );
}

/** The progress lines shown while an answer streams in. */
function Working({ turn }: { turn: Turn }) {
  const lastTool = turn.tools[turn.tools.length - 1];
  return (
    <ul className="gc-working" aria-live="polite">
      {turn.tools.map((c) => (
        <li key={c.id}>
          {c.ok === undefined ? (
            <span className="spinner sm" aria-hidden="true" />
          ) : (
            <span className={c.ok ? "gc-ok" : "gc-bad"}>{c.ok ? "✓" : "!"}</span>
          )}
          <span>
            {toolLabel(c.name)} {c.queryId && <span className="gc-qid">{c.queryId}</span>}
          </span>
          <span className="mono-sm gc-working-q">
            {c.name === "sparql_query" ? queryLine(String(c.input.query ?? "")) : String(c.input.query ?? "")}
          </span>
        </li>
      ))}
      {(!lastTool || lastTool.ok !== undefined) && (
        <li>
          <span className="spinner sm" aria-hidden="true" />
          <span>{turn.statusText ?? "Thinking"}…</span>
        </li>
      )}
    </ul>
  );
}

function EvidenceStrip({ turn, active, onOpen }: { turn: Turn; active: boolean; onOpen: () => void }) {
  const queries = turn.runs.filter((r) => r.purpose === "agent").length;
  return (
    <div className="gc-strip">
      <span>
        {plural(queries, "database query", "database queries")}
        {turn.graph ? ` · ${plural(turn.graph.edges.length, "triple")} of evidence` : ""}
        {turn.durationMs !== undefined ? ` · ${formatMs(turn.durationMs)}` : ""}
      </span>
      <button type="button" className={"btn sm" + (active ? "" : " ghost")} onClick={onOpen} aria-pressed={active}>
        {active ? "Viewing evidence" : "View evidence"} →
      </button>
    </div>
  );
}

function CopyAnswer({ message }: { message: ConversationMessage }) {
  const [state, setState] = useState("");
  const copy = async () => {
    const passages = message.agent?.passages?.filter((p) => hasCitation(message.content, p.ref)) ?? [];
    const sources = passages.map((p) => `[${p.ref}] ${p.where} · ${message.agent?.sourceLabel ?? ""}`);
    const text = [message.content, ...sources].join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setState("Copied with sources");
    } catch {
      setState("Clipboard unavailable. Select the answer text to copy it.");
    }
  };
  return (
    <div className="row-actions">
      <button className="btn ghost sm" type="button" onClick={() => void copy()}>
        Copy answer with sources
      </button>
      {state && (
        <span className="small" role="status">
          {state}
        </span>
      )}
    </div>
  );
}

export default function AssistantPage() {
  const { pid, selectedId, current, project, revisions, working } = useProject();
  const { config } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const ev = useEvidenceViewer(pid);
  const [mode, setMode] = useState<AssistantMode>("ask");
  const [text, setText] = useState("");
  // The open conversation lives in the URL, so it survives a reload and can be linked.
  const [params, setParams] = useSearchParams();
  const activeId = params.get("c");
  const sourceLink = params.get("source");
  const linkedSource = sourceLink?.split(".");
  const previousSourceLink = useRef(sourceLink);
  const setActiveId = (id: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (n.get("c") !== id) n.delete("source");
        if (id) n.set("c", id);
        else n.delete("c");
        return n;
      },
      { replace: true },
    );
  const [pending, setPending] = useState<{ mode: AssistantMode; text: string } | null>(null);
  const [live, setLive] = useState<Turn | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<string | null>(linkedSource?.[0] ?? null);
  const [tab, setTab] = useState<PanelTab>("sources");
  const [focusSource, setFocusSource] = useState<string | undefined>(linkedSource?.[1]);
  const [selectedPassage, setSelectedPassage] = useState<AnswerPassage & { revisionId: string; sourceLabel: string }>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnSelector = useRef<string>();
  const restoreEvidenceFocus = useCallback(
    () =>
      requestAnimationFrame(() => {
        // A citation can remount while its source opens. A connected body (or
        // another control) is not the origin; resolve the saved citation instead.
        const target =
          returnFocus.current?.isConnected &&
          (!returnSelector.current || returnFocus.current.matches(returnSelector.current))
          ? returnFocus.current
          : returnSelector.current
            ? document.querySelector<HTMLElement>(returnSelector.current)
            : composer.current;
        target?.focus();
      }),
    [],
  );
  const closeEvidence = () => {
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("source");
        return n;
      },
      { replace: true },
    );
    setPanelOpen(false);
    restoreEvidenceFocus();
  };
  const [focusQuery, setFocusQuery] = useState<string>();
  const [panelOpen, setPanelOpen] = useState(!!sourceLink);
  useEffect(() => {
    if (sourceLink) {
      const [message, ref] = sourceLink.split(".");
      setSelectedTurn(message);
      setFocusSource(ref);
      setTab("sources");
      setPanelOpen(true);
    } else if (previousSourceLink.current) setPanelOpen(false);
    previousSourceLink.current = sourceLink;
  }, [sourceLink]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [askError, setAskError] = useState<unknown>(null);
  const abortRef = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const graphdbRepo = config?.features?.graphdb ? project?.settings.graphdb?.repository : undefined;
  const [source, setSource] = useState<GraphSource>("project");
  const external = !!project?.settings.externalGraph;
  const effectiveSource: GraphSource = external ? "external" : source === "graphdb" && graphdbRepo ? "graphdb" : "project";
  const viewed = revisions.find((r) => r.id === selectedId) ?? current;
  const revisionLabel = viewed?.number
    ? `${project?.settings.corpus ? "Graph version" : "Ontology version"} ${viewed.number}`
    : "Draft version";
  const sourceLabel = external
    ? `Connected graph · ${project?.name}`
    : effectiveSource === "graphdb"
      ? `GraphDB · ${graphdbRepo}`
      : revisionLabel;

  const convs = useQuery({ queryKey: qk.conversations(pid), queryFn: () => api.listConversations(pid) });
  const active = useMemo(() => convs.data?.find((c) => c.id === activeId) ?? null, [convs.data, activeId]);
  const suggestions = useQuery({
    queryKey: ["chat-suggestions", pid, effectiveSource, selectedId],
    queryFn: () => api.chatSuggestions(pid, effectiveSource, selectedId ?? undefined),
    enabled: (!!current || external) && mode === "ask",
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Stored answers as turns, keyed by message id.
  const turns = useMemo(() => {
    const m = new Map<string, Turn>();
    const msgs = active?.messages ?? [];
    msgs.forEach((msg, i) => {
      if (msg.role !== "assistant") return;
      const q = msgs[i - 1]?.role === "user" ? msgs[i - 1].content : "";
      const t = turnFromMessage(q, msg);
      if (t) m.set(msg.id, t);
    });
    return m;
  }, [active]);
  const shownTurn =
    (live && (!selectedTurn || selectedTurn === live.id) ? live : selectedTurn ? turns.get(selectedTurn) : undefined) ?? undefined;
  const lastTurnId = [...turns.keys()].at(-1) ?? null;
  const panelTurn = shownTurn ?? (lastTurnId ? turns.get(lastTurnId) : undefined);
  const conversations = (convs.data ?? []).filter((c) => c.title.toLowerCase().includes(historySearch.trim().toLowerCase()));
  const providerLabel = choice.providers.find((p) => p.id === choice.provider)?.label ?? choice.provider;
  useEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(180, Math.max(64, field.scrollHeight))}px`;
  }, [text]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        setParams(
          (prev) => {
            const n = new URLSearchParams(prev);
            n.delete("source");
            return n;
          },
          { replace: true },
        );
        restoreEvidenceFocus();
        setHistoryOpen(false);
        setModelSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [restoreEvidenceFocus, setParams]);
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!panelOpen && (active?.messages.length || pending || live?.answer || live?.status === "streaming"))
      end.current?.scrollIntoView({ block: "end" });
  }, [active?.messages.length, pending, live?.answer, live?.status, live?.tools.length, panelOpen]);

  const toEntity = (id: string) =>
    navigate(
      `/p/${pid}/explore?sel=${encodeURIComponent(id)}${selectedId && selectedId !== project?.currentRevisionId ? `&rev=${selectedId}` : ""}`,
    );
  const openSource = (msg: ConversationMessage | undefined, ref: string) => {
    const turn = msg ? turns.get(msg.id) : live;
    if (turn?.passages?.some((p) => p.ref === ref)) {
      returnFocus.current = document.activeElement as HTMLElement;
      returnSelector.current = `.msg[data-message-id="${CSS.escape(turn.id)}"] [data-citation-ref="${CSS.escape(ref)}"]`;
      if (!turn.id.startsWith("live-"))
        setParams((prev) => {
          const n = new URLSearchParams(prev);
          n.set("source", `${turn.id}.${ref}`);
          return n;
        });
      setSelectedTurn(turn.id);
      setFocusSource(ref);
      setTab("sources");
      setPanelOpen(true);
    } else {
      const c = msg?.citations?.find((x) => x.ref === ref);
      if (c && msg && activeId) {
        setSelectedTurn(msg.id);
        setPanelOpen(true);
        ev.openTarget({ kind: "answer", conversationId: activeId, messageId: msg.id, ref });
      }
    }
  };

  const ask = async (question: string) => {
    if (live?.status === "streaming") return;
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("source");
        return n;
      },
      { replace: true },
    );
    setPanelOpen(false);
    const turn = newTurn(question, effectiveSource, selectedPassage?.sourceLabel ?? sourceLabel);
    setLive(turn);
    setSelectedTurn(turn.id);
    setFocusQuery(undefined);
    setFocusSource(undefined);
    setTab("sources");
    setAskError(null);
    setText("");
    const controller = new AbortController();
    abortRef.current = controller;
    let savedConv: string | null = null;
    let savedMsg: string | null = null;
    try {
      await streamChat(
        pid,
        {
          question,
          conversationId:
            active?.revisionId && active.revisionId !== (selectedPassage ? selectedPassage.revisionId : (selectedId ?? current?.id))
              ? undefined
              : (activeId ?? undefined),
          passageKey: selectedPassage?.key,
          revisionId: (selectedPassage ? selectedPassage.revisionId : (selectedId ?? current?.id)) ?? undefined,
          provider: choice.provider,
          model: choice.model,
          source: effectiveSource,
        },
        (e) => {
          if (e.type === "saved") {
            savedConv = e.conversationId;
            savedMsg = e.messageId;
            return;
          }
          setLive((t) => (t ? applyEvent(t, e) : t));
        },
        controller.signal,
      );
      setLive((t) =>
        t && t.status === "streaming" ? { ...t, status: "error", error: "The connection closed before the answer finished." } : t,
      );
    } catch (err) {
      if (controller.signal.aborted) setLive((t) => (t ? { ...t, status: "stopped", statusText: undefined } : t));
      else {
        setLive(null);
        setText(question);
        setAskError(err);
      }
    } finally {
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: qk.conversations(pid) });
    }
    if (savedConv && savedMsg) {
      await qc.invalidateQueries({ queryKey: qk.conversations(pid) });
      setActiveId(savedConv);
      setSelectedTurn(savedMsg);
      setLive(null);
      setSelectedPassage(undefined);
    }
  };

  const propose = useMutation({
    mutationFn: (instruction: string) =>
      api.propose(pid, {
        instruction,
        conversationId: activeId ?? undefined,
        revisionId: selectedId ?? undefined,
        provider: choice.provider,
        model: choice.model,
      }),
    onMutate: (instruction) => setPending({ mode: "propose", text: instruction }),
    onSuccess: (r) => {
      setText("");
      setActiveId(r.conversation.id);
      qc.setQueryData<Conversation[]>(qk.conversations(pid), (old) => [
        r.conversation,
        ...(old ?? []).filter((c) => c.id !== r.conversation.id),
      ]);
      if (r.message.proposal) void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
    },
    onSettled: () => setPending(null),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConversation(pid, id),
    onSuccess: (_d, id) => {
      if (activeId === id) {
        setActiveId(null);
        setSelectedTurn(null);
        setPanelOpen(false);
      }
      void qc.invalidateQueries({ queryKey: qk.conversations(pid) });
    },
  });

  const busy = live?.status === "streaming" || propose.isPending;
  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    if (mode === "ask") void ask(t);
    else propose.mutate(t);
  };
  const openTurn = (id: string) => {
    setSelectedTurn(id);
    setFocusQuery(undefined);
    setFocusSource(undefined);
    setTab("sources");
    returnFocus.current = document.activeElement as HTMLElement;
    returnSelector.current = undefined;
    setPanelOpen(true);
  };

  if (!current && !external)
    return (
      <div className="page">
        <EmptyState
          title="The assistant needs an ontology"
          action={
            <Link className="btn" to={`/p/${pid}/ontology`}>
              Set up the ontology
            </Link>
          }
        />
      </div>
    );

  const msgs = active?.messages ?? [];
  const panelMessage = msgs.find((m) => m.id === panelTurn?.id);
  return (
    <div
      className={
        "assistant gc-assistant ask-workspace" + (panelOpen || ev.isOpen ? " panel-open" : "") + (historyOpen ? " history-open" : "")
      }
    >
      {historyOpen && (
        <nav className="conv-list" id="ask-history" aria-label="Conversations">
          <div className="ask-history-head">
            <div>
              <span className="eyebrow">Your workspace</span>
              <h2>Conversations</h2>
            </div>
            <button className="icon-btn sm" onClick={() => setHistoryOpen(false)} aria-label="Close conversation history">
              ×
            </button>
          </div>
          <button
            className="btn ask-new-conversation"
            disabled={busy}
            onClick={() => {
              setActiveId(null);
              setSelectedTurn(null);
              setLive(null);
              setPanelOpen(false);
              setHistoryOpen(false);
              composer.current?.focus();
            }}
          >
            <IconPlus /> New conversation
          </button>
          <label className="field ask-history-search">
            <span className="sr-only">Search conversations</span>
            <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Search conversations…" />
          </label>
          <InlineError error={convs.error} />
          {!convs.isLoading && !conversations.length && (
            <p className="ask-history-empty">{historySearch ? "No matching conversations." : "Your conversations will appear here."}</p>
          )}
          {busy && <p className="field-hint">Finish or stop the response before switching conversations.</p>}
          <ul>
            {conversations.map((c) => (
              <li key={c.id} className={c.id === activeId ? "is-active" : ""}>
                <button
                  className="conv-link"
                  disabled={busy}
                  onClick={() => {
                    setActiveId(c.id);
                    setSelectedTurn(null);
                    setLive(null);
                    setPanelOpen(false);
                    setHistoryOpen(false);
                  }}
                >
                  <span className="grow">{c.title}</span>
                  <span className="row-sub">{fmtDate(c.updatedAt)}</span>
                </button>
                <button
                  className="icon-btn sm"
                  disabled={busy || remove.isPending}
                  aria-label={`Delete conversation ${c.title}`}
                  onClick={() => remove.mutate(c.id)}
                >
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="chat">
        <header className="ask-header">
          <div className="ask-heading">
            <span className="eyebrow">{project?.name}</span>
            <h1>Ask</h1>
            <p>
              <span className="ask-source-dot" />
              {sourceLabel}
              <span className="ask-context-divider">·</span>
              <span>
                {external
                  ? "Live connection"
                  : project?.settings.corpus
                    ? "Sources saved with each answer version"
                    : "Graph and source documents"}
              </span>
              {working.content?.corpus?.ontology && (
                <Link
                  className="ask-ontology-link"
                  to={`/p/${working.content.corpus.ontology.projectId}/ontology?tab=review&rev=${working.content.corpus.ontology.revisionId}`}
                >
                  Ontology v{working.content.corpus.ontology.number} · pinned ↗
                </Link>
              )}
            </p>
          </div>
          <div className="ask-header-actions">
            <button
              className="btn ghost sm"
              aria-expanded={historyOpen}
              aria-controls="ask-history"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              History{convs.data?.length ? ` (${convs.data.length})` : ""}
            </button>
            {panelTurn && (
              <button className="btn ghost sm" aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
                {panelOpen ? "Hide evidence" : "Show evidence"}
              </button>
            )}
          </div>
        </header>
        <div className="chat-thread" aria-live="polite">
          {!msgs.length && !pending && !live && (
            <div className="gc-hero">
              <span className="ask-hero-mark" aria-hidden="true">
                <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="29" cy="19" r="4" />
                  <circle cx="15" cy="30" r="4" />
                  <path d="m16 14 9 4M14 16l1 10m4 2 7-6" />
                </svg>
              </span>
              <h2>{mode === "ask" ? "What would you like to find out?" : "What would you like to change?"}</h2>
              <p>
                {mode === "ask"
                  ? "Ask in plain language, then follow the queries and sources behind each answer."
                  : "Describe a change to your graph. Review the proposed draft before choosing to apply it."}
              </p>
              {mode === "ask" && (suggestions.data?.length ?? 0) > 0 && (
                <div className="gc-suggestions">
                  {suggestions.data!.slice(0, 4).map((q, i) => (
                    <button key={q} type="button" className="gc-suggestion" onClick={() => void ask(q)} disabled={!choice.providerEnabled}>
                      <span className="ask-suggestion-kicker">
                        {["Get an overview", "Find the detail", "Connect the dots", "Compare findings"][i]}
                      </span>
                      <span>{q}</span>
                      <IconArrowRight />
                    </button>
                  ))}
                </div>
              )}
              <div className="ask-trust-note">
                <span>Read-only questions</span>
                <span>Cited answers</span>
                <span>Evidence on demand</span>
              </div>
            </div>
          )}
          {msgs.map((m) => {
            const turn = turns.get(m.id);
            return (
              <div key={m.id} data-message-id={m.id} className={`msg msg-${m.role}`}>
                <div className="msg-meta">
                  {m.role === "user" ? "You" : "Assistant"} · {m.mode === "ask" ? "Ask" : "Propose"} · {fmtDate(m.createdAt)}
                  {m.agent && ` · ${m.agent.sourceLabel}`}
                  {m.route && ` · ${ROUTE_LABEL[m.route]}`}
                </div>
                {m.role === "assistant" && m.agent ? (
                  <Markdown
                    text={m.content}
                    passages={m.agent.passages}
                    onQuery={(id) => {
                      openTurn(m.id);
                      setFocusQuery(id);
                      setTab("sparql");
                    }}
                    onSource={(ref) => openSource(m, ref)}
                    onEntity={toEntity}
                  />
                ) : (
                  <div className="msg-body">
                    {m.role === "assistant" ? renderLegacy(m.content, m.citations ?? [], (c) => openSource(m, c.ref), toEntity) : m.content}
                  </div>
                )}
                {m.citations && m.citations.length > 0 && (
                  <ul className="citations">
                    {m.citations.map((c) => (
                      <li key={c.ref}>
                        <button className="cite cite-src" onClick={() => openSource(m, c.ref)}>
                          {c.ref}
                        </button>
                        <span className="grow small">
                          {c.evidence.documentId ? ev.names.get(c.evidence.documentId) : ""}
                          {c.evidence.page ? `, page ${c.evidence.page}` : ""} — “{c.evidence.quote.slice(0, 120)}”
                        </span>
                        <EvidenceStatusBadge status={c.evidence.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {m.query && (
                  <details className="query-details">
                    <summary>Computed with SPARQL over the whole graph</summary>
                    <pre className="code-block">{m.query.sparql}</pre>
                  </details>
                )}
                {m.agent?.sourceCoverage && m.agent.sourceCoverage.available < m.agent.sourceCoverage.total && (
                  <p className="field-hint" role="status">
                    Source coverage incomplete: {m.agent.sourceCoverage.available} of {m.agent.sourceCoverage.total} saved documents were
                    searchable.
                  </p>
                )}
                {m.agent?.completion === "interrupted" && <p className="small">Stopped · Incomplete answer</p>}
                {m.agent?.completion === "failed" && <p className="small">Incomplete answer: {m.agent.error}</p>}
                {turn && <CopyAnswer message={m} />}
                {turn && <EvidenceStrip turn={turn} active={panelOpen && panelTurn?.id === m.id} onOpen={() => openTurn(m.id)} />}
                {turn && project?.settings.corpus && turn.source === "project" && (
                  <Link
                    className="btn ghost sm"
                    to={`/p/${pid}/evaluate?new=1&questionText=${encodeURIComponent(turn.question)}${selectedId ? `&candidate=${encodeURIComponent(selectedId)}` : ""}`}
                  >
                    Add question to evaluation
                  </Link>
                )}
                {m.proposal && <Proposal msg={m} />}
              </div>
            );
          })}
          {live && (
            <>
              <div className="msg msg-user">
                <div className="msg-meta">You · Ask</div>
                <div className="msg-body">{live.question}</div>
              </div>
              <div className="msg msg-assistant" data-message-id={live.id}>
                <div className="msg-meta">Assistant · Ask · {live.sourceLabel}</div>
                {live.status === "streaming" && !live.answer && <Working turn={live} />}
                {live.answer && (
                  <Markdown
                    text={live.answer}
                    passages={live.passages ?? []}
                    onQuery={(id) => (openTurn(live.id), setFocusQuery(id), setTab("sparql"))}
                    onSource={(ref) => openSource(undefined, ref)}
                    onEntity={toEntity}
                  />
                )}
                {live.error && <p className="dz-error">{live.error}</p>}
                {live.status === "stopped" && <p className="small muted">Stopped.</p>}
                {(live.runs.length > 0 || live.status !== "streaming") && (
                  <EvidenceStrip turn={live} active={panelOpen && panelTurn?.id === live.id} onOpen={() => openTurn(live.id)} />
                )}
              </div>
            </>
          )}
          {pending && (
            <>
              <div className="msg msg-user">
                <div className="msg-meta">You · Propose</div>
                <div className="msg-body">{pending.text}</div>
              </div>
              <div className="msg msg-assistant">
                <span className="dot-typing" aria-label="Assistant is working" />
              </div>
            </>
          )}
          <div ref={end} />
        </div>

        <form
          className="chat-foot"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="gc-composer">
            <div className="gc-composer-head">
              <div className="segmented" role="radiogroup" aria-label="Assistant mode">
                <button
                  type="button"
                  role="radio"
                  disabled={busy}
                  aria-checked={mode === "ask"}
                  className={mode === "ask" ? "on" : ""}
                  onClick={() => setMode("ask")}
                >
                  Ask
                </button>
                <button
                  type="button"
                  role="radio"
                  disabled={external || busy}
                  title={external ? "Connected graphs are read-only" : undefined}
                  aria-checked={mode === "propose"}
                  className={mode === "propose" ? "on" : ""}
                  onClick={() => setMode("propose")}
                >
                  Propose changes
                </button>
              </div>
              <ComposerHelp key={mode} mode={mode} />
            </div>
            {active?.revisionId && active.revisionId !== (selectedPassage?.revisionId ?? selectedId ?? current?.id) && (
              <p className="field-hint">Your next question will start a new conversation in {revisionLabel}.</p>
            )}
            {selectedPassage && (
              <p className="field-hint">
                Using saved passage: {selectedPassage.title}{" "}
                <button type="button" className="text-btn" onClick={() => setSelectedPassage(undefined)}>
                  Remove
                </button>
              </p>
            )}
            <textarea
              ref={composer}
              className="chat-textarea"
              aria-label={mode === "ask" ? "Question" : "Requested change"}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={mode === "ask" ? "Ask a question about your graph…" : "Describe a change to review…"}
            />
            <div className="gc-composer-footer">
              <div className="gc-composer-models">
                <button
                  type="button"
                  className="ask-model-trigger"
                  aria-expanded={modelSettingsOpen}
                  onClick={() => setModelSettingsOpen((v) => !v)}
                >
                  {providerLabel} <span>· {choice.model || "Default model"}</span>
                  <span aria-hidden="true">⌄</span>
                </button>
                {modelSettingsOpen && (
                  <div className="ask-model-settings">
                    <div className="ask-model-settings-head">
                      <strong>Model settings</strong>
                      <button
                        type="button"
                        className="icon-btn sm"
                        onClick={() => setModelSettingsOpen(false)}
                        aria-label="Close model settings"
                      >
                        ×
                      </button>
                    </div>
                    {mode === "ask" && !external && config?.features?.graphdb && (
                      <label className="compact-field">
                        <span>Answer from</span>
                        <select value={effectiveSource} onChange={(e) => setSource(e.target.value as GraphSource)} aria-label="Answer from">
                          <option value="project">Project graph ({revisionLabel})</option>
                          <option value="graphdb" disabled={!graphdbRepo}>
                            {graphdbRepo ? `GraphDB · ${graphdbRepo}` : "GraphDB (choose a repository in Overview › Settings)"}
                          </option>
                        </select>
                      </label>
                    )}
                    <ProviderModelSelect {...selectProps(choice)} structuredOnly compact disabled={busy} />
                  </div>
                )}
              </div>
              {live?.status === "streaming" ? (
                <button className="btn ghost gc-composer-stop" type="button" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button
                  className="btn gc-composer-send"
                  type="submit"
                  aria-label={propose.isPending ? "Working…" : mode === "ask" ? "Send question" : "Propose changes"}
                  title={mode === "ask" ? "Send question (Enter)" : "Propose changes (Enter)"}
                  disabled={!text.trim() || busy || !choice.providerEnabled}
                >
                  <IconArrowRight />
                </button>
              )}
            </div>
          </div>
          <p className="ask-composer-hint">
            {external
              ? "Questions use live data. Your graph stays unchanged."
              : mode === "ask"
                ? "Answers use your graph and sources. Open a citation to inspect the evidence."
                : "Changes are proposed as a draft for you to review."}
            <span>Enter to send · Shift + Enter for a new line</span>
          </p>
          {!choice.providerEnabled && (
            <p className="field-hint">
              Choose an enabled model to continue.{" "}
              <button type="button" className="text-btn" onClick={() => setModelSettingsOpen(true)}>
                Open model settings
              </button>
            </p>
          )}
          <InlineError error={askError ?? propose.error ?? remove.error} />
        </form>
      </div>

      {panelOpen && !ev.isOpen && (
        <EvidencePanel
          pid={pid}
          conversationId={activeId ?? undefined}
          onOpenDocument={(p) => {
            const citation = panelMessage?.citations?.find(
              (c) => c.ref === p.ref && c.evidence.quote === p.evidence.quote && c.evidence.runId === p.evidence.runId,
            );
            if (citation && panelMessage && activeId)
              ev.openTarget({ kind: "answer", conversationId: activeId, messageId: panelMessage.id, ref: citation.ref });
            else ev.open(p.evidence);
          }}
          focusSource={focusSource}
          onUsePassage={(p) => {
            setSelectedPassage({ ...p, revisionId: panelTurn!.revisionId!, sourceLabel: panelTurn!.sourceLabel ?? "Saved graph" });
            setText(`Using this passage, answer: ${panelTurn?.question ?? "What finding is supported, and under which conditions?"}`);
            closeEvidence();
            composer.current?.focus();
          }}
          turn={panelTurn}
          tab={tab}
          onTab={setTab}
          focusQuery={focusQuery}
          onFocusQuery={setFocusQuery}
          theme={theme}
          onClose={closeEvidence}
          onIndividual={toEntity}
          onSource={(ref) => openSource(panelMessage, ref)}
        />
      )}
      {ev.panel}
    </div>
  );
}
