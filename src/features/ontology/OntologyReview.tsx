// Review an ontology revision (usually an induced or imported draft) before it
// is committed: what it contains, where its terms come from, the axioms the
// reasoner admitted, the modelling pitfalls a scan finds, an advisory semantic
// review by a model, terms that could reuse an existing vocabulary, and
// alignment with an imported standard. Changes land in a draft; Commit makes it the project's ontology and
// reports how many competency questions it can answer.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject, tboxFromModules } from "../../app/project";
import { useModelChoice } from "../../app/providers";
import { api, qk, type Pitfall } from "../../lib/projectApi";
import type { RevisionWithContent, SemanticFinding } from "../../types/project";
import { localName } from "../../lib/ontology/iri";
import { ConfirmButton, EmptyState, ErrorState, InlineError, LoadingState, StatusBadge } from "../../components/ui/ui";
import { revisionLabel } from "../revisions/RevisionBar";
import { useEvidenceViewer } from "../evidence/useEvidence";

const SEV_TONE = { critical: "alert", important: "warn", minor: "muted" } as const;

function Pitfalls({ rev }: { rev: RevisionWithContent }) {
  const { pid } = useProject();
  const q = useQuery({ queryKey: qk.pitfalls(pid, rev.id, rev.contentHash), queryFn: () => api.pitfalls(pid, rev.id) });
  const before = rev.content.review?.pitfallsBefore;
  const list = q.data ?? [];
  const counts = {
    critical: list.filter((p) => p.severity === "critical").length,
    important: list.filter((p) => p.severity === "important").length,
    minor: list.filter((p) => p.severity === "minor").length,
  };
  return (
    <section className="card" aria-labelledby="rv-pit">
      <div className="card-head">
        <h3 id="rv-pit">Modelling pitfalls</h3>
        <span className="file">
          {counts.critical} critical · {counts.important} important · {counts.minor} minor
        </span>
      </div>
      {before && (
        <p className="muted">
          Before the automatic repair: {before.critical} critical, {before.important} important.
        </p>
      )}
      {q.isLoading ? (
        <LoadingState label="Scanning…" />
      ) : q.error ? (
        <InlineError error={q.error} />
      ) : !list.length ? (
        <p className="muted">No pitfalls found.</p>
      ) : (
        <ul className="finding-list">
          {list.map((p: Pitfall, i) => (
            <li key={`${p.code}-${p.subject}-${i}`}>
              <StatusBadge tone={SEV_TONE[p.severity]}>{p.severity}</StatusBadge> <b>{p.title}</b>{" "}
              <span className="muted mono-sm">{p.code}</span>
              <div>{p.message}</div>
              <div className="row-sub">Fix: {p.fix}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Fix pitfalls in “Modules &amp; changes” (edit the module) or with an AI change instruction; the scan runs again on the new draft.
      </p>
    </section>
  );
}

/** Where the induced terms were found, ungrounded first (the hallucination check). */
function Grounding({ rev }: { rev: RevisionWithContent }) {
  const { pid } = useProject();
  const viewer = useEvidenceViewer(pid);
  const ev = rev.content.review?.termEvidence ?? [];
  const axioms = rev.content.review?.axioms;
  if (!ev.length && !axioms) return null;
  const missing = ev.filter((e) => !e.located);
  return (
    <section className="card" aria-labelledby="rv-ground">
      <div className="card-head">
        <h3 id="rv-ground">Sources and axioms</h3>
        {ev.length > 0 && (
          <span className="file">
            {ev.length - missing.length} of {ev.length} terms found in the documents
          </span>
        )}
      </div>
      {missing.length > 0 && (
        <>
          <p className="field-hint">
            No supporting passage could be found for these terms. They may be invented — check them before committing.
          </p>
          <ul className="finding-list">
            {missing.map((e) => (
              <li key={e.term}>
                <StatusBadge tone="warn">unsupported</StatusBadge> <b>{e.term}</b> <span className="muted">{e.kind}</span>
                {e.quote && <div className="row-sub">Quoted as: “{e.quote}”</div>}
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={() => viewer.openTarget({ kind: "term", revisionId: rev.id, termId: `${e.kind}:${e.term}` })}
                >
                  Inspect evidence
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {ev.length > missing.length && (
        <details>
          <summary>Supported terms ({ev.length - missing.length})</summary>
          <ul className="finding-list">
            {ev
              .filter((e) => e.located)
              .map((e) => (
                <li key={e.term}>
                  <b>{e.term}</b> <span className="muted">{e.kind}</span>
                  <div className="row-sub">“{e.quote}”</div>
                  <button
                    className="btn ghost sm"
                    type="button"
                    onClick={() => viewer.openTarget({ kind: "term", revisionId: rev.id, termId: `${e.kind}:${e.term}` })}
                  >
                    Inspect evidence
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
      {axioms && (
        <>
          <div className="sec-label">Axioms</div>
          <p className="muted">
            {axioms.accepted.length} kept · {axioms.rejected.length} turned down by the reasoner
          </p>
          {axioms.accepted.length > 0 && (
            <div className="chip-list">
              {axioms.accepted.map((a) => (
                <span className="chip" key={a}>
                  {a}
                </span>
              ))}
            </div>
          )}
          {axioms.rejected.length > 0 && (
            <ul className="finding-list">
              {axioms.rejected.map((a) => (
                <li key={a.axiom}>
                  <StatusBadge tone="muted">rejected</StatusBadge> {a.axiom} <span className="muted">— {a.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const KIND_LABEL: Record<SemanticFinding["kind"], string> = {
  hierarchy: "hierarchy",
  definition: "definition",
  "domain-range": "domain / range",
  naming: "naming",
  redundancy: "redundancy",
};

/** A model reads the definitions for mistakes a reasoner cannot see. Advisory only. */
function SemanticReview({ rev }: { rev: RevisionWithContent }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const key = ["semantic-review", pid, rev.id, rev.contentHash];
  const stored = useQuery({ queryKey: key, queryFn: () => api.semanticReview(pid, rev.id) });
  const run = useMutation({
    mutationFn: () => api.runSemanticReview(pid, rev.id, { provider: choice.provider, model: choice.model }),
    onSuccess: (f) => qc.setQueryData(key, f),
  });
  const list = stored.data ?? null;
  return (
    <section className="card" aria-labelledby="rv-sem">
      <div className="card-head">
        <h3 id="rv-sem">Semantic review</h3>
        <button className="btn ghost sm" onClick={() => run.mutate()} disabled={run.isPending || !choice.providerEnabled}>
          {run.isPending ? "Reviewing…" : list ? "Review again" : "Review with the model"}
        </button>
      </div>
      <p className="field-hint">
        A reasoner accepts “University is a kind of Person” unless another axiom contradicts it. The model reads names, definitions and
        source quotes for such mistakes. Its findings are suggestions.
      </p>
      <InlineError error={stored.error ?? run.error} />
      {list === null ? (
        <p className="muted">Not reviewed yet.</p>
      ) : !list.length ? (
        <p className="muted">No semantic problems found.</p>
      ) : (
        <ul className="finding-list">
          {list.map((f) => (
            <li key={f.id}>
              <StatusBadge tone={f.severity === "important" ? "warn" : "muted"}>{f.severity}</StatusBadge> <b>{localName(f.subject)}</b>{" "}
              <span className="muted mono-sm">{KIND_LABEL[f.kind]}</span>
              <div>{f.message}</div>
              {f.fix && <div className="row-sub">Fix: {f.fix}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Reuse({ rev, onChanged }: { rev: RevisionWithContent; onChanged: (id: string) => void }) {
  const { pid } = useProject();
  const [lookup, setLookup] = useState(false);
  const fresh = useQuery({
    queryKey: ["reuse", pid, rev.id, rev.contentHash],
    queryFn: () => api.reuseSuggestions(pid, rev.id),
    enabled: lookup,
    staleTime: Infinity,
    retry: false,
  });
  const list = lookup ? (fresh.data ?? []) : (rev.content.review?.reuse ?? []);
  const accept = useMutation({
    mutationFn: (x: { term: string; iri: string; kind: "class" | "property" }) => api.acceptReuse(pid, rev.id, x),
    onSuccess: (r) => onChanged(r.id),
  });
  return (
    <section className="card" aria-labelledby="rv-reuse">
      <div className="card-head">
        <h3 id="rv-reuse">Reuse existing vocabulary</h3>
        <button className="btn ghost sm" onClick={() => setLookup(true)} disabled={fresh.isFetching}>
          {fresh.isFetching ? "Looking up…" : "Look up now"}
        </button>
      </div>
      <p className="field-hint">
        Terms that already exist in LOV, schema.org or BioPortal. Accepting adds an equivalence axiom, so data stays interoperable without
        renaming.
      </p>
      <InlineError error={fresh.error ?? accept.error} />
      {!list.length ? (
        <p className="muted">{lookup && !fresh.isFetching ? "No reusable terms found." : "No suggestions yet."}</p>
      ) : (
        <ul className="finding-list">
          {list.map((s) => (
            <li key={s.term}>
              <b>{localName(s.term)}</b> {s.status === "accepted" && <StatusBadge tone="ok">accepted</StatusBadge>}
              <ul className="sub-list">
                {s.candidates.map((c) => (
                  <li key={c.iri}>
                    <a href={c.iri} target="_blank" rel="noreferrer">
                      {c.vocabulary ? `${c.vocabulary}:` : ""}
                      {c.label}
                    </a>{" "}
                    <span className="muted">
                      {c.source} · {c.score.toFixed(2)}
                    </span>{" "}
                    {s.status !== "accepted" && (
                      <button
                        className="btn ghost sm"
                        disabled={accept.isPending}
                        onClick={() => accept.mutate({ term: s.term, iri: c.iri, kind: s.kind })}
                      >
                        Reuse
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Alignment({ rev }: { rev: RevisionWithContent }) {
  const { pid } = useProject();
  const mappings = rev.content.review?.alignment ?? [];
  return (
    <section className="card" aria-labelledby="rv-align">
      <div className="card-head">
        <h3 id="rv-align">Align ontologies</h3>
      </div>
      <p className="field-hint">
        Compare this ontology with a standard. Review definitions, mapping alternatives and logical consequences in the alignment workspace.
        Your setup and decisions stay with the draft.
      </p>
      {!!mappings.length && (
        <p>
          {mappings.filter((m) => m.status === "accepted").length} accepted mappings ·{" "}
          {mappings.filter((m) => !m.status || m.status === "open").length} awaiting review
        </p>
      )}
      <Link className="btn sm" to={`/p/${pid}/workflows/alignment?rev=${rev.id}&step=${mappings.length ? "merge" : "sources"}`}>
        Open alignment workspace →
      </Link>
    </section>
  );
}

function Contents({ rev }: { rev: RevisionWithContent }) {
  const tbox = useMemo(() => tboxFromModules(rev.content.modules, rev.content.baseIri), [rev]);
  if (!tbox) return <p className="muted">This revision has no parseable module.</p>;
  const parentsOf = (uri: string) => (tbox.subClassOf[uri] ?? []).map(localName).join(", ");
  return (
    <section className="card span-2" aria-labelledby="rv-contents">
      <div className="card-head">
        <h3 id="rv-contents">Contents</h3>
        <span className="file">
          {tbox.classes.length} classes · {tbox.objectProps.length} relations · {tbox.dataProps.length} attributes ·{" "}
          {rev.content.modules.map((m) => m.name).join(", ")}
        </span>
      </div>
      <details open={tbox.classes.length <= 40}>
        <summary>Classes</summary>
        <table className="data-table compact">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Subclass of</th>
              <th scope="col">Definition</th>
            </tr>
          </thead>
          <tbody>
            {tbox.classes.map((c) => (
              <tr key={c.uri}>
                <td>{c.label ?? localName(c.uri)}</td>
                <td>{parentsOf(c.uri)}</td>
                <td className="row-sub">{c.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details>
        <summary>Properties</summary>
        <table className="data-table compact">
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
            </tr>
          </thead>
          <tbody>
            {[...tbox.objectProps, ...tbox.dataProps].map((p) => (
              <tr key={p.uri}>
                <td>{p.label ?? localName(p.uri)}</td>
                <td>{p.domain.map(localName).join(", ") || "—"}</td>
                <td>{p.range.map(localName).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function OntologyReview({ revisionId }: { revisionId: string | null }) {
  const { pid, project, drafts, select } = useProject();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id =
    revisionId ?? drafts.find((d) => d.source === "induction" || d.source === "ontology")?.id ?? project?.currentRevisionId ?? null;
  const rev = useQuery({ queryKey: qk.revision(pid, id ?? "none"), queryFn: () => api.getRevision(pid, id!), enabled: !!id });
  const goTo = (rid: string) => {
    void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
    void qc.invalidateQueries({ queryKey: qk.revision(pid, rid) });
    navigate(`/p/${pid}/ontology?tab=review&rev=${rid}`, { replace: true });
  };
  const commit = useMutation({
    // the impact report above is the review of this draft's warnings; errors still refuse the commit
    mutationFn: () => api.commitWithReport(pid, id!, { acknowledgedWarnings: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      void qc.invalidateQueries({ queryKey: qk.projects });
      select(null);
    },
  });
  const discard = useMutation({
    mutationFn: () => api.discardDraft(pid, id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      navigate(`/p/${pid}/ontology`);
    },
  });

  if (!id) return <EmptyState title="Nothing to review">Build an ontology from your documents or import one first.</EmptyState>;
  if (rev.isLoading) return <LoadingState label="Loading ontology version…" />;
  if (rev.error || !rev.data) return <ErrorState error={rev.error} onRetry={() => void rev.refetch()} />;
  const r = rev.data;
  const report = commit.data?.report;
  return (
    <div className="review-layout">
      <section className="card span-2" aria-labelledby="rv-h">
        <div className="card-head">
          <h3 id="rv-h">{revisionLabel(r)}</h3>
          {r.status === "draft" ? <StatusBadge tone="info">Draft</StatusBadge> : <StatusBadge tone="ok">Version saved</StatusBadge>}
        </div>
        <p>{r.summary}</p>
        {r.status === "draft" && (
          <div className="row-actions">
            <button className="btn" disabled={commit.isPending} onClick={() => commit.mutate()}>
              {commit.isPending ? "Saving…" : "Save version"}
            </button>
            <ConfirmButton
              label="Discard draft"
              confirmLabel="Discard permanently"
              onConfirm={() => discard.mutate()}
              disabled={discard.isPending}
            />
          </div>
        )}
        {commit.isSuccess && (
          <div className="banner subtle">
            Saved as version {commit.data.revision.number}.
            {report?.cqPassRate != null
              ? ` Competency-question check pass rate: ${Math.round(report.cqPassRate * 100)}%. Review the query results to assess the answers.`
              : " Translate competency questions to SPARQL on the Overview page to check them."}{" "}
            <Link to={`/p/${pid}/runs`}>Extract the knowledge graph next</Link>.
          </div>
        )}
        <InlineError error={commit.error ?? discard.error} />
      </section>
      <Contents rev={r} />
      <Grounding rev={r} />
      <Pitfalls rev={r} />
      <SemanticReview rev={r} />
      <Reuse rev={r} onChanged={goTo} />
      <Alignment rev={r} />
    </div>
  );
}
