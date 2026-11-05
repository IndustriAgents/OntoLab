import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { qk } from "../../lib/projectApi";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { corpusChanges, corpusFactKey } from "../../lib/corpusGraph";
import { listFacts, applyDecisions, type FactRow } from "../../lib/ontology/factReview";
import { localName } from "../../lib/ontology/iri";
import { validateABox } from "../../lib/ontology/aboxValidator";
import { InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { EvidenceItem } from "../documents/DocumentViewer";
import { useEvidenceViewer } from "../evidence/useEvidence";
import { ReviewQueue } from "../explore/ReviewQueue";
import { MergePanel } from "../explore/MergePanel";
import { IndividualInspector } from "../explore/IndividualInspector";
import { ValidationView } from "../validate/ValidationView";
import { CommitDialog } from "../revisions/RevisionBar";
import type { RevisionContent } from "../../types/project";
import type { UnresolvedRelationship } from "../../types/abox";
import "../explore/graph.css";
const describe = (f: FactRow) =>
  f.kind === "type"
    ? `is a ${localName(f.classUri ?? "")}`
    : f.kind === "data"
      ? `${localName(f.propUri ?? "")} = ${f.value}`
      : `${localName(f.propUri ?? "")} → ${f.targetId}`;
function UnresolvedCard({
  link,
  content,
  onResolve,
  busy,
}: {
  link: UnresolvedRelationship;
  content: RevisionContent;
  onResolve: (body: { id: string; targetId?: string; create?: { id: string; label: string; classUri: string }; dismiss?: boolean }) => void;
  busy: boolean;
}) {
  const { working } = useProject();
  const [target, setTarget] = useState(""),
    [create, setCreate] = useState(false),
    [id, setId] = useState(link.targetId),
    [label, setLabel] = useState(link.targetId),
    [classUri, setClass] = useState("");
  return (
    <div className="corpus-unresolved">
      <strong>
        {link.subjectId} → {localName(link.propUri)} → {link.targetId}
      </strong>
      <p>The target was not found. This proposal is retained and excluded from graph answers and exports until it is resolved.</p>
      <label className="field">
        <span>Link to an existing entity</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose target</option>
          {content.abox?.individuals.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label ?? i.id} · {localName(i.classUri)}
            </option>
          ))}
        </select>
      </label>
      <div className="row-actions">
        <button className="btn ghost sm" disabled={busy || !target} onClick={() => onResolve({ id: link.id, targetId: target })}>
          Use target
        </button>
        <button className="btn ghost sm" onClick={() => setCreate(!create)}>
          Create missing entity
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => onResolve({ id: link.id, dismiss: true })}>
          Dismiss proposal
        </button>
      </div>
      {create && (
        <div className="corpus-form">
          <label className="field">
            <span>Entity identifier</span>
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label className="field">
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field">
            <span>Class in this ontology</span>
            <select value={classUri} onChange={(e) => setClass(e.target.value)}>
              <option value="">Choose class</option>
              {working.tbox?.classes.map((c) => (
                <option key={c.uri} value={c.uri}>
                  {c.label ?? localName(c.uri)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            disabled={busy || !id.trim() || !classUri || !label.trim()}
            onClick={() => onResolve({ id: link.id, create: { id: id.trim(), label: label.trim(), classUri } })}
          >
            Create and connect
          </button>
        </div>
      )}
    </div>
  );
}
export function CorpusReview({ pid, revisionId, refresh }: { pid: string; revisionId: string; refresh: () => void }) {
  const [, setParams] = useSearchParams();
  const { working } = useProject(),
    qc = useQueryClient(),
    viewer = useEvidenceViewer(pid);
  const [filter, setFilter] = useState("auto"),
    [selected, setSelected] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    setFilter("auto");
    setSelected("");
  }, [revisionId]);
  const report = useQuery({
    queryKey: corpusKeys.review(pid, revisionId),
    queryFn: () => corpusApi.review(pid, revisionId),
    refetchInterval: (q) => (q.state.data?.revision.status === "draft" ? 5000 : false),
  });
  const flush = async () => {
    if (working.revision?.id === revisionId && working.isDraft && (await working.flush()) !== revisionId)
      throw Error("Save your current edits before continuing.");
  };
  const invalidate = () => {
    for (const key of [corpusKeys.review(pid, revisionId), qk.revision(pid, revisionId), qk.revisions(pid), qk.report(pid, revisionId)])
      void qc.invalidateQueries({ queryKey: key });
    refresh();
  };
  const losses = useMutation({
    mutationFn: async ({ keys, decision }: { keys: string[]; decision: "remove" | "manual" }) => {
      await flush();
      return corpusApi.losses(pid, revisionId, keys, decision);
    },
    onSuccess: invalidate,
    onError: invalidate,
  });
  const relationships = useMutation({
    mutationFn: async (body: Parameters<typeof corpusApi.relationship>[2]) => {
      await flush();
      return corpusApi.relationship(pid, revisionId, body);
    },
    onSuccess: invalidate,
  });
  const replacementDecision = useMutation({
    mutationFn: async ({ beforeKey, afterKey, decision }: { beforeKey: string; afterKey: string; decision: "proposed" | "previous" }) => {
      await flush();
      return corpusApi.replacement(pid, revisionId, beforeKey, afterKey, decision);
    },
    onSuccess: invalidate,
    onError: invalidate,
  });
  const content = working.revision?.id === revisionId ? working.content : report.data?.revision.content;
  const changes = useMemo(
    () => (content ? corpusChanges(report.data?.base?.content.abox ?? { individuals: [] }, content.abox ?? { individuals: [] }) : null),
    [content, report.data?.base],
  );
  const findings = useMemo(
    () =>
      content && working.revision?.id === revisionId && working.tbox
        ? validateABox(content.abox ?? { individuals: [] }, working.tbox, content.baseIri)
        : (report.data?.findings ?? []),
    [content, working.revision?.id, working.tbox, revisionId, report.data?.findings],
  );
  if (!report.data || !content || !changes)
    return (
      <>
        <LoadingState label="Comparing graph changes…" />
        <InlineError error={report.error} />
      </>
    );
  const r = report.data.revision,
    editable =
      r.status === "draft" &&
      working.revision?.id === revisionId &&
      !losses.isPending &&
      !relationships.isPending &&
      !replacementDecision.isPending,
    all = content.abox ? listFacts(content.abox) : [];
  const updatedKeys = new Set(changes.updated.map((c) => corpusFactKey(c.after)));
  const afterKeys = new Set(all.map(corpusFactKey));
  const replacedKeys = new Set(changes.updated.map((c) => corpusFactKey(c.before)));
  const changedRows = [
    ...new Map(
      [
        ...changes.added,
        ...changes.enriched,
        ...changes.reduced,
        ...changes.reviewed,
        ...changes.removed.filter((f) => !replacedKeys.has(corpusFactKey(f))),
      ].map((f) => [corpusFactKey(f), f]),
    ).values(),
  ];
  const changedKeys = new Set(changedRows.map(corpusFactKey));
  const conflicts = [
    ...new Set(
      findings
        .filter((f) => ["functional", "disjoint", "inconsistent"].includes(f.code ?? ""))
        .map((f) => `${f.id ?? f.where}|${f.prop ?? ""}`),
    ),
  ];
  const chosenFilter = filter === "auto" ? "changes" : filter;
  const rows =
    chosenFilter === "changes"
      ? changedRows
      : chosenFilter === "updated"
        ? changes.updated.map((c) => c.after)
        : chosenFilter === "removed"
          ? changes.removed
          : chosenFilter === "enriched"
            ? changes.enriched
            : chosenFilter === "reduced"
              ? changes.reduced
              : chosenFilter === "reviewed"
                ? changes.reviewed
                : chosenFilter === "review"
                  ? all.filter((f) => f.status === "candidate" && changedKeys.has(corpusFactKey(f)))
                  : chosenFilter === "conflicts"
                    ? all.filter(
                        (f) => conflicts.includes(`${f.individualId}|${f.propUri ?? ""}`) || conflicts.includes(`${f.individualId}|`),
                      )
                    : chosenFilter === "all"
                      ? all
                      : changes.added.filter((f) => !updatedKeys.has(corpusFactKey(f)));
  const fact = rows.find((f) => corpusFactKey(f) === selected) ?? rows[0],
    ind = content.abox?.individuals.find((i) => i.id === fact?.individualId),
    pending = content.corpus?.losses.filter((l) => l.decision === "pending") ?? [],
    unresolved = content.abox?.unresolved?.filter((l) => l.status === "open") ?? [];
  const valueChange = fact ? changes.updated.find((c) => corpusFactKey(c.after) === corpusFactKey(fact)) : undefined;
  const sourceLoss = fact ? pending.find((l) => l.key === corpusFactKey(fact)) : undefined;
  const groups = new Map<string, FactRow[]>();
  for (const row of rows) groups.set(row.individualId, [...(groups.get(row.individualId) ?? []), row]);
  const supported = rows.filter(
    (f) =>
      f.status === "candidate" &&
      afterKeys.has(corpusFactKey(f)) &&
      changedKeys.has(corpusFactKey(f)) &&
      !changes.updated.some((c) => corpusFactKey(c.after) === corpusFactKey(f)) &&
      !findings.some((issue) => issue.id === f.individualId && (!issue.prop || issue.prop === f.propUri)) &&
      !f.evidence.some((ev) => ev.review || ev.status === "unverified") &&
      f.evidence.some((ev) => ev.status === "verified" && (ev.confidence ?? 0) >= 0.8 && !ev.review),
  );
  const acceptSupported = (facts: FactRow[]) => {
    if (!content.abox || !facts.length) return;
    working.setContent(
      {
        ...content,
        abox: applyDecisions(
          content.abox,
          facts.map((f) => ({ key: f.key, status: "accepted" })),
          new Date().toISOString(),
        ).abox,
      },
      `Accept ${facts.length} supported changes`,
    );
  };
  const update = (next: RevisionContent, label: string) => {
    working.setContent(next, label);
  };
  const decide = (status: "accepted" | "rejected") => {
    if (!content.abox || !fact) return;
    update(
      { ...content, abox: applyDecisions(content.abox, [{ key: fact.key, status }], new Date().toISOString()).abox },
      `${status === "accepted" ? "Accept" : "Reject"} ${fact.individualId} ${describe(fact)}`,
    );
  };
  const selectEntity = (id: string) => {
    const row = all.find((f) => f.individualId === id);
    if (!row) return;
    setFilter("all");
    setSelected(corpusFactKey(row));
  };
  return (
    <div className="corpus-stack">
      <div className="corpus-action-bar">
        <div>
          <h2>{r.status === "draft" ? "Review the proposed graph update" : `Saved graph version ${Math.max(0, r.number ?? 0)}`}</h2>
          <p>Review only what changed, grouped by entity. {changes.unchanged} unchanged facts are kept. The saved graph stays available.</p>
        </div>
        <div className="row-actions">
          <Link className="btn ghost" to={`/p/${pid}/explore?rev=${revisionId}`}>
            Open graph & table
          </Link>
          {editable && (
            <button
              className="btn"
              disabled={!!pending.length || report.data.stale || working.save === "error" || working.save === "conflict"}
              onClick={() => setSaving(true)}
            >
              {report.data.base?.number ? "Save graph update" : "Save knowledge graph"}
            </button>
          )}
        </div>
      </div>
      {report.data.stale && (
        <div className="banner warn">
          Another graph version was saved after this draft started. Your draft is preserved.{" "}
          <Link to={`/p/${pid}/graph?tab=updates`}>Prepare an update against the latest version →</Link>
        </div>
      )}
      <div className="corpus-plan-stats">
        <div>
          New facts<strong>{changes.added.length - changes.updated.length}</strong>
        </div>
        <div>
          Updated values<strong>{changes.updated.length}</strong>
        </div>
        <div>
          Source support added<strong>{changes.enriched.length}</strong>
        </div>
        {!!changes.reduced.length && (
          <div>
            Source support reduced<strong>{changes.reduced.length}</strong>
          </div>
        )}
        {!!changes.reviewed.length && (
          <div>
            Review decisions changed<strong>{changes.reviewed.length}</strong>
          </div>
        )}
        <div>
          Removed facts<strong>{changes.removed.length - changes.updated.length}</strong>
        </div>
      </div>
      {r.status === "committed" && (
        <div className="corpus-success">
          <h2>This graph version is saved</h2>
          <p>Its source versions, ontology and review decisions remain available in graph history.</p>
          <div className="row-actions">
            <Link className="btn" to={`/p/${pid}/explore?rev=${revisionId}`}>
              Open knowledge graph
            </Link>
            <Link className="btn ghost" to={`/p/${pid}/assistant?rev=${revisionId}`}>
              Ask questions
            </Link>
            <Link className="btn ghost" to={`/p/${pid}/export?rev=${revisionId}`}>
              Download graph
            </Link>
            <Link className="btn ghost" to={`/p/${pid}/graph`}>
              Add more documents
            </Link>
          </div>
        </div>
      )}
      {content.corpus?.ontology.revisionId !== report.data.base?.content.corpus?.ontology.revisionId && (
        <div className="banner warn">
          This update changes the pinned ontology to version {content.corpus?.ontology.number}. Inspect schema findings and any affected
          entities before saving.
        </div>
      )}
      {!!pending.length && (
        <div className="banner warn corpus-source-loss-summary">
          <div>
            <strong>
              {pending.length} {pending.length === 1 ? "fact" : "facts"} would lose source support.
            </strong>{" "}
            Review the proposed values and removals before saving. Independently supported and manual facts remain.
          </div>
          <div className="row-actions">
            <button
              className="btn ghost sm"
              onClick={() => {
                setFilter("removed");
                setSelected("");
              }}
            >
              Review removals
            </button>
            {editable && (
              <button
                className="btn ghost sm"
                disabled={losses.isPending}
                onClick={() => losses.mutate({ keys: pending.map((l) => l.key), decision: "remove" })}
              >
                Confirm all proposed removals
              </button>
            )}
          </div>
        </div>
      )}
      <section className="card">
        <div className="card-head">
          <h3>Graph changes and evidence</h3>
          <span className="muted">Only accepted facts appear in answers and exports.</span>
        </div>
        {editable && supported.length > 1 && (
          <div className="row-actions">
            <button className="btn ghost sm" onClick={() => acceptSupported(supported)}>
              Accept {supported.length} supported changes
            </button>
            <span className="field-hint">
              Located evidence, strong support checks, and no reported conflicts. Other changes remain for individual review.
            </span>
          </div>
        )}
        <div className="research-tabs" role="group" aria-label="Graph change filter">
          {(
            [
              ["changes", "Changes", changedRows.length],
              ["updated", "Updated values", changes.updated.length],
              ["added", "New", changes.added.length - changes.updated.length],
              ["enriched", "Support added", changes.enriched.length],
              ["reduced", "Support reduced", changes.reduced.length],
              ["reviewed", "Review decisions", changes.reviewed.length],
              ["removed", "Removed", changes.removed.length],
              ["review", "Needs review", changedRows.filter((f) => afterKeys.has(corpusFactKey(f)) && f.status === "candidate").length],
              ["conflicts", "Conflicts", conflicts.length],
              ["all", "All facts", 0],
            ] as const
          )
            .filter(([id, , count]) => id === "changes" || id === "all" || count > 0)
            .map(([id, label, count]) => (
              <button
                key={id}
                aria-pressed={chosenFilter === id}
                onClick={() => {
                  setFilter(id);
                  setSelected("");
                }}
              >
                {label}
                {id !== "all" ? ` · ${count}` : ""}
              </button>
            ))}
        </div>
        <div className="corpus-change-layout">
          <div className="corpus-claim-list" aria-label="Changed facts">
            {[...groups].map(([id, facts]) => (
              <section className="corpus-entity-group" key={id}>
                <div className="corpus-entity-heading">
                  <strong>{facts[0].label ?? id}</strong>
                  <StatusBadge tone={changes.addedEntities.includes(id) ? "info" : "ok"}>
                    {changes.addedEntities.includes(id) ? "New entity" : "Existing entity"}
                  </StatusBadge>
                </div>
                {facts.map((f) => (
                  <button key={corpusFactKey(f)} aria-pressed={f === fact} onClick={() => setSelected(corpusFactKey(f))}>
                    {describe(f)}
                    <br />
                    <small>
                      {!afterKeys.has(corpusFactKey(f)) ? "Proposed removal" : f.status} · {f.evidence.length} source passage
                      {f.evidence.length === 1 ? "" : "s"}
                    </small>
                  </button>
                ))}
              </section>
            ))}
            {!rows.length && (
              <p className="field-hint">No changes in this view. Existing facts remain in the graph; use All facts to inspect them.</p>
            )}
          </div>
          {fact && (
            <aside className="corpus-claim-detail" aria-label="Selected fact and evidence">
              <h3>{fact.label ?? fact.individualId}</h3>
              <p>{describe(fact)}</p>
              {changes.reduced.some((f) => corpusFactKey(f) === corpusFactKey(fact)) && (
                <p className="banner warn">Some previous source support was removed. Review the remaining evidence.</p>
              )}
              {sourceLoss && (
                <div className="corpus-value-change">
                  <p>
                    This fact lost its only document support. Remove it from the updated graph, or retain it explicitly as manual knowledge.
                  </p>
                  <div className="row-actions">
                    <button
                      className="btn"
                      disabled={!editable || losses.isPending}
                      onClick={() => losses.mutate({ keys: [sourceLoss.key], decision: "remove" })}
                    >
                      Confirm removal
                    </button>
                    <button
                      className="btn ghost"
                      disabled={!editable || losses.isPending}
                      onClick={() => losses.mutate({ keys: [sourceLoss.key], decision: "manual" })}
                    >
                      Keep as manual knowledge
                    </button>
                  </div>
                </div>
              )}
              {valueChange && (
                <div className="corpus-value-change">
                  <div>
                    <strong>Previous value</strong>
                    <p>{describe(valueChange.before)}</p>
                    {valueChange.before.evidence.map((ev, i) => (
                      <EvidenceItem
                        key={i}
                        ev={ev}
                        docName={ev.documentId ? viewer.names.get(ev.documentId) : undefined}
                        onOpen={viewer.open}
                      />
                    ))}
                  </div>
                  <div>
                    <strong>Proposed value</strong>
                    <p>{describe(valueChange.after)}</p>
                  </div>
                  {editable && pending.some((l) => l.key === corpusFactKey(valueChange.before)) && (
                    <>
                      <p className="field-hint">
                        The previous value lost its source support. Choose the proposed value, or keep the previous one as manual knowledge.
                      </p>
                      <div className="row-actions">
                        <button
                          className="btn"
                          disabled={replacementDecision.isPending}
                          onClick={() =>
                            replacementDecision.mutate({
                              beforeKey: corpusFactKey(valueChange.before),
                              afterKey: corpusFactKey(valueChange.after),
                              decision: "proposed",
                            })
                          }
                        >
                          Use proposed value
                        </button>
                        <button
                          className="btn ghost"
                          disabled={replacementDecision.isPending}
                          onClick={() =>
                            replacementDecision.mutate({
                              beforeKey: corpusFactKey(valueChange.before),
                              afterKey: corpusFactKey(valueChange.after),
                              decision: "previous",
                            })
                          }
                        >
                          Keep previous as manual knowledge
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <StatusBadge tone={fact.status === "accepted" ? "ok" : fact.status === "rejected" ? "alert" : "warn"}>
                {fact.status}
                {fact.by === "user"
                  ? " · human decision"
                  : fact.by === "auto"
                    ? fact.status === "candidate"
                      ? " · awaiting human review"
                      : " · assigned automatically"
                    : ""}
              </StatusBadge>
              {fact.evidence.map((ev, i) => (
                <EvidenceItem
                  key={i}
                  ev={ev}
                  docName={ev.documentId ? viewer.names.get(ev.documentId) : undefined}
                  onOpen={(ref) => void viewer.openFact(fact.key, ref)}
                />
              ))}
              {!fact.evidence.length && (
                <>
                  <p className="field-hint">No quoted evidence is recorded for this claim.</p>
                  <button className="btn ghost sm" type="button" onClick={() => void viewer.openFact(fact.key)}>
                    Inspect evidence
                  </button>
                </>
              )}
              {editable && afterKeys.has(corpusFactKey(fact)) && (
                <div className="row-actions">
                  <button className="btn ghost sm" onClick={() => decide("accepted")}>
                    Accept fact
                  </button>
                  <button className="btn ghost sm" onClick={() => decide("rejected")}>
                    Reject fact
                  </button>
                </div>
              )}
              {editable && ind && content.abox && working.tbox && (
                <details>
                  <summary>Entity details and manual corrections</summary>
                  <IndividualInspector
                    key={ind.id}
                    ind={ind}
                    abox={content.abox}
                    tbox={working.tbox}
                    issues={findings}
                    duplicates={[]}
                    docNames={viewer.names}
                    onSelect={selectEntity}
                    onFocus={selectEntity}
                    onOpenEvidence={(ev, key) => void viewer.openFact(key, ev)}
                    onInspectFact={(key) => void viewer.openFact(key)}
                    onChange={(next, label) =>
                      editable &&
                      working.setAbox(
                        { ...content.abox!, individuals: content.abox!.individuals.map((i) => (i.id === next.id ? next : i)) },
                        label,
                      )
                    }
                  />
                </details>
              )}
            </aside>
          )}
        </div>
      </section>
      {editable && (
        <>
          <details className="method-details">
            <summary>All fact review and earlier decisions</summary>
            <div className="method-details-body">
              <ReviewQueue content={content} onChange={update} onSelect={selectEntity} onInspect={(key) => void viewer.openFact(key)} />
            </div>
          </details>
          <MergePanel content={content} onChange={update} onSelect={selectEntity} />
        </>
      )}
      {!!unresolved.length && (
        <section className="card">
          <h3>Unresolved relationships · {unresolved.length}</h3>
          <p className="field-hint">
            Choose a target, create the missing entity, or leave the proposal for later. These proposals are retained across graph versions.
          </p>
          {unresolved.map((link) => (
            <UnresolvedCard
              key={link.id}
              link={link}
              content={content}
              onResolve={(body) => relationships.mutate(body)}
              busy={relationships.isPending || !editable}
            />
          ))}
        </section>
      )}
      <details className="method-details">
        <summary>Validation and schema findings</summary>
        <div className="method-details-body">
          <ValidationView pid={pid} revisionId={revisionId} showCommit={false} />
        </div>
      </details>
      {editable && (
        <div className="row-actions">
          <button className="btn ghost sm" disabled={!working.canUndo} onClick={working.undo}>
            Undo{working.undoLabel ? ` · ${working.undoLabel}` : ""}
          </button>
          <button className="btn ghost sm" disabled={!working.canRedo} onClick={working.redo}>
            Redo
          </button>
          <button
            className="btn"
            disabled={!!pending.length || report.data.stale || working.save === "error" || working.save === "conflict"}
            onClick={() => setSaving(true)}
          >
            {report.data.base?.number ? "Save graph update" : "Save knowledge graph"}
          </button>
        </div>
      )}
      <InlineError error={losses.error ?? relationships.error ?? replacementDecision.error ?? report.error} />
      {viewer.element}
      {saving && (
        <CommitDialog
          revision={working.revision ?? r}
          onClose={() => setSaving(false)}
          onCommitted={() => {
            invalidate();
            setParams(
              (p) => {
                const n = new URLSearchParams(p);
                n.set("rev", revisionId);
                return n;
              },
              { replace: true },
            );
          }}
        />
      )}
    </div>
  );
}
