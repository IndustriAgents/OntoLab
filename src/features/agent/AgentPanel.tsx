import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { InlineError } from "../../components/ui/ui";
import { IconClose, IconSpark, IconPlus, IconArrowRight, IconChevronsUpDown } from "../../components/icons";
import { chatWithAgent, runAction, actionRequestId } from "../../lib/actionsApi";
import { request } from "../../lib/http";
import type { ActionResult, Capability, AgentActivity } from "../../types/actions";
import type { RunView } from "../../types/project";
import { Markdown } from "../assistant/Markdown";
import { ActionCard } from "./ActionCard";
import "./agent.css";

interface Message {
  role: "user" | "assistant";
  content: string;
  results?: ActionResult[];
}
export function AgentPanel({ onClose, resizeHandle }: { onClose: () => void; resizeHandle: ReactNode }) {
  const { pid, project, selectedId, revisions, working } = useProject();
  const choice = useModelChoice();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  const flushing = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const modelMenu = useRef<HTMLDetailsElement>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const selectedRevision = useRef(selectedId);
  selectedRevision.current = selectedId;
  const key = `ontolab-ai:${pid}:conversation`;
  const context = useQuery({
    queryKey: ["agent-context", pid, selectedId],
    queryFn: async () =>
      (await runAction("get_project_context", { projectId: pid, ...(selectedId ? { revisionId: selectedId } : {}) })).data as {
        runs: RunView[];
        activities: AgentActivity[];
        capabilities: Capability[];
        workPackages: { id: string; chunks: number; covered: number; resultRevisionId?: string }[];
      },
    refetchInterval: 5000,
  });
  useEffect(() => {
    composer.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (modelMenu.current?.open) {
        modelMenu.current.open = false;
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      controller.current?.abort();
    };
  }, [onClose]);
  useEffect(() => {
    if (flushing.current) return;
    controller.current?.abort();
    setBusy(false);
    setError(undefined);
    const id =
      (sessionStorage.getItem(key) ?? sessionStorage.getItem(`ontolab-ai:${pid}:${selectedRevision.current ?? "current"}`)) || undefined;
    if (id) sessionStorage.setItem(key, id);
    setThreadId(id);
    setMessages([]);
    if (id) {
      const c = new AbortController();
      void request<{ messages: Message[] }>("GET", `api/projects/${pid}/agent/conversations/${id}`, { signal: c.signal })
        .then((saved) => setMessages(saved.messages))
        .catch(() => {});
      return () => c.abort();
    }
  }, [key, pid]);
  useEffect(() => {
    if ((messages.length || busy) && followMessages.current) threadEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);
  useEffect(() => {
    const closeModelMenu = (event: PointerEvent) => {
      if (modelMenu.current?.open && event.target instanceof Node && !modelMenu.current.contains(event.target))
        modelMenu.current.open = false;
    };
    document.addEventListener("pointerdown", closeModelMenu);
    return () => document.removeEventListener("pointerdown", closeModelMenu);
  }, []);
  const revision = revisions.find((r) => r.id === selectedId);
  const selectedModel = choice.model || "Choose a model";
  const supportsEffort = choice.provider === "codex-cli" && !!choice.selected?.reasoningEfforts?.[choice.model]?.length;
  const effortLabel =
    choice.reasoningEffort === "default"
      ? "Default"
      : ({ xhigh: "Extra high" }[choice.reasoningEffort] ??
        choice.reasoningEffort.charAt(0).toUpperCase() + choice.reasoningEffort.slice(1));
  function newConversation() {
    setMessages([]);
    setThreadId(undefined);
    setError(undefined);
    sessionStorage.setItem(key, "");
    composer.current?.focus();
  }
  async function send(value: string) {
    if (!value.trim() || busy || choice.status !== "ready") return;
    followMessages.current = true;
    setError(undefined);
    setBusy(true);
    setText("");
    const c = new AbortController();
    controller.current = c;
    try {
      flushing.current = true;
      const savedId = await working.flush();
      flushing.current = false;
      if (["error", "conflict"].includes(working.save) || (working.save === "saving" && !savedId))
        throw new Error("Save or resolve your editor changes before starting AI work.");
      setMessages((old) => [...old, { role: "user", content: value }]);
      const reply = await chatWithAgent(
        pid,
        {
          message: value,
          revisionId: savedId ?? selectedId ?? undefined,
          threadId,
          provider: choice.provider,
          model: choice.model,
          ...(supportsEffort && choice.reasoningEffort !== "default" ? { reasoningEffort: choice.reasoningEffort } : {}),
        },
        c.signal,
      );
      if (c.signal.aborted) return;
      setThreadId(reply.threadId);
      sessionStorage.setItem(key, reply.threadId);
      setMessages((old) => [...old, { role: "assistant", content: reply.message, results: reply.results }]);
      await qc.invalidateQueries({ predicate: (query) => query.queryKey.includes(pid) });
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e);
        setText(value);
      }
    } finally {
      flushing.current = false;
      if (controller.current === c) setBusy(false);
    }
  }
  const tasks = context.data?.runs.filter((r) => !["ready_for_review", "cancelled"].includes(r.status)) ?? [];
  const suggestions = project?.settings.externalGraph
    ? [
        { label: "Understand the schema", hint: "See how this graph is organized", prompt: "Explain the schema of this connected graph" },
        { label: "Find useful questions", hint: "Discover what you can ask", prompt: "What can I ask about this graph?" },
      ]
    : project?.settings.corpus
      ? [
          { label: "Explore this graph", hint: "Find the next useful step", prompt: "Inspect this graph and suggest the next step" },
          {
            label: "Extract from sources",
            hint: "Prepare your documents for extraction",
            prompt: "Prepare an extraction work package from my documents",
          },
          { label: "Review the evidence", hint: "Understand facts that need attention", prompt: "Explain facts that need review" },
        ]
      : [
          {
            label: "Define requirements",
            hint: "Decide what your ontology should answer",
            prompt: "Help me define the questions this ontology should answer",
          },
          {
            label: "Draft from sources",
            hint: "Turn your documents into a proposal",
            prompt: "Inspect my sources and propose an ontology draft",
          },
          {
            label: "Check the ontology",
            hint: "Understand validation findings",
            prompt: "Validate the selected ontology and explain the findings",
          },
        ];
  return (
    <aside id="ontolab-ai-panel" className="agent-panel" aria-label="OntoLab AI">
      {resizeHandle}
      <header className="agent-panel-head">
        <div className="agent-title">
          <span className="agent-mark">
            <IconSpark />
          </span>
          <strong>OntoLab AI</strong>
        </div>
        <div className="agent-header-actions">
          <button
            className="icon-btn"
            aria-label="New conversation"
            title="New conversation"
            disabled={busy || !messages.length}
            onClick={newConversation}
          >
            <IconPlus />
          </button>
          <button className="icon-btn" aria-label="Close OntoLab AI" title="Close panel" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>
      <div className="agent-scope">
        <div className="agent-project">
          <span className="agent-context-dot" />
          <strong>{project?.name}</strong>
        </div>
        <span className="agent-version">
          {project?.settings.externalGraph
            ? "Connected graph · read only"
            : revision
              ? revision.status === "draft"
                ? "Selected draft"
                : `${project?.settings.corpus ? "Graph" : "Ontology"} version ${revision.number}`
              : "New ontology workspace"}
        </span>
        <small>Changes stay in drafts until you review them.</small>
      </div>
      <div
        className="agent-content"
        aria-live="polite"
        aria-busy={busy}
        onScroll={(event) => {
          const element = event.currentTarget;
          followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!messages.length && (
          <div className="agent-welcome">
            <span className="agent-welcome-mark">
              <IconSpark />
            </span>
            <h2>What would you like to build?</h2>
            <p>Work with your sources, refine your ontology, or explore your graph.</p>
            <div className="agent-suggestions">
              {suggestions.map((s) => (
                <button key={s.label} disabled={busy || choice.status !== "ready"} onClick={() => void send(s.prompt)}>
                  <span>
                    <strong>{s.label}</strong>
                    <small>{s.hint}</small>
                  </span>
                  <IconArrowRight />
                </button>
              ))}
            </div>
          </div>
        )}
        {tasks.length > 0 && (
          <details className="agent-tasks" open>
            <summary>Activities needing attention ({tasks.length})</summary>
            {tasks.map((run) => (
              <RunCard key={run.id} projectId={run.projectId} run={run} />
            ))}
          </details>
        )}
        {(context.data?.workPackages ?? [])
          .filter((work) => !work.resultRevisionId)
          .map((work) => (
            <article className="agent-result" key={work.id}>
              <strong>Fact authoring in progress</strong>
              <p>
                {work.covered} / {work.chunks} source chunks submitted. Saved batches can be continued here or by your connected assistant.
              </p>
              <button
                className="btn ghost sm"
                disabled={busy || choice.status !== "ready"}
                onClick={() =>
                  void send(
                    `Continue work package ${work.id}. Read its saved coverage and source chunks, process only outstanding chunks, then prepare a review draft.`,
                  )
                }
              >
                Continue work package
              </button>
            </article>
          ))}
        {revisions.some((r) => r.status === "draft") && (
          <details className="agent-tasks">
            <summary>Drafts ready to review</summary>
            {revisions
              .filter((r) => r.status === "draft")
              .map((r) => (
                <ActionCard
                  key={r.id}
                  result={{
                    summary: r.summary,
                    data: null,
                    destination: `/p/${pid}/${project?.settings.corpus ? "graph?tab=updates" : "ontology?tab=review"}&rev=${r.id}`,
                  }}
                />
              ))}
          </details>
        )}
        {!!context.data?.activities.length && (
          <details className="agent-tasks">
            <summary>Recent assistant activity</summary>
            {context.data.activities.slice(0, 5).map((a) => (
              <div key={a.id}>
                <small>{a.caller ?? "This workspace"}</small>
                <ActionCard result={{ summary: a.summary, data: null, destination: a.destination }} />
              </div>
            ))}
          </details>
        )}
        {messages.map((m, index) => (
          <div className={`agent-message agent-message-${m.role}`} key={index}>
            <div className="agent-message-author">
              {m.role === "assistant" && <IconSpark />}
              <span>{m.role === "user" ? "You" : "OntoLab AI"}</span>
            </div>
            <Markdown text={m.content} />
            {m.results?.map((r, i) => (
              <ActionCard key={i} result={r} />
            ))}
          </div>
        ))}
        {busy && (
          <div className="agent-thinking" role="status">
            <span />
            <span />
            <span />
            <small>Working on it…</small>
          </div>
        )}
        <InlineError error={error} />
        <div ref={threadEnd} />
      </div>
      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <div className="agent-input-box">
          <label className="sr-only" htmlFor="agent-message">
            Ask OntoLab AI
          </label>
          <textarea
            ref={composer}
            id="agent-message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            placeholder="Ask a question or describe a change…"
            rows={3}
            maxLength={10000}
            disabled={busy}
          />
          <div className="agent-input-toolbar">
            <details ref={modelMenu} className="agent-model-menu">
              <summary title={`Model: ${selectedModel}`}>
                <span>{selectedModel}</span>
                {supportsEffort && <span className="agent-effort-badge">{effortLabel}</span>}
                <IconChevronsUpDown />
              </summary>
              <div className="agent-model-options">
                <strong>Model settings</strong>
                <p>Choose a model and how much effort it uses.</p>
                <ProviderModelSelect
                  {...selectProps(choice)}
                  reasoningEffort={choice.reasoningEffort}
                  onReasoningEffort={choice.setReasoningEffort}
                  showProviderHint={false}
                  disabled={busy}
                />
                <div className="agent-model-note">
                  {choice.selected?.kind === "cli" ? "Uses your CLI account quota." : "Uses your configured provider."}
                  {supportsEffort && " Higher effort may take longer."}
                </div>
              </div>
            </details>
            <button
              className="agent-send"
              aria-label="Send"
              title="Send message"
              disabled={busy || !text.trim() || choice.status !== "ready"}
            >
              <IconArrowRight />
            </button>
          </div>
        </div>
        <div className="agent-composer-foot">
          <small>Enter to send · Shift + Enter for a new line</small>
          <Link to="/settings?section=ai-connections" title="Connect an external assistant">
            Connect an assistant
          </Link>
        </div>
      </form>
    </aside>
  );
}
function RunCard({ projectId, run }: { projectId: string; run: RunView }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function act(control?: string) {
    setBusy(true);
    setError(undefined);
    try {
      await runAction(control ? "control_run" : "answer_run_questions", {
        projectId,
        runId: run.id,
        requestId: actionRequestId(),
        ...(control ? { control } : { answers, finish: false }),
      });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(projectId) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="agent-result">
      <strong>{run.kind === "induction" ? "Ontology build" : run.kind === "alignment" ? "Alignment" : "Graph extraction"}</strong>
      <p>
        {run.status.replaceAll("_", " ")} · {run.completedSteps} / {run.steps.length} steps saved
      </p>
      {run.error && <p>{run.error}</p>}
      {run.status === "awaiting_answers" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act();
          }}
        >
          {run.questions.map((q) => (
            <label key={q.id}>
              {q.text}
              <input value={answers[q.id] ?? ""} onChange={(e) => setAnswers((old) => ({ ...old, [q.id]: e.target.value }))} />
            </label>
          ))}
          <button className="btn sm" disabled={busy || !Object.values(answers).some((a) => a.trim())}>
            Continue with answers
          </button>
        </form>
      )}
      {(["paused", "failed"].includes(run.status) || ["running", "queued"].includes(run.status)) && (
        <button
          className="btn ghost sm"
          disabled={busy}
          onClick={() => void act(["paused", "failed"].includes(run.status) ? "resume" : "pause")}
        >
          {["paused", "failed"].includes(run.status) ? "Resume" : "Pause"}
        </button>
      )}
      <Link className="btn ghost sm" to={`/p/${projectId}/${run.corpus ? `graph?tab=updates&run=${run.id}` : `runs/${run.id}`}`}>
        View activity
      </Link>
      <InlineError error={error} />
    </article>
  );
}
