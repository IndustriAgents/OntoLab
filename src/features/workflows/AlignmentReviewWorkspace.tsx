import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AlignmentMapping, RevisionWithContent } from "../../types/project";
import type { AlignmentReviewInput } from "../../types/alignment";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { ALIGNMENT_RELATIONS, ALIGNMENT_STATUSES, comparisonIsCurrent, mappingIsCurrent, mappingStatement } from "../../lib/alignment";
import { localName } from "../../lib/ontology/iri";
import { InlineError, StatusBadge } from "../../components/ui/ui";
import { JsonDetails } from "../research/ResearchResults";
import { alignmentTerms, type AlignmentTerm } from "./alignmentTerms";

const RELATIONS = Object.entries(ALIGNMENT_RELATIONS).filter(([key]) => key !== "unrelated");

function TermCard({ side, term, uri }: { side: string; term?: AlignmentTerm; uri: string }) {
  return (
    <section className="alignment-term" aria-label={`${side} term`}>
      <span className="eyebrow">
        {side} · {term?.kind === "object" ? "Object property" : term?.kind === "data" ? "Datatype property" : "Class"}
      </span>
      <h3>{term?.label ?? localName(uri)}</h3>
      <p className="workflow-iri">{uri}</p>
      <small>{term?.moduleName ?? "Term is not in the current modules"}</small>
      <p>{term?.comment || "No definition recorded."}</p>
      {term && (
        <dl>
          {(
            [
              ["Parents", term.parents],
              ["Children", term.children],
              ["Domain", term.domain],
              ["Range", term.range],
            ] as const
          )
            .filter(([label, values]) => values.length || (term.kind !== "class" && (label === "Domain" || label === "Range")))
            .map(([label, values]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {values.length
                    ? values.map((value) => (
                        <span key={value} title={value}>
                          {localName(value)}
                        </span>
                      ))
                    : "Not specified"}
                </dd>
              </div>
            ))}
          {!!term.constraints.length && (
            <div>
              <dt>Constraints</dt>
              <dd>
                {term.constraints.map((value) => (
                  <span key={value}>{value}</span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function RelationEditor({
  mapping,
  busy,
  onSave,
}: {
  mapping: AlignmentMapping;
  busy: boolean;
  onSave: (input: AlignmentReviewInput) => void;
}) {
  const [relation, setRelation] = useState(mapping.relation === "unrelated" ? "candidate" : mapping.relation);
  const [note, setNote] = useState(mapping.reviewNote ?? "");
  return (
    <details className="method-details">
      <summary>Correct relation or add a review note</summary>
      <form
        className="method-details-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ action: "edit", ids: [mapping.id], relation, note });
        }}
      >
        <label className="field">
          <span>Source term … target term</span>
          <select value={relation} disabled={busy} onChange={(e) => setRelation(e.target.value as typeof relation)}>
            {RELATIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Reason for this decision</span>
          <textarea value={note} maxLength={2000} disabled={busy} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>
        <pre className="ttl-preview">{mappingStatement({ ...mapping, relation })}</pre>
        <p>
          Saving a correction returns the mapping to review and removes its previous statement from the draft bridge. Accept it to apply the
          corrected relation.
        </p>
        <button className="btn" disabled={busy || (relation === mapping.relation && note === (mapping.reviewNote ?? ""))}>
          Save correction for review
        </button>
      </form>
    </details>
  );
}

function ManualMapping({
  sources,
  targets,
  busy,
  onAdd,
}: {
  sources: AlignmentTerm[];
  targets: AlignmentTerm[];
  busy: boolean;
  onAdd: (input: AlignmentReviewInput) => void;
}) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [relation, setRelation] = useState<AlignmentMapping["relation"]>("candidate");
  const [note, setNote] = useState("");
  const kind = sources.find((term) => term.uri === source)?.kind;
  const choices = targets.filter((term) => term.kind === kind && term.uri !== source);
  const unique = (terms: AlignmentTerm[]) => [...new Map(terms.map((term) => [term.uri, term])).values()];
  return (
    <details className="method-details">
      <summary>Add a mapping manually</summary>
      <form
        className="method-details-body"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd({ action: "add", source, target, relation, note });
        }}
      >
        <p>Add a pair retrieval missed. Only compatible term kinds from the last comparison are offered; adding sends it to review.</p>
        <div className="alignment-term-pair">
          <label className="field">
            <span>Source term</span>
            <select
              value={source}
              disabled={busy}
              onChange={(e) => {
                setSource(e.target.value);
                setTarget("");
              }}
            >
              <option value="">Choose source term</option>
              {unique(sources).map((term) => (
                <option key={term.uri} value={term.uri}>
                  {term.label} · {term.moduleName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Target term</span>
            <select value={target} disabled={busy || !source} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose target term</option>
              {unique(choices).map((term) => (
                <option key={term.uri} value={term.uri}>
                  {term.label} · {term.moduleName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Source term … target term</span>
          <select value={relation} disabled={busy} onChange={(e) => setRelation(e.target.value as typeof relation)}>
            {RELATIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Review note (optional)</span>
          <textarea rows={2} value={note} maxLength={2000} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !source || !choices.some((term) => term.uri === target)}>
          Add to review
        </button>
      </form>
    </details>
  );
}

export function AlignmentReviewWorkspace({
  revision,
  onChanged,
  onFindMatches,
}: {
  revision: RevisionWithContent;
  onChanged: (id: string) => Promise<void>;
  onFindMatches: () => void;
}) {
  const { pid, working } = useProject();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const content = revision.content;
  const mappings = content.review?.alignment ?? [];
  const records = content.review?.alignmentRuns ?? [];
  const latest = records.at(-1);
  const terms = useMemo(() => alignmentTerms(content.modules), [content.modules]);
  const termByUri = useMemo(() => new Map(terms.map((term) => [term.uri, term])), [terms]);
  const label = (uri: string) => termByUri.get(uri)?.label ?? localName(uri);
  const filter = params.get("review") ?? "open";
  const query = params.get("q") ?? "";
  const update = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  const matchesFilter = (m: AlignmentMapping) =>
    filter === "all" ||
    (filter === "conflicts" ? !!m.conflict : filter === "stale" ? !mappingIsCurrent(m, content) : (m.status ?? "open") === filter);
  const visible = mappings.filter(
    (m) => matchesFilter(m) && `${label(m.source)} ${label(m.target)} ${m.source} ${m.target}`.toLowerCase().includes(query.toLowerCase()),
  );
  const focused = visible.find((m) => m.id === params.get("mapping")) ?? visible[0];
  const selectedIds = selected.filter((id) => visible.some((m) => m.id === id && m.status !== "accepted" && mappingIsCurrent(m, content)));
  const decide = useMutation({
    mutationFn: async (input: AlignmentReviewInput) => {
      await working.flush();
      return api.reviewAlignment(pid, revision.id, { ...input, expectedHash: revision.contentHash });
    },
    onSuccess: async (result, input) => {
      const next = await api.getRevision(pid, result.id);
      qc.setQueryData(qk.revision(pid, result.id), next);
      await qc.invalidateQueries({ queryKey: qk.report(pid, result.id) });
      setSelected([]);
      const changed = next.content.review?.alignment?.filter((m) => input.ids?.includes(m.id)) ?? [];
      setMessage(
        input.action === "accept"
          ? `${changed.filter((m) => m.status === "accepted").length} mappings accepted. ${changed.filter((m) => m.conflict).length} held back by the coherence check.`
          : input.action === "undo"
            ? "Decision undone. The draft bridge has been updated."
            : input.action === "add"
              ? "Mapping added for review. Accept it to include it in the bridge."
              : "Review decision saved. The draft bridge reflects accepted mappings only.",
      );
      await onChanged(result.id);
      if (input.action === "add") {
        const added = next.content.review?.alignment?.find((m) => m.source === input.source && m.target === input.target);
        update({ review: "open", mapping: added?.id ?? null, q: null });
      }
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.revision(pid, revision.id) });
    },
  });
  const current = focused ? mappingIsCurrent(focused, content) : false;
  const record = focused?.runId ? records.find((r) => r.id === focused.runId) : latest;
  const focusedTerm = (side: "source" | "target") =>
    focused
      ? (terms.find(
          (t) => t.uri === focused[side] && (!record || record[side === "source" ? "sourceModules" : "targetModules"].includes(t.moduleId)),
        ) ?? termByUri.get(focused[side]))
      : undefined;
  const lastDecision = content.review?.alignmentDecisions?.filter((d) => d.mappingId === focused?.id).at(-1);
  const alternatives =
    latest?.candidates.filter((m) => m.source === focused?.source && m.target !== focused.target && m.relation !== "unrelated") ?? [];
  return (
    <div className="workflow-stack">
      <div className="workflow-section-title">
        <div>
          <h2>Review mappings</h2>
          <p>Compare meanings and context. Accepted mappings enter the draft bridge; source modules keep their original terms.</p>
        </div>
        <button className="btn ghost sm" disabled={decide.isPending} onClick={onFindMatches}>
          Adjust comparison
        </button>
      </div>
      <div className="workflow-inline-stats">
        {Object.entries(ALIGNMENT_STATUSES).map(([status, text]) => (
          <span key={status}>
            <strong>{mappings.filter((m) => (m.status ?? "open") === status).length}</strong> {text.toLowerCase()}
          </span>
        ))}
      </div>
      <InlineError error={decide.error} />
      {message && (
        <p className="banner subtle" role="status">
          {message}
        </p>
      )}
      <div className="alignment-filters">
        <label className="field">
          <span>Review status</span>
          <select
            value={filter}
            onChange={(e) => {
              setSelected([]);
              update({ review: e.target.value, mapping: null });
            }}
          >
            <option value="all">All mappings</option>
            {Object.entries(ALIGNMENT_STATUSES).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
            <option value="conflicts">Coherence conflicts</option>
            <option value="stale">Inputs changed</option>
          </select>
        </label>
        <label className="field">
          <span>Search mappings</span>
          <input
            type="search"
            value={query}
            placeholder="Term name or IRI"
            onChange={(e) => {
              setSelected([]);
              update({ q: e.target.value, mapping: null });
            }}
          />
        </label>
      </div>
      {!!selectedIds.length && (
        <div className="alignment-bulk" aria-label="Selected mapping actions">
          <span>{selectedIds.length} selected</span>
          {(
            [
              ["accept", "Accept selected"],
              ["reject", "Reject selected"],
              ["defer", "Defer selected"],
            ] as const
          ).map(([action, title]) => (
            <button
              key={action}
              className="btn ghost sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ action, ids: selectedIds })}
            >
              {title}
            </button>
          ))}
        </div>
      )}
      {!mappings.length && (
        <div className="banner subtle">
          <p>No mappings yet. Find matches or add a pair manually after comparing your modules.</p>
          <button className="btn" onClick={onFindMatches}>
            Choose comparison
          </button>
        </div>
      )}
      {!!mappings.length && !visible.length && <p role="status">No mappings in this view. Choose another status or clear your search.</p>}
      {!!visible.length && (
        <div className="alignment-review-grid">
          <section className="alignment-queue" aria-label="Mapping queue">
            <div className="alignment-queue-heading">{visible.length} mappings · choose a pair to review</div>
            <ul>
              {visible.map((mapping) => (
                <li key={mapping.id} className={focused?.id === mapping.id ? "is-selected" : ""}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${label(mapping.source)} to ${label(mapping.target)}`}
                    checked={selectedIds.includes(mapping.id)}
                    disabled={decide.isPending || mapping.status === "accepted" || !mappingIsCurrent(mapping, content)}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, mapping.id] : selected.filter((id) => id !== mapping.id))}
                  />
                  <button aria-pressed={focused?.id === mapping.id} onClick={() => update({ mapping: mapping.id })}>
                    <strong>
                      {label(mapping.source)} → {label(mapping.target)}
                    </strong>
                    <span>{ALIGNMENT_RELATIONS[mapping.relation]}</span>
                    <small>
                      {ALIGNMENT_STATUSES[mapping.status ?? "open"]}
                      {mapping.conflict ? " · Conflict" : ""}
                      {!mappingIsCurrent(mapping, content) ? " · Inputs changed" : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {focused && (
            <section className="alignment-inspector" aria-label="Mapping details">
              <div className="alignment-term-pair">
                <TermCard side="Source" term={focusedTerm("source")} uri={focused.source} />
                <TermCard side="Target" term={focusedTerm("target")} uri={focused.target} />
              </div>
              <div className="alignment-relation">
                <strong>
                  {label(focused.source)} {ALIGNMENT_RELATIONS[focused.relation]} {label(focused.target)}
                </strong>
                <div className="row-actions">
                  <StatusBadge tone={focused.status === "accepted" ? "ok" : "muted"}>
                    {ALIGNMENT_STATUSES[focused.status ?? "open"]}
                  </StatusBadge>
                  <span>
                    {focused.humanReviewed
                      ? "Human-authored relation"
                      : focused.verified
                        ? "Model-classified relation"
                        : "Similarity suggestion"}
                  </span>
                </div>
                <p>{focused.rationale}</p>
                {focused.reviewNote && (
                  <p>
                    <strong>Review note:</strong> {focused.reviewNote}
                  </p>
                )}
                <p>
                  {focused.relation === "candidate" || focused.relation === "related"
                    ? "This adds an associative link, not logical equivalence."
                    : "Accepting this relation adds a logical axiom. Review its direction and definitions before applying."}
                </p>
                <pre className="ttl-preview" aria-label="Mapping statement preview">
                  {mappingStatement(focused) ?? "No bridge statement for unrelated terms."}
                </pre>
              </div>
              {!current && (
                <p className="banner warn" role="status">
                  The compared inputs changed. Run matching again before accepting or correcting this mapping. You can still reject, defer
                  or reopen it.
                </p>
              )}
              {focused.conflict && (
                <div className="banner error">
                  <strong>Held back by the coherence check</strong>
                  <p>{focused.conflict.explanation.join(" ")}</p>
                  <p>Affected classes: {focused.conflict.unsat.map(localName).join(", ")}</p>
                </div>
              )}
              <div className="row-actions" aria-label="Mapping actions">
                {focused.status !== "accepted" && (
                  <button
                    className="btn"
                    disabled={decide.isPending || !current || focused.relation === "unrelated"}
                    onClick={() => decide.mutate({ action: "accept", ids: [focused.id] })}
                  >
                    Accept mapping
                  </button>
                )}
                {focused.status !== "dismissed" && (
                  <button
                    className="btn ghost"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ action: "reject", ids: [focused.id] })}
                  >
                    Reject
                  </button>
                )}
                {focused.status !== "deferred" && (
                  <button
                    className="btn ghost"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ action: "defer", ids: [focused.id] })}
                  >
                    Defer
                  </button>
                )}
                {focused.status && focused.status !== "open" && (
                  <button
                    className="btn ghost"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ action: "reopen", ids: [focused.id] })}
                  >
                    Return to review
                  </button>
                )}
                {lastDecision && lastDecision.action !== "undo" && lastDecision.action !== "inputs_changed" && (
                  <button
                    className="btn ghost"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ action: "undo", ids: [focused.id] })}
                  >
                    Undo last decision
                  </button>
                )}
              </div>
              {current && (
                <RelationEditor
                  key={`${focused.id}-${focused.relation}-${focused.reviewNote ?? ""}`}
                  mapping={focused}
                  busy={decide.isPending}
                  onSave={(input) => decide.mutate(input)}
                />
              )}
              {!!alternatives.length && (
                <details className="method-details">
                  <summary>Other retrieved targets for {label(focused.source)}</summary>
                  <div className="method-details-body">
                    {alternatives.map((candidate) => {
                      const existing = mappings.find((m) => m.source === candidate.source && m.target === candidate.target);
                      return (
                        <div key={candidate.id}>
                          <strong>{label(candidate.target)}</strong>
                          <p>
                            {ALIGNMENT_RELATIONS[candidate.relation]} · {candidate.score.toFixed(3)} similarity
                          </p>
                          <p>{candidate.rationale}</p>
                          <button
                            className="btn ghost sm"
                            disabled={decide.isPending || !latest || !comparisonIsCurrent(latest, content)}
                            onClick={() =>
                              existing
                                ? update({ review: "all", mapping: existing.id, q: null })
                                : decide.mutate({
                                    action: "add",
                                    source: candidate.source,
                                    target: candidate.target,
                                    relation: candidate.relation,
                                  })
                            }
                          >
                            {existing ? "Open mapping" : "Add alternative to review"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              <details className="method-details">
                <summary>Scores and decision history</summary>
                <div className="method-details-body">
                  <p>
                    Retrieval similarity: {focused.score.toFixed(3)}. Scores are not calibrated probabilities. The coherence check covers
                    supported constructs in the in-process reasoner.
                  </p>
                  <JsonDetails value={focused.scores} label="Individual matcher scores" />
                  <ol className="alignment-history">
                    {content.review?.alignmentDecisions
                      ?.filter((event) => event.mappingId === focused.id)
                      .map((event) => (
                        <li key={event.id}>
                          {new Date(event.at).toLocaleString()} · {event.action.replaceAll("_", " ")}
                          {event.note ? ` · ${event.note}` : ""}
                        </li>
                      ))}
                  </ol>
                </div>
              </details>
            </section>
          )}
        </div>
      )}
      {latest && comparisonIsCurrent(latest, content) && (
        <ManualMapping
          key={latest.id}
          sources={terms.filter((t) => latest.sourceModules.includes(t.moduleId))}
          targets={terms.filter((t) => latest.targetModules.includes(t.moduleId))}
          busy={decide.isPending}
          onAdd={(input) => decide.mutate(input)}
        />
      )}
    </div>
  );
}
