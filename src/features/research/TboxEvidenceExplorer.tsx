import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import {
  buildTboxEvidence,
  evidenceFiles,
  questionMatches,
  type Citation,
  type EvidenceQuestion,
  type EvidenceTerm,
} from "../../lib/tboxEvidence";
import { ErrorState, InlineError, LoadingState, Modal, StatusBadge, fmtDate } from "../../components/ui/ui";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { RunInspector } from "./RunInspector";
import { ResultTable } from "./ResearchResults";
import { TboxTopicExplorer } from "./TboxTopicExplorer";
import "./tbox-evidence.css";

const EvidenceGraph = lazy(() => import("./TboxEvidenceGraph").then((m) => ({ default: m.TboxEvidenceGraph })));
type View = "terms" | "topics" | "questions" | "graph";
type Data = ReturnType<typeof buildTboxEvidence>;
const kindName = (kind: EvidenceTerm["kind"]) => (kind === "class" ? "Class" : kind === "object" ? "Relationship" : "Attribute");

function TermButtons({ terms, selected, onSelect }: { terms: EvidenceTerm[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <div className="ee-term-buttons">
      {terms.map((term) => (
        <button type="button" key={term.id} aria-pressed={term.id === selected} onClick={() => onSelect(term.id)}>
          <span>{term.label}</span>
          <small>{kindName(term.kind)}</small>
          {!!term.origins.length && !term.citations.some((c) => c.located && c.chunkId) && (
            <small className="ee-missing-source">Source link unavailable</small>
          )}
        </button>
      ))}
    </div>
  );
}

function QuestionContext({
  question,
  data,
  onTerm,
  validation,
}: {
  question: EvidenceQuestion;
  data: Data;
  onTerm: (id: string) => void;
  validation: Awaited<ReturnType<typeof api.report>> | undefined;
}) {
  const matches = questionMatches(question, data.terms).slice(0, 12);
  const result = validation && !validation.stale ? validation.cqResults.find((q) => q.question === question.text) : undefined;
  return (
    <>
      <div className="ee-section-title">
        <h3>Question coverage</h3>
        <StatusBadge tone={question.usedAsGuidance ? "ok" : "muted"}>{question.status}</StatusBadge>
      </div>
      <p className="ee-question-text">{question.text}</p>
      <dl className="ee-facts">
        <div>
          <dt>Build guidance</dt>
          <dd>{question.usedAsGuidance ? "Included in recorded prompts" : "Not recorded in build prompts"}</dd>
        </div>
        <div>
          <dt>Query generated</dt>
          <dd>{question.sparql || result?.sparql ? "Yes" : "Not recorded"}</dd>
        </div>
        <div>
          <dt>Query executed</dt>
          <dd>
            {result
              ? result.error
                ? "Query failed"
                : `${result.rows.length} result rows`
              : validation?.stale
                ? "Validation is out of date"
                : "Not recorded for this result"}
          </dd>
        </div>
        <div>
          <dt>Results reviewed</dt>
          <dd>No review recorded</dd>
        </div>
      </dl>
      {!question.usedAsGuidance && (
        <p className="ee-note">
          {question.status === "proposed"
            ? "This question was proposed but was not approved as guidance for this build."
            : "This question is not recorded as guidance in the completed generation calls."}
        </p>
      )}
      <h4>Suggested relevant terms</h4>
      <p className="ee-note">
        Suggestions match words in term names and definitions. They do not establish that the ontology answers this question.
      </p>
      {matches.length ? (
        <div className="ee-match-list">
          {matches.map(({ term, matches: words }) => (
            <button type="button" key={term.id} onClick={() => onTerm(term.id)}>
              <strong>{term.label}</strong>
              <small>Word overlap: {words.join(", ")}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="ee-empty">No matching terms found in the recorded result. Review the question and the ontology together.</p>
      )}
      {!!question.answerability?.missing.length && (
        <div className="banner warn">Missing terms recorded before this build: {question.answerability.missing.join(", ")}</div>
      )}
      {result && (
        <details className="ee-details">
          <summary>Recorded query and results</summary>
          <pre>{result.sparql}</pre>
          {result.error ? (
            <p role="alert">{result.error}</p>
          ) : (
            <ResultTable label="Query results" rows={result.rows} columns={result.columns} />
          )}
        </details>
      )}
    </>
  );
}

function TermDetails({
  term,
  data,
  onTopic,
  onCall,
  onPassage,
  onQuestion,
}: {
  term: EvidenceTerm;
  data: Data;
  onTopic: (id: string, chunkId?: string) => void;
  onCall: (id: string) => void;
  onPassage: (chunkId: string, citation?: Citation) => void;
  onQuestion: (id: string) => void;
}) {
  const related = data.questions.filter((q) => questionMatches(q, [term]).length).slice(0, 5);
  const cited = term.citations.filter((c) => c.quote);
  const files = evidenceFiles(data);
  const topics = data.topics.filter((t) => term.origins.some((o) => t.callIds.includes(o.callId)));
  return (
    <>
      <div className="ee-section-title">
        <span className="ee-eyebrow">{kindName(term.kind)}</span>
        <StatusBadge tone={term.inResult ? "ok" : "info"}>{term.inResult ? "In result" : "Candidate"}</StatusBadge>
      </div>
      <h3 className="ee-term-title">{term.label}</h3>
      <p>{term.definition || "No definition recorded for this term."}</p>
      {term.kind !== "class" && (
        <div className="ee-relationship">
          <span>{term.domain.join(" / ") || "Domain not recorded"}</span>
          <strong>→ {term.label} →</strong>
          <span>{term.range.join(" / ") || "Range not recorded"}</span>
        </div>
      )}
      {!!term.parents.length && <p className="ee-note">Parent classes: {term.parents.join(", ")}</p>}
      <section className="ee-section">
        <h4>
          Source quotes <span>{cited.length}</span>
        </h4>
        <p className="ee-note">
          These quotes were cited by the model. Finding a quote confirms its location; support still needs human review.
        </p>
        {cited.length ? (
          cited.map((citation, i) => {
            const chunk = data.chunks.get(citation.chunkId ?? "");
            const file = files.find((f) => f.id === citation.documentId);
            const call = data.calls.find((c) => c.id === citation.callId);
            const topic = data.topics.find((t) => t.id === call?.topicId);
            return (
              <article className="ee-citation" key={`${citation.callId}-${i}`}>
                <div className="ee-section-title">
                  <StatusBadge tone={citation.chunkId ? "info" : "warn"}>
                    {citation.chunkId ? "Quote found in saved input" : "Quote location unverified"}
                  </StatusBadge>
                  <small>{topic?.label}</small>
                </div>
                <blockquote>{citation.quote}</blockquote>
                <p className="ee-source-name" title={file?.name}>
                  {file?.label ?? "Source unavailable"}
                  {chunk ? ` · Chunk ${chunk.ordinal + 1}${chunk.page ? ` · page ${chunk.page}` : ""}` : ""}
                </p>
                {citation.chunkId && (
                  <div className="ee-quote-actions">
                    <button className="btn ghost sm" type="button" onClick={() => onPassage(citation.chunkId!, citation)}>
                      Open passage in context
                    </button>
                    {topic && (
                      <button className="ee-text-button" type="button" onClick={() => onTopic(topic.id, citation.chunkId)}>
                        Show chunk in topic
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="ee-empty">No source quote was recorded. You can still inspect the topic and generation steps below.</p>
        )}
      </section>
      <section className="ee-section">
        <h4>Topics behind this term</h4>
        {topics.length ? (
          topics.map((topic) => {
            const origins = term.origins.filter((o) => topic.callIds.includes(o.callId));
            const merged = [...new Set(origins.map((o) => o.candidate).filter((name) => name !== term.name))];
            return (
              <div className="ee-origin" key={topic.id}>
                <button className="ee-text-button" type="button" onClick={() => onTopic(topic.id)}>
                  {topic.label}
                </button>
                <p>
                  {topic.chunkIds.length} chunks · {origins.length} generation step{origins.length === 1 ? "" : "s"}
                </p>
                {!!merged.length && (
                  <p>
                    Merged from: <strong>{merged.join(", ")}</strong>
                  </p>
                )}
                <details className="ee-details">
                  <summary>Candidate definitions & generation steps</summary>
                  {origins.map((origin, i) => (
                    <div className="ee-candidate-origin" key={`${origin.callId}-${i}`}>
                      <strong>{origin.candidate}</strong>
                      {origin.definition && <p>{origin.definition}</p>}
                      <button className="btn ghost sm" type="button" onClick={() => onCall(origin.callId)}>
                        Inspect generation call
                      </button>
                    </div>
                  ))}
                </details>
              </div>
            );
          })
        ) : (
          <p className="ee-empty">No generation origin was recorded. This term may come from the starting ontology or a later edit.</p>
        )}
      </section>
      <details className="ee-section ee-details">
        <summary>Related questions ({related.length})</summary>
        {related.length ? (
          related.map((q) => (
            <button className="ee-question-link" type="button" key={q.id} onClick={() => onQuestion(q.id)}>
              {q.text}
              <small>Suggested relevance · word overlap</small>
            </button>
          ))
        ) : (
          <p>No question matches by name or definition. This is not a complete assessment of relevance.</p>
        )}
      </details>
      {term.uri && (
        <details className="ee-details">
          <summary>Term identifier</summary>
          <code>{term.uri}</code>
        </details>
      )}
    </>
  );
}

export function TboxEvidenceExplorer({ pid, runId }: { pid: string; runId: string }) {
  const viewer = useEvidenceViewer(pid);
  const report = useQuery({
    queryKey: ["run-research", pid, runId],
    queryFn: () => api.runResearch(pid, runId),
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.run.status) ? 5000 : false),
  });
  const revisionId = report.data?.run.resultRevisionId;
  const revision = useQuery({
    queryKey: qk.revision(pid, revisionId ?? "none"),
    queryFn: () => api.getRevision(pid, revisionId!),
    enabled: !!revisionId,
  });
  const validation = useQuery({
    queryKey: qk.report(pid, revisionId ?? "none"),
    queryFn: () => api.report(pid, revisionId!),
    enabled: !!revisionId,
  });
  const data = useMemo(() => (report.data ? buildTboxEvidence(report.data, revision.data) : undefined), [report.data, revision.data]);
  const [view, setView] = useState<View>("topics");
  const [search, setSearch] = useState<Record<View, string>>({ terms: "", topics: "", questions: "", graph: "" });
  const [kind, setKind] = useState("all");
  const [missingSources, setMissingSources] = useState(false);
  const [termId, setTermId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [chunkId, setChunkId] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [technicalStep, setTechnicalStep] = useState("");
  const [narrow, setNarrow] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const technicalRef = useRef<HTMLDetailsElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolls = useRef<Record<View, number>>({ terms: 0, topics: 0, questions: 0, graph: 0 });
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (drawer && (narrow || view !== "terms")) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [drawer, narrow, view]);
  useEffect(() => {
    if (technical && technicalStep) technicalRef.current?.scrollIntoView({ block: "start" });
  }, [technical, technicalStep]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = scrolls.current[view];
  }, [view]);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  if (report.isLoading) return <LoadingState label="Loading build evidence…" />;
  if (report.error || !report.data || !data) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const files = evidenceFiles(data);
  const allTerms = [...data.terms].sort((a, b) => Number(b.inResult) - Number(a.inResult) || a.label.localeCompare(b.label));
  const filteredTerms = allTerms.filter(
    (t) =>
      (kind === "all" || (kind === "property" ? t.kind !== "class" : t.kind === kind)) &&
      (!missingSources || !t.citations.some((c) => c.located && c.chunkId)) &&
      `${t.name} ${t.label} ${t.definition}`.toLowerCase().includes(search.terms.toLowerCase()),
  );
  const questions = data.questions.filter((q) => q.text.toLowerCase().includes(search.questions.toLowerCase()));
  const question = questions.find((q) => q.id === questionId) ?? questions[0];
  const selectedTerm =
    view === "terms" ? (filteredTerms.find((t) => t.id === termId) ?? filteredTerms[0]) : allTerms.find((t) => t.id === termId);
  const term =
    view === "questions" && question
      ? questionMatches(question, data.terms).find((r) => r.term.id === selectedTerm?.id)?.term
      : selectedTerm;
  const selectTerm = (id: string) => {
    setTermId(id);
    if (narrow || view !== "terms") setDrawer(true);
  };
  const selectTopic = (id: string, sourceChunk?: string) => {
    setView("topics");
    setTopicId(id);
    setChunkId(sourceChunk ?? "");
    setDrawer(false);
    setSearch((s) => ({ ...s, topics: "" }));
  };
  const selectQuestion = (id: string) => {
    setView("questions");
    setQuestionId(id);
    setDrawer(false);
    setSearch((s) => ({ ...s, questions: "" }));
  };
  const inspectCall = (id: string) => {
    setTechnicalStep(id);
    setTechnical(true);
    setDrawer(false);
  };
  const termDetails = (value: EvidenceTerm) => (
    <TermDetails
      term={value}
      data={data}
      onTopic={selectTopic}
      onCall={inspectCall}
      onQuestion={selectQuestion}
      onPassage={(_id, citation) => {
        viewer.openTarget(
          { kind: "term", runId, revisionId, termId: value.id },
          Math.max(
            0,
            value.citations.findIndex((c) => c === citation),
          ),
        );
        setDrawer(false);
      }}
    />
  );
  const inspectSource = (id: string, citation?: Citation, callId?: string) => {
    const chunk = data.chunks.get(id);
    const recorded = data.calls.flatMap((c) => c.passages ?? []).find((p) => p.chunkId === id);
    const documentId = chunk?.documentId ?? recorded?.documentId;
    if (!documentId) return;
    if (citation)
      viewer.openTarget({
        kind: "reference",
        runId,
        documentId,
        chunkId: id,
        quote: citation.quote,
        start: citation.start,
        end: citation.end,
        stepKey: citation.callId,
      });
    else viewer.openTarget({ kind: "passage", runId, documentId, chunkId: id, stepKey: callId });
    setDrawer(false);
  };
  const displayedTerms = revision.data ? data.terms.filter((t) => t.inResult) : data.terms;
  const classes = displayedTerms.filter((t) => t.kind === "class").length;
  const properties = displayedTerms.filter((t) => t.kind !== "class").length;
  const chunkCount = new Set(data.topics.flatMap((t) => t.chunkIds)).size || data.chunks.size;
  const savedCalls = data.calls.filter((c) => c.completed).length;
  return (
    <div className="ee-root">
      <header className="ee-header">
        <div>
          <span className="ee-eyebrow">Build evidence</span>
          <h2 ref={headingRef}>Explore topics and their sources</h2>
          <p>Choose a topic, read its chunks, then inspect the classes and properties it helped generate.</p>
        </div>
        <div className="ee-header-actions">
          {revision.data && (
            <StatusBadge tone={revision.data.status === "committed" ? "ok" : "info"}>
              {revision.data.status === "committed" ? `Version ${revision.data.number} saved` : "Draft ready for review"}
            </StatusBadge>
          )}
          {revisionId && (
            <Link className="btn ghost sm" to={`/p/${pid}/workflows/tbox?start=previous&step=review&rev=${revisionId}&from=${runId}`}>
              Review & edit ontology
            </Link>
          )}
          <button className="btn ghost sm" type="button" onClick={() => setFilesOpen(true)}>
            Source files ({files.length})
          </button>
        </div>
      </header>
      <div className="ee-journey" aria-label="Build overview">
        <button type="button" onClick={() => setView("topics")}>
          <span className="ee-journey-number">1</span>
          <span>
            <strong>{data.topics.length} topic groups</strong>
            <small>Choose a group of related chunks</small>
          </span>
        </button>
        <span className="ee-journey-arrow" aria-hidden="true">
          →
        </span>
        <button type="button" onClick={() => setView("topics")}>
          <span className="ee-journey-number">2</span>
          <span>
            <strong>{chunkCount} source chunks</strong>
            <small>
              From {files.length} recorded file{files.length === 1 ? "" : "s"}
            </small>
          </span>
        </button>
        <span className="ee-journey-arrow" aria-hidden="true">
          →
        </span>
        <button type="button" onClick={() => setView("terms")} disabled={!data.terms.length}>
          <span className="ee-journey-number">3</span>
          <span>
            <strong>Classes & properties</strong>
            <small>{data.terms.length ? `${classes} classes · ${properties} properties` : "Appear as generation steps finish"}</small>
          </span>
        </button>
      </div>
      {!savedCalls && !data.terms.length && (
        <div className="ee-generation-note">
          <strong>Topics and chunks are ready to explore</strong>
          <p>No classes or properties have been recorded yet. They will appear beside the chunks as generation steps finish.</p>
        </div>
      )}
      <div className="ee-toolbar">
        <div className="research-tabs" role="group" aria-label="Explore build evidence">
          {(
            [
              ["topics", "Topic groups"],
              ["graph", "Graph"],
              ["terms", "Terms"],
              ["questions", "Questions"],
            ] as const
          ).map(([id, title]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => {
                setView(id);
                setDrawer(false);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        <span className="ee-note">
          {savedCalls} / {data.calls.length} generation steps saved · Recorded{" "}
          {fmtDate(report.data.inputs?.recordedAt ?? report.data.run.createdAt)}
        </span>
      </div>
      {!report.data.inputs && (
        <div className="banner warn">
          This build has no full source snapshot. Only saved call passages and outputs are shown; current documents are not substituted.
        </div>
      )}
      {data.resultError && <div className="banner warn">{data.resultError}</div>}
      <InlineError error={revision.error ?? validation.error} />
      {view === "graph" ? (
        <Suspense fallback={<LoadingState label="Preparing evidence graph…" />}>
          <EvidenceGraph
            data={data}
            initialTopicId={topicId}
            initialTermId={termId}
            onHighlightTerm={setTermId}
            onInspectTerm={selectTerm}
            onSource={(id, citation) => inspectSource(id, citation)}
            onTopicScope={(id) => {
              setTopicId(id);
              setChunkId("");
            }}
            onTopic={selectTopic}
          />
        </Suspense>
      ) : view === "topics" ? (
        <TboxTopicExplorer
          data={data}
          topicId={topicId}
          chunkId={chunkId}
          query={search.topics}
          onQuery={(value) => setSearch((s) => ({ ...s, topics: value }))}
          onTopic={(id) => {
            setTopicId(id);
            setChunkId("");
          }}
          onChunk={setChunkId}
          onTerm={selectTerm}
          onSource={(id, callId) => inspectSource(id, undefined, callId)}
          onCall={inspectCall}
          onFiles={() => setFilesOpen(true)}
        />
      ) : (
        <div className={`ee-workspace ee-view-${view}${view === "terms" && !term ? " ee-terms-empty" : ""}`}>
          <nav className="ee-navigation" aria-label={view === "terms" ? "Ontology terms" : "Recorded questions"}>
            <label className="field">
              <span>Search {view === "terms" ? "terms" : "questions"}</span>
              <input
                value={search[view]}
                placeholder={view === "terms" ? "Name or definition…" : "Search…"}
                onChange={(e) => setSearch((s) => ({ ...s, [view]: e.target.value }))}
              />
            </label>
            {view === "terms" && (
              <>
                <select aria-label="Term type" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="all">All terms</option>
                  <option value="class">Classes</option>
                  <option value="property">All properties</option>
                  <option value="object">Relationships</option>
                  <option value="data">Attributes</option>
                </select>
                <label className="ee-source-filter">
                  <input type="checkbox" checked={missingSources} onChange={(e) => setMissingSources(e.target.checked)} />
                  Missing source links
                </label>
              </>
            )}
            <div
              className="ee-nav-items"
              ref={listRef}
              onScroll={(e) => {
                scrolls.current[view] = e.currentTarget.scrollTop;
              }}
            >
              {view === "terms" ? (
                <TermButtons terms={filteredTerms} selected={term?.id} onSelect={selectTerm} />
              ) : (
                questions.map((q) => (
                  <button
                    className="ee-nav-card"
                    type="button"
                    key={q.id}
                    aria-pressed={q.id === question?.id}
                    onClick={() => setQuestionId(q.id)}
                  >
                    <strong>{q.text}</strong>
                    <small>{q.usedAsGuidance ? "Recorded build guidance" : q.status}</small>
                  </button>
                ))
              )}
              {(view === "terms" ? !filteredTerms.length : !questions.length) && (
                <p className="ee-note">
                  {search[view]
                    ? "No matching records."
                    : view === "terms"
                      ? "No generated terms yet."
                      : "No questions were recorded for this build."}
                </p>
              )}
            </div>
          </nav>
          <section className="ee-main" aria-label="Selected evidence">
            {view === "terms" ? (
              term ? (
                narrow ? (
                  <p className="ee-note">Select a term to open its evidence inspector.</p>
                ) : (
                  termDetails(term)
                )
              ) : (
                <div className="ee-empty">
                  <h3>No classes or properties recorded yet</h3>
                  <p>You can explore this build’s topic groups and source chunks while generation is incomplete.</p>
                  <button className="btn ghost sm" type="button" onClick={() => setView("topics")}>
                    Explore topic groups
                  </button>
                </div>
              )
            ) : question ? (
              <QuestionContext question={question} data={data} onTerm={selectTerm} validation={validation.data} />
            ) : (
              <p className="ee-empty">No question selected.</p>
            )}
          </section>
          {view === "terms" && (
            <aside className="ee-aside" aria-label="Related questions">
              <h3>Competency questions</h3>
              <p className="ee-note">Suggested relevance is based on word overlap, not proof of answerability.</p>
              {term && data.questions.some((q) => questionMatches(q, [term]).length) ? (
                data.questions
                  .filter((q) => questionMatches(q, [term!]).length)
                  .map((q) => (
                    <button className="ee-question-link" type="button" key={q.id} onClick={() => selectQuestion(q.id)}>
                      {q.text}
                      <small>Suggested relevance</small>
                    </button>
                  ))
              ) : (
                <p className="ee-note">No suggested matches for this term.</p>
              )}
              <button className="btn ghost sm" type="button" onClick={() => setView("questions")}>
                Explore all questions ({data.questions.length})
              </button>
              <details className="ee-details ee-legend">
                <summary>How to read evidence</summary>
                <p>
                  A shared generation step is an input association. A model-cited quote claims support. A located quote confirms the text
                  exists; no human review is recorded here.
                </p>
              </details>
            </aside>
          )}
        </div>
      )}
      <details
        className="method-details ee-technical"
        ref={technicalRef}
        open={technical}
        onToggle={(e) => setTechnical(e.currentTarget.open)}
      >
        <summary>Technical details & stage records</summary>
        {technical && (
          <div className="method-details-body">
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                setTechnical(false);
                headingRef.current?.scrollIntoView({ block: "start" });
              }}
            >
              Back to evidence explorer
            </button>
            <RunInspector key={`${runId}-${technicalStep}`} pid={pid} runId={runId} compact initialStep={technicalStep || undefined} />
          </div>
        )}
      </details>
      <dialog
        className="ee-drawer"
        aria-label="Term evidence"
        ref={dialogRef}
        onCancel={() => setDrawer(false)}
        onClose={() => setDrawer(false)}
      >
        <div className="ee-drawer-head">
          <strong>Term evidence</strong>
          <button className="btn ghost sm" type="button" onClick={() => setDrawer(false)}>
            Close inspector
          </button>
        </div>
        {drawer && term && termDetails(term)}
      </dialog>
      {filesOpen && (
        <Modal title="Source files in this build" wide onClose={closeFiles}>
          <p className="ee-note">File labels stay the same across topics. These names come from the saved build records.</p>
          <div className="ee-file-directory">
            {files.map((file) => (
              <article key={file.id}>
                <strong>{file.label}</strong>
                <span>{file.name}</span>
                <small>
                  {data.documents.has(file.id)
                    ? `${[...data.chunks.values()].filter((c) => c.documentId === file.id).length} chunks in the source snapshot`
                    : "Only saved call passages are available"}
                </small>
              </article>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
