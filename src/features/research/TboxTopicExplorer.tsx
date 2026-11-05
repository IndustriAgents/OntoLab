import { useEffect, useRef, useState } from "react";
import { evidenceFiles, readableChunkPreview, topicChunkEvidence, type TboxEvidence, type EvidenceTerm } from "../../lib/tboxEvidence";
import { StatusBadge } from "../../components/ui/ui";

export function TboxTopicExplorer({
  data,
  topicId,
  chunkId,
  query,
  onQuery,
  onTopic,
  onChunk,
  onTerm,
  onSource,
  onCall,
  onFiles,
}: {
  data: TboxEvidence;
  topicId: string;
  chunkId: string;
  query: string;
  onQuery: (query: string) => void;
  onTopic: (id: string) => void;
  onChunk: (id: string) => void;
  onTerm: (id: string) => void;
  onSource: (id: string, callId?: string) => void;
  onCall: (id: string) => void;
  onFiles: () => void;
}) {
  const [chunkQuery, setChunkQuery] = useState("");
  const chunkListRef = useRef<HTMLDivElement>(null);
  const chunkPanelRef = useRef<HTMLElement>(null);
  const outputPanelRef = useRef<HTMLElement>(null);
  const files = evidenceFiles(data);
  const topicTerms = (ids: string[]) => data.terms.filter((t) => ids.includes(t.id));
  const topics = data.topics.filter((t) =>
    `${t.label} ${topicTerms(t.termIds)
      .map((term) => term.label)
      .join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const topic = topics.find((t) => t.id === topicId) ?? topics[0];
  useEffect(() => {
    if (!chunkId) return;
    const locate = () =>
      [...(chunkListRef.current?.querySelectorAll<HTMLElement>("[data-chunk-id]") ?? [])].find((node) => node.dataset.chunkId === chunkId);
    if (!locate()) setChunkQuery("");
    const frame = requestAnimationFrame(() => {
      const node = locate(),
        list = chunkListRef.current;
      if (!node || !list) return;
      const bounds = node.getBoundingClientRect(),
        viewport = list.getBoundingClientRect();
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) list.scrollTop += bounds.top - viewport.top - 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [chunkId, topic?.id]);
  const calls = data.calls.filter((c) => c.topicId === topic?.id);
  const allTerms = topicTerms(topic?.termIds ?? []);
  const selected = topic?.chunkIds.includes(chunkId) ? topicChunkEvidence(data, topic.id, chunkId) : undefined;
  const terms = selected ? selected.cited : allTerms;
  const selectedChunk = data.chunks.get(chunkId);
  const fileIds = new Set(
    (topic?.chunkIds ?? [])
      .map((id) => data.chunks.get(id)?.documentId ?? calls.flatMap((c) => c.passages ?? []).find((p) => p.chunkId === id)?.documentId)
      .filter(Boolean),
  );
  const labelFor = (id: string) => files.find((f) => f.id === id)?.label ?? "Source unavailable";
  const chunkRows = (topic?.chunkIds ?? [])
    .map((id) => {
      const chunk = data.chunks.get(id);
      const passage = calls.flatMap((c) => c.passages ?? []).find((p) => p.chunkId === id);
      const documentId = chunk?.documentId ?? passage?.documentId ?? "";
      const file = files.find((f) => f.id === documentId);
      const text = chunk?.text ?? passage?.text ?? "";
      const xml = !!file?.name.toLowerCase().endsWith(".xml") && /<\/?[a-z][^>]*>/i.test(text);
      const preview = readableChunkPreview(text, xml);
      return { id, chunk, file, text, xml, preview, evidence: topicChunkEvidence(data, topic!.id, id) };
    })
    .filter((row) =>
      `${row.preview} ${row.chunk?.sectionPath?.join(" / ") ?? ""} ${row.file?.name ?? ""} ${row.file?.label ?? ""} ${row.chunk ? row.chunk.ordinal + 1 : ""}`
        .toLowerCase()
        .includes(chunkQuery.toLowerCase()),
    );
  const renderTerms = (items: EvidenceTerm[]) =>
    items.map((term) => (
      <button className="ee-output-term" type="button" key={term.id} onClick={() => onTerm(term.id)}>
        <strong>{term.label}</strong>
        <small>
          {selected
            ? selected.cited.some((t) => t.id === term.id)
              ? "Quote in this chunk"
              : "Same generation step"
            : term.kind === "class"
              ? "Class"
              : term.kind === "object"
                ? "Relationship"
                : "Attribute"}
        </small>
      </button>
    ));
  return (
    <div className="ee-topic-workspace">
      <nav className="ee-topic-sidebar" aria-label="Topic groups">
        <h3>
          <span className="ee-step-dot">1</span> Choose a topic
        </h3>
        <label className="field">
          <span className="sr-only">Search topics</span>
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search topics or concepts…" />
        </label>
        <label className="field ee-mobile-topic">
          <span className="sr-only">Choose a topic</span>
          <select
            value={topic?.id ?? ""}
            disabled={!topics.length}
            onChange={(e) => {
              onTopic(e.target.value);
              setChunkQuery("");
            }}
          >
            {!topics.length && <option value="">No matching topics</option>}
            {topics.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.chunkIds.length} chunks
              </option>
            ))}
          </select>
        </label>
        <div className="ee-topic-options">
          {topics.map((item) => {
            const output = topicTerms(item.termIds);
            const steps = data.calls.filter((c) => c.topicId === item.id);
            const saved = steps.filter((c) => c.completed).length;
            return (
              <button
                className="ee-topic-option"
                type="button"
                key={item.id}
                aria-pressed={item.id === topic?.id}
                onClick={() => {
                  onTopic(item.id);
                  setChunkQuery("");
                }}
              >
                <span className="ee-topic-option-title">
                  <strong>{item.label}</strong>
                  <small>{item.chunkIds.length} chunks</small>
                </span>
                <span className="ee-topic-concepts">
                  {output.length
                    ? output
                        .slice(0, 3)
                        .map((t) => t.label)
                        .join(" · ")
                    : "Chunks ready to explore"}
                </span>
                <small>
                  {output.length
                    ? `${output.filter((t) => t.kind === "class").length} classes · ${output.filter((t) => t.kind !== "class").length} properties`
                    : "No generated terms yet"}
                </small>
                <span className="ee-topic-progress">
                  <span style={{ width: `${steps.length ? (saved / steps.length) * 100 : 0}%` }} />
                </span>
              </button>
            );
          })}
          {!topics.length && (
            <p className="ee-note">
              {query ? "No matching topics. Try a concept name or clear the search." : "No topic groups were recorded for this build."}
            </p>
          )}
        </div>
      </nav>
      {topic ? (
        <section className="ee-topic-detail" aria-label="Selected topic">
          <header className="ee-topic-heading">
            <div>
              <h3>{topic.label}</h3>
              <p>
                {topic.chunkIds.length} chunks · {fileIds.size} source file{fileIds.size === 1 ? "" : "s"} ·{" "}
                {calls.filter((c) => c.completed).length} of {calls.length} generation steps saved
              </p>
            </div>
            <StatusBadge tone={calls.length && calls.every((c) => c.completed) ? "ok" : "muted"}>
              {calls.some((c) => c.completed)
                ? calls.every((c) => c.completed)
                  ? "Results available"
                  : "Partial results"
                : "Awaiting results"}
            </StatusBadge>
          </header>
          <div className="ee-topic-files">
            <span>Sources:</span>
            {[...fileIds].map((id) => (
              <span key={id} title={files.find((f) => f.id === id)?.name}>
                {labelFor(id!)}
              </span>
            ))}
            <button type="button" className="ee-text-button" onClick={onFiles}>
              See file names
            </button>
          </div>
          <div className="ee-topic-columns">
            <section className="ee-chunk-panel" aria-label="Topic chunks" ref={chunkPanelRef}>
              <div className="ee-panel-heading">
                <h4>
                  <span className="ee-step-dot">2</span> Read its chunks
                </h4>
                <small>{topic.chunkIds.length}</small>
              </div>
              <p className="ee-note">Select a chunk to see the terms linked to its generation steps.</p>
              <button
                className="ee-text-button ee-mobile-jump"
                type="button"
                onClick={() => outputPanelRef.current?.scrollIntoView({ block: "start" })}
              >
                See classes and properties ↓
              </button>
              <label className="field">
                <span className="sr-only">Search topic chunks</span>
                <input value={chunkQuery} onChange={(e) => setChunkQuery(e.target.value)} placeholder="Search text, file or section…" />
              </label>
              <div className="ee-chunk-options" ref={chunkListRef}>
                {chunkRows.map((row) => (
                  <article className={`ee-chunk-card${chunkId === row.id ? " is-selected" : ""}`} data-chunk-id={row.id} key={row.id}>
                    <button
                      className="ee-chunk-select"
                      type="button"
                      aria-pressed={chunkId === row.id}
                      onClick={() => onChunk(chunkId === row.id ? "" : row.id)}
                    >
                      <span className="ee-chunk-card-heading">
                        <strong>{row.chunk ? `Chunk ${row.chunk.ordinal + 1}` : "Stored passage"}</strong>
                        <span title={row.file?.name}>
                          {row.file?.label ?? "Unknown file"}
                          {row.chunk?.page ? ` · p. ${row.chunk.page}` : ""}
                        </span>
                      </span>
                      {!!row.chunk?.sectionPath?.length && <small className="ee-chunk-section">{row.chunk.sectionPath.join(" / ")}</small>}
                      <span className="ee-chunk-preview">
                        {row.preview
                          ? `${row.preview.slice(0, 220)}${row.preview.length > 220 ? "…" : ""}`
                          : "The original chunk snapshot is unavailable."}
                      </span>
                      <span className="ee-chunk-card-foot">
                        <span>
                          {row.evidence.status === "used"
                            ? row.evidence.shortened
                              ? "Used · partial text per step"
                              : "Used in generation"
                            : row.evidence.status === "pending"
                              ? "Not processed yet"
                              : row.evidence.status === "omitted"
                                ? "Not sent"
                                : "Input record unavailable"}
                        </span>
                        {row.evidence.cited.length > 0 && (
                          <span>
                            {row.evidence.cited.length} quoted term{row.evidence.cited.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                    </button>
                    <div className="ee-chunk-actions">
                      <button
                        className="ee-text-button"
                        type="button"
                        disabled={!row.text}
                        onClick={() => onSource(row.id, row.evidence.sent[0]?.id)}
                      >
                        Read exact chunk
                      </button>
                      {row.xml && <small>Readable XML preview</small>}
                    </div>
                  </article>
                ))}
                {!chunkRows.length && <p className="ee-empty">No chunks match this search.</p>}
              </div>
            </section>
            <section className="ee-output-panel" aria-label="Topic classes and properties" ref={outputPanelRef}>
              <div className="ee-panel-heading">
                <h4>
                  <span className="ee-step-dot">3</span> Inspect its terms
                </h4>
              </div>
              <button
                className="ee-text-button ee-mobile-jump"
                type="button"
                onClick={() => chunkPanelRef.current?.scrollIntoView({ block: "start" })}
              >
                Back to chunks ↑
              </button>
              {selected ? (
                <div className="ee-chunk-focus">
                  <strong>
                    {selectedChunk ? `Showing links for Chunk ${selectedChunk.ordinal + 1}` : "Showing links for the selected passage"}
                  </strong>
                  <button className="ee-text-button" type="button" onClick={() => onChunk("")}>
                    Show all topic terms
                  </button>
                </div>
              ) : (
                <p className="ee-note">Choose a class or property to read its source quotes and generation history.</p>
              )}
              {selected && (
                <p className="ee-note">A quote in this chunk is a model-cited source. Sharing a generation step is an input association.</p>
              )}
              <div className="ee-output-groups">
                {(
                  [
                    ["Classes", terms.filter((t) => t.kind === "class"), "terms"],
                    ["Properties", terms.filter((t) => t.kind !== "class"), "relations"],
                  ] as const
                ).map(([name, items, stepKind]) => (
                  <section className="ee-output-group" key={name}>
                    <h5>
                      {selected ? `${name} quoted in this chunk` : name}
                      <span>{items.length}</span>
                    </h5>
                    {items.length ? (
                      <div className="ee-output-terms">{renderTerms(items)}</div>
                    ) : (
                      <div className="ee-output-placeholder">
                        <strong>{selected ? `No quoted ${name.toLowerCase()} recorded` : `No ${name.toLowerCase()} recorded yet`}</strong>
                        <p>
                          {selected
                            ? selected.status === "omitted"
                              ? "This chunk was not sent in the recorded generation calls."
                              : selected.status === "pending"
                                ? "This chunk is waiting for generation. Its outputs will appear here as steps finish."
                                : selected.status === "unknown"
                                  ? "The saved input record is unavailable, so direct source links cannot be verified."
                                  : selected.calls.some((c) => c.step.kind === stepKind && !c.completed) &&
                                      !selected.calls.some((c) => c.step.kind === stepKind && c.completed)
                                    ? `${name === "Properties" ? "Property" : "Class"} generation has not recorded a result for this chunk yet.`
                                    : "Any terms from the same generation steps are available below. You can also show all topic terms."
                            : calls.filter((c) => c.step.kind === stepKind).some((c) => !c.completed)
                              ? name === "Properties"
                                ? "Properties are generated after the classes are established."
                                : "Classes will appear here as this topic’s generation steps finish."
                              : "These generation steps have no recorded candidates."}
                        </p>
                      </div>
                    )}
                  </section>
                ))}
              </div>
              {!!selected?.associated.length && (
                <details className="ee-step-associations">
                  <summary>Other terms from the same generation steps ({selected.associated.length})</summary>
                  <p className="ee-note">These terms shared this chunk’s model input. No quote linking them to this chunk was located.</p>
                  {(
                    [
                      ["Classes", selected.associated.filter((t) => t.kind === "class")],
                      ["Properties", selected.associated.filter((t) => t.kind !== "class")],
                    ] as const
                  ).map(
                    ([name, items]) =>
                      items.length > 0 && (
                        <section key={name}>
                          <h6>{name}</h6>
                          <div className="ee-output-terms">{renderTerms(items)}</div>
                        </section>
                      ),
                  )}
                </details>
              )}
            </section>
          </div>
          <details className="ee-topic-method">
            <summary>Generation steps & input details</summary>
            <p className="ee-note">A topic can be divided into several model calls. These are processing batches within the same topic.</p>
            {calls.map((call) => (
              <div className="ee-topic-call" key={call.id}>
                <span>
                  {call.step.kind === "terms" ? "Classes" : "Properties"}
                  {call.step.topic && call.step.topic.batches > 1
                    ? ` · batch ${call.step.topic.batch + 1} of ${call.step.topic.batches}`
                    : ""}
                  <small>
                    {call.completed
                      ? call.passages
                        ? call.step.chunkIds?.length
                          ? `${call.passages.length} of ${call.step.chunkIds.length} planned chunks recorded in input`
                          : `${call.passages.length} chunks recorded in input`
                        : "Input record unavailable"
                      : "No result recorded yet"}
                  </small>
                </span>
                <button className="btn ghost sm" type="button" onClick={() => onCall(call.id)}>
                  Inspect step
                </button>
              </div>
            ))}
          </details>
        </section>
      ) : (
        <div className="ee-empty">
          {query
            ? "Clear the topic search to see the build’s topic groups."
            : "This build has no recorded topic groups. Any recorded classes and properties are available in the Terms view."}
        </div>
      )}
    </div>
  );
}
