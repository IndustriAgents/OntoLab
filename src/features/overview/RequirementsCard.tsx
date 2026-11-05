// Requirements first: user stories → competency questions (generated, then
// edited and approved by the user) → each approved question keeps its SPARQL.
// Approved questions steer ontology induction and are re-run on every commit;
// their pass rate is the project's headline quality number. Answerability is
// judged twice: can the ontology represent the answer (schema), and does the
// graph hold it yet (data).

import { Link } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import type { CompetencyQuestion, CqAnswerability, Requirements } from "../../types/project";
import { InlineError, StatusBadge } from "../../components/ui/ui";
import { requirementsHistory } from "../../lib/requirementsVersions";
import { RequirementsHistory } from "./RequirementsHistory";
import "./projectSettings.css";
import { IconPlus } from "../../components/icons";

const EXAMPLE = "As a procurement analyst I want to see every supplier's payment terms so that I can compare contracts.";

function requirementsOf(project: {
  competencyQuestions: string[];
  settings: { requirements?: Requirements; savedQueries?: { question: string; sparql: string }[] };
}): Requirements {
  if (project.settings.requirements) return project.settings.requirements;
  const saved = new Map((project.settings.savedQueries ?? []).map((q) => [q.question, q.sparql]));
  return {
    stories: [],
    cqs: project.competencyQuestions.map((text, i) => ({
      id: `legacy-${i}`,
      text,
      status: "approved",
      source: "user",
      ...(saved.get(text) ? { sparql: saved.get(text) } : {}),
    })),
  };
}

const newId = () => `cq_${Math.random().toString(36).slice(2, 12)}`;

const SCHEMA_TONE = { answerable: "ok", partial: "warn", unsupported: "alert" } as const;
const SCHEMA_TEXT = { answerable: "ontology can answer", partial: "ontology partly covers", unsupported: "ontology lacks terms" } as const;
const DATA_TEXT = { answered: "graph answers", empty: "no facts yet", error: "query error", untested: "not run" } as const;

function AnswerabilityBadges({ a }: { a: CqAnswerability }) {
  return (
    <>
      <StatusBadge tone={SCHEMA_TONE[a.schema]} title={a.path.length ? `Linked through: ${a.path.map(short).join(", ")}` : undefined}>
        {SCHEMA_TEXT[a.schema]}
      </StatusBadge>
      {a.schema !== "unsupported" && (
        <StatusBadge
          tone={a.data === "answered" ? "ok" : a.data === "error" ? "alert" : "muted"}
          title="From the latest validation of the current revision"
        >
          {DATA_TEXT[a.data]}
        </StatusBadge>
      )}
      {a.staleIris.length > 0 && (
        <StatusBadge tone="warn" title={`The stored query uses terms the ontology no longer has: ${a.staleIris.map(short).join(", ")}`}>
          stale query
        </StatusBadge>
      )}
    </>
  );
}

const short = (iri: string) => iri.replace(/^.*[#/]/, "");

export function RequirementsCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { pid, project, current } = useProject();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const initial = useMemo(() => (project ? requirementsOf(project) : { stories: [], cqs: [] }), [project]);
  const [stories, setStories] = useState<string[]>(initial.stories.length ? initial.stories : [""]);
  const [cqs, setCqs] = useState<CompetencyQuestion[]>(initial.cqs);
  const [draftCq, setDraftCq] = useState("");
  const savedRequirements = JSON.stringify(initial);
  useEffect(() => {
    setStories(initial.stories.length ? initial.stories : [""]);
    setCqs(initial.cqs);
    // Ignore saves in other settings sections, even if the project refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedRequirements]);

  const value: Requirements = { stories: stories.map((s) => s.trim()).filter(Boolean), cqs };
  const dirty = JSON.stringify(value) !== JSON.stringify({ stories: initial.stories, cqs: initial.cqs });
  useEffect(() => onDirtyChange?.(dirty || !!draftCq.trim()), [dirty, draftCq, onDirtyChange]);
  const onSaved = (p: NonNullable<typeof project>) => qc.setQueryData(qk.project(pid), p);

  const restore = useMutation({ mutationFn: (version: number) => api.restoreRequirements(pid, version), onSuccess: onSaved });
  const save = useMutation({ mutationFn: () => api.saveRequirements(pid, value), onSuccess: onSaved });
  const improve = useMutation({
    mutationFn: (request: { projectId: string; index: number; story: string; stories: string[]; provider: string; model: string }) =>
      api.suggestStory(request.projectId, {
        story: request.story,
        otherStories: request.stories.filter((_, i) => i !== request.index),
        provider: request.provider,
        model: request.model,
      }),
  });
  const suggestionCurrent = improve.variables?.projectId === pid && JSON.stringify(stories) === JSON.stringify(improve.variables.stories);
  const generate = useMutation({
    mutationFn: async () => {
      // keep unsaved edits: save first, then generate on top
      if (dirty) await api.saveRequirements(pid, value);
      return api.generateCqs(pid, { stories: value.stories, provider: choice.provider, model: choice.model });
    },
    onSuccess: onSaved,
  });
  const translate = useMutation({
    mutationFn: async (id: string) => {
      // the server must know the question (and its id) before it can store the query
      if (dirty || !project?.settings.requirements) await api.saveRequirements(pid, value);
      return api.translateCq(pid, id, { provider: choice.provider, model: choice.model });
    },
    onSuccess: (r) => onSaved(r.project),
  });

  const answerability = useMutation({
    mutationFn: async (refresh: boolean) => {
      if (dirty || !project?.settings.requirements) await api.saveRequirements(pid, value);
      return api.checkAnswerability(pid, { provider: choice.provider, model: choice.model, refresh });
    },
    onSuccess: onSaved,
  });
  const fromTbox = useMutation({
    mutationFn: async () => {
      if (dirty) await api.saveRequirements(pid, value);
      return api.generateCqsFromTBox(pid, { provider: choice.provider, model: choice.model });
    },
    onSuccess: onSaved,
  });
  const retranslate = useMutation({
    mutationFn: async () => {
      if (dirty) await api.saveRequirements(pid, value);
      return api.retranslateStale(pid, { provider: choice.provider, model: choice.model });
    },
    onSuccess: (r) => onSaved(r.project),
  });

  const setCq = (id: string, patch: Partial<CompetencyQuestion>) =>
    setCqs((list) =>
      list.map((q) =>
        q.id === id
          ? {
              ...q,
              ...patch,
              ...(patch.text !== undefined && patch.text !== q.text
                ? { sparql: undefined, terms: undefined, answerability: undefined, dupOf: undefined }
                : {}),
            }
          : q,
      ),
    );
  useEffect(() => {
    if (!dirty && !draftCq.trim()) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draftCq]);
  const versions = project ? requirementsHistory(project) : [];
  const approved = cqs.filter((q) => q.status === "approved");
  const proposed = cqs.filter((q) => q.status === "proposed");
  const byId = new Map(cqs.map((q) => [q.id, q]));
  const staleCount = cqs.filter((q) => q.answerability?.staleIris.length).length;
  // what the ontology lacks, grouped by the missing phrase across approved questions
  const gaps = new Map<string, string[]>();
  for (const q of approved) for (const m of q.answerability?.missing ?? []) gaps.set(m, [...(gaps.get(m) ?? []), q.text]);

  return (
    <section className="card span-2 requirements-card" aria-labelledby="ov-req" id="requirements">
      <div className="card-head">
        <h3 id="ov-req">Requirements{versions.length ? ` v${versions.at(-1)!.number}` : ""}</h3>
        <div className="requirements-counts">
          <StatusBadge tone={approved.length ? "ok" : "muted"}>{approved.length} approved</StatusBadge>
          {proposed.length > 0 && <StatusBadge tone="info">{proposed.length} to review</StatusBadge>}
        </div>
      </div>
      <p className="field-hint">
        Define the questions your knowledge graphs should answer. Describe who needs the answers, then add questions yourself or generate
        suggestions with AI. Approved questions guide ontology builds.
      </p>

      <RequirementsHistory
        versions={versions}
        current={value}
        disabled={
          dirty ||
          !!draftCq.trim() ||
          save.isPending ||
          restore.isPending ||
          generate.isPending ||
          translate.isPending ||
          answerability.isPending ||
          fromTbox.isPending ||
          retranslate.isPending
        }
        onRestore={(version) => restore.mutate(version)}
      />
      <InlineError error={restore.error} />
      <div className="requirements-grid">
        <fieldset className="fieldset requirements-step">
          <legend>
            <span className="requirements-step-number" aria-hidden="true">
              1
            </span>
            User stories
          </legend>
          <p className="requirements-step-hint">
            Describe who will use the graph and what they need to learn. Start with two to four stories.
          </p>
          {stories.map((s, i) => (
            <div className="story-row" key={i}>
              <div className="requirements-story-input">
                <label htmlFor={`story-${i}`}>User story {i + 1}</label>
                <div className="requirements-story-editor">
                  <textarea
                    id={`story-${i}`}
                    rows={4}
                    value={s}
                    placeholder={i === 0 ? EXAMPLE : "As a … I want … so that …"}
                    onChange={(e) => setStories((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <button
                    className="btn ghost sm requirements-ai-button"
                    type="button"
                    aria-label={`${s.trim() ? "Improve" : "Draft"} user story ${i + 1} with AI`}
                    disabled={!choice.providerEnabled || improve.isPending || save.isPending || generate.isPending}
                    title={choice.providerEnabled ? `Uses ${choice.model}` : "Configure a model in Settings to use AI."}
                    onClick={() =>
                      improve.mutate({
                        projectId: pid,
                        index: i,
                        story: s,
                        stories: [...stories],
                        provider: choice.provider,
                        model: choice.model,
                      })
                    }
                  >
                    {improve.isPending && improve.variables.index === i ? "Writing…" : s.trim() ? "Improve with AI" : "Draft with AI"}
                  </button>
                </div>
                {improve.variables?.projectId === pid && improve.variables.index === i && improve.data && (
                  <div className="requirements-suggestion" role="status" aria-label={`AI suggestion for user story ${i + 1}`}>
                    <strong>Suggested story</strong>
                    <p>{improve.data.story}</p>
                    {!suggestionCurrent && (
                      <p className="field-hint">Your stories changed. Generate a new suggestion before applying it.</p>
                    )}
                    <div className="row-actions">
                      <button
                        className="btn sm"
                        type="button"
                        disabled={!suggestionCurrent}
                        onClick={() => {
                          const request = improve.variables!;
                          const suggested = improve.data!.story;
                          setStories((current) =>
                            JSON.stringify(current) === JSON.stringify(request.stories)
                              ? current.map((text, index) => (index === request.index ? suggested : text))
                              : current,
                          );
                          improve.reset();
                        }}
                      >
                        Use suggestion
                      </button>
                      <button className="btn ghost sm" type="button" onClick={() => improve.reset()}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {stories.length > 1 && (
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={() => setStories((l) => l.filter((_, j) => j !== i))}
                  aria-label={`Remove story ${i + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <div className="row-actions">
            {stories.length < 12 && (
              <button className="btn ghost sm" type="button" onClick={() => setStories((l) => [...l, ""])}>
                <IconPlus /> Add a story
              </button>
            )}
            <button
              className="btn sm"
              type="button"
              disabled={!value.stories.length || !choice.providerEnabled || generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? "Generating…" : "Generate questions"}
            </button>
          </div>
          {!value.stories.length && <p className="field-hint">Add a user story to generate questions, or write your own question below.</p>}
          {!choice.providerEnabled && (
            <p className="field-hint">
              Connect a model to use AI suggestions. <Link to="/settings#providers">Open model connections →</Link>
            </p>
          )}
          <InlineError error={generate.error} />
          <InlineError error={improve.error} />
          <p className="requirements-ai-note">AI suggestions use project details and document excerpts. Review them before applying.</p>
        </fieldset>

        <fieldset className="fieldset requirements-step">
          <legend>
            <span className="requirements-step-number" aria-hidden="true">
              2
            </span>
            Questions to answer
          </legend>
          <p className="requirements-step-hint">
            These are the questions your graph must answer, also called competency questions. Approve the ones that matter to your project.
          </p>
          <div className="requirements-review-actions">
            <span>{proposed.length ? `${proposed.length} awaiting review` : "No questions awaiting review"}</span>
            <button
              className="btn ghost sm"
              type="button"
              disabled={!proposed.length}
              title="Approve all proposed questions. Rejected questions stay rejected."
              onClick={() => setCqs((list) => list.map((q) => (q.status === "proposed" ? { ...q, status: "approved" } : q)))}
            >
              Approve all
            </button>
          </div>
          {!cqs.length && (
            <div className="requirements-empty">
              <strong>No questions yet</strong>
              <p>Generate questions from your stories, or add one below.</p>
            </div>
          )}
          <ul className="cq-list">
            {cqs.map((q) => (
              <li key={q.id} className={`cq-row cq-${q.status}`}>
                <textarea
                  rows={2}
                  aria-label="Competency question"
                  value={q.text}
                  onChange={(e) => setCq(q.id, { text: e.target.value })}
                />
                <span className="cq-meta">
                  <StatusBadge tone={q.status === "approved" ? "ok" : q.status === "rejected" ? "muted" : "info"}>{q.status}</StatusBadge>
                  {q.source !== "user" && <span className="muted">{q.source === "tbox" ? "from ontology" : q.source}</span>}
                  {q.answerability && q.status !== "rejected" && <AnswerabilityBadges a={q.answerability} />}
                  {q.dupOf && byId.has(q.dupOf) && (
                    <StatusBadge tone="warn" title={`Asks the same as: ${byId.get(q.dupOf)!.text}`}>
                      duplicate
                    </StatusBadge>
                  )}
                </span>
                <span className="cq-actions">
                  {q.status !== "approved" && (
                    <button className="btn ghost sm" type="button" onClick={() => setCq(q.id, { status: "approved" })}>
                      Approve
                    </button>
                  )}
                  {q.status !== "rejected" && (
                    <button className="btn ghost sm" type="button" onClick={() => setCq(q.id, { status: "rejected" })}>
                      Reject
                    </button>
                  )}
                  <button
                    className="btn ghost sm"
                    type="button"
                    onClick={() => setCqs((l) => l.filter((x) => x.id !== q.id))}
                    aria-label="Delete question"
                  >
                    Delete
                  </button>
                </span>
                {(q.sparql || (q.status === "approved" && current)) && (
                  <details className="cq-sparql">
                    <summary>Advanced · SPARQL query</summary>
                    <p>Save a query to check this question against saved graph versions.</p>
                    {q.status === "approved" && current && (
                      <button
                        className="btn ghost sm"
                        type="button"
                        disabled={translate.isPending || !choice.providerEnabled}
                        onClick={() => translate.mutate(q.id)}
                        title="Write the SPARQL query once; validation re-runs it on every commit"
                      >
                        {translate.isPending && translate.variables === q.id ? "Translating…" : q.sparql ? "Re-translate" : "To SPARQL"}
                      </button>
                    )}
                    {!choice.providerEnabled && (
                      <p>
                        Connect a model to translate questions. <Link to="/settings#providers">Open model connections →</Link>
                      </p>
                    )}
                    {q.sparql && <pre className="code-block">{q.sparql}</pre>}
                  </details>
                )}
              </li>
            ))}
          </ul>
          <form
            className="requirements-add-question"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draftCq.trim()) return;
              setCqs((l) => [...l, { id: newId(), text: draftCq.trim(), status: "approved", source: "user" }]);
              setDraftCq("");
            }}
          >
            <label htmlFor="cq-new">Add your own question</label>
            <textarea
              rows={2}
              id="cq-new"
              value={draftCq}
              onChange={(e) => setDraftCq(e.target.value)}
              placeholder="What should the knowledge graph be able to answer?"
            />
            <button className="btn ghost sm" type="submit" disabled={!draftCq.trim()}>
              Add question
            </button>
          </form>
          <InlineError error={translate.error} />
          {current && (
            <div className="row-actions">
              <button
                className="btn ghost sm"
                type="button"
                disabled={!cqs.length || answerability.isPending}
                onClick={() => answerability.mutate(true)}
                title="Map each question to ontology terms and check the terms are linked. Uses the selected model when one is available, otherwise matches by name."
              >
                {answerability.isPending ? "Checking…" : "Check answerability"}
              </button>
              <button
                className="btn ghost sm"
                type="button"
                disabled={!choice.providerEnabled || fromTbox.isPending}
                onClick={() => fromTbox.mutate()}
                title="Questions the current ontology can already answer, for review"
              >
                {fromTbox.isPending ? "Generating…" : "Generate from ontology"}
              </button>
              {staleCount > 0 && (
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={retranslate.isPending}
                  onClick={() => retranslate.mutate()}
                  title="Rewrite renamed terms, and re-translate queries that still use removed ones"
                >
                  {retranslate.isPending ? "Updating…" : `Update ${staleCount} stale quer${staleCount === 1 ? "y" : "ies"}`}
                </button>
              )}
            </div>
          )}
          <InlineError error={answerability.error ?? fromTbox.error ?? retranslate.error} />
          {gaps.size > 0 && (
            <div className="cq-gaps">
              <div className="sec-label">The ontology has no term for</div>
              <ul>
                {[...gaps.entries()].map(([term, qs]) => (
                  <li key={term}>
                    <strong>{term}</strong>{" "}
                    <span className="muted">
                      — needed by {qs.length} question{qs.length === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="field-hint">The next ontology build is asked to add these. You can also add them by hand under Ontology.</p>
            </div>
          )}
        </fieldset>
      </div>

      <InlineError error={save.error} />
      <div className="requirements-footer">
        <p className="field-hint">Approved questions guide ontology generation and are checked on every commit.</p>
        <div className="row-actions">
          <span className="muted" role="status">
            {save.isPending
              ? "Saving…"
              : dirty || draftCq.trim()
                ? "Unsaved changes"
                : save.isSuccess
                  ? "Requirements saved"
                  : "All changes saved"}
          </span>
          {(dirty || !!draftCq.trim()) && (
            <button
              className="btn ghost"
              disabled={save.isPending}
              onClick={() => {
                setStories(initial.stories.length ? initial.stories : [""]);
                setCqs(initial.cqs);
                setDraftCq("");
                improve.reset();
                save.reset();
              }}
            >
              Discard changes
            </button>
          )}
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save requirements"}
          </button>
        </div>
      </div>
    </section>
  );
}
