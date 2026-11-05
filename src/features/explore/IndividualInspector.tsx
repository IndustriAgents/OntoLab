import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useProject } from "../../app/project";
import type { ABoxIndividual, ABoxResult, EvidenceRef, FactReview, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";
import { localName } from "../../lib/ontology/iri";
import { factKey } from "../../lib/ontology/factReview";
import { legacyList } from "./evidenceUtil";
import { EvidenceItem } from "../documents/DocumentViewer";
import { StatusBadge, fmtDate } from "../../components/ui/ui";
import { ClassPicker, DataFacts, LinkFacts, MissingSlots } from "../../components/review/FactEditors";

interface Props {
  ind: ABoxIndividual;
  abox: ABoxResult;
  tbox: TBoxModel;
  issues: ValidationIssue[];
  duplicates: string[];
  docNames: Map<string, string>;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onOpenEvidence: (ev: EvidenceRef, key: string) => void;
  onInspectFact?: (key: string) => void;
  onChange: (next: ABoxIndividual, label: string) => void;
}

function ClaimEvidence({
  evidence,
  docNames,
  onOpen,
}: {
  evidence?: EvidenceRef[];
  docNames: Map<string, string>;
  onOpen: (e: EvidenceRef) => void;
}) {
  if (!evidence?.length) return <span className="muted small">No source quote</span>;
  return (
    <>
      {evidence.map((e, i) => (
        <EvidenceItem key={i} ev={e} docName={e.documentId ? docNames.get(e.documentId) : undefined} onOpen={onOpen} />
      ))}
    </>
  );
}

/** Review state of one fact; trusted facts without a decision show nothing. */
function FactBadge({ review }: { review?: FactReview }) {
  if (!review || (review.status === "accepted" && review.by === "auto")) return null;
  const tone = review.status === "accepted" ? "ok" : review.status === "rejected" ? "alert" : "warn";
  const edited = review.editedBy != null;
  const text =
    review.status === "candidate" ? "to review" : review.status === "rejected" ? "rejected" : edited ? "edited by hand" : "accepted";
  const who = edited
    ? `entered or changed by ${review.editedBy}${review.at ? ` · ${fmtDate(review.at)}` : ""}`
    : review.by === "user"
      ? "decided by a person"
      : undefined;
  return (
    <span className="fact-badge">
      <StatusBadge tone={tone} title={review.reason ?? who}>
        {text}
      </StatusBadge>
    </span>
  );
}

export function IndividualInspector({
  ind,
  abox,
  tbox,
  issues,
  duplicates,
  docNames,
  onSelect,
  onFocus,
  onOpenEvidence,
  onInspectFact,
  onChange,
}: Props) {
  const [label, setLabel] = useState(ind.label ?? "");
  const { pid } = useProject();
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const patch = (p: Partial<ABoxIndividual>, what: string) => onChange({ ...ind, ...p }, what);
  useEffect(() => {
    setLabel(ind.label ?? "");
  }, [ind.id, ind.label]);
  const byId = new Map(abox.individuals.map((i) => [i.id, i]));
  const incoming = abox.individuals.flatMap((i) =>
    (i.objectProperties ?? []).filter((o) => o.targetId === ind.id).map((o) => ({ from: i, prop: o.propUri })),
  );
  const classLabel = (uri: string) => tbox.classes.find((c) => c.uri === uri)?.label ?? localName(uri);

  return (
    <div className="ind-inspector">
      <div className="field">
        <label htmlFor="insp-label">Label</label>
        <input
          id="insp-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== (ind.label ?? "") && onChange({ ...ind, label }, "Rename individual")}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <dl className="kv-list">
        <dt>Identifier</dt>
        <dd className="mono-sm">{ind.id}</dd>
        <dt>Class</dt>
        <dd>
          {editing ? (
            <ClassPicker
              className="ed-select sm"
              value={ind.classUri}
              tbox={tbox}
              ariaLabel="Class"
              onChange={(uri) => patch({ classUri: uri }, "Change class")}
            />
          ) : (
            classLabel(ind.classUri)
          )}
          {(ind.additionalTypes ?? []).map((t) => (
            <span key={t}> · {classLabel(t)}</span>
          ))}
        </dd>
        {ind.sameAs?.length ? (
          <>
            <dt>Same as</dt>
            <dd>
              {ind.sameAs.map((iri) => (
                <a key={iri} href={iri} target="_blank" rel="noreferrer" className="mono-sm">
                  {iri.replace(/^https?:\/\/(www\.)?/, "")}
                </a>
              ))}
            </dd>
          </>
        ) : null}
        {ind.mergedFrom?.length ? (
          <>
            <dt>Merged from</dt>
            <dd className="mono-sm">{ind.mergedFrom.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      <div className="row-actions">
        <button className="btn ghost sm" onClick={() => onFocus(ind.id)}>
          Focus neighbourhood
        </button>
        <button className={"btn sm" + (editing ? "" : " ghost")} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit facts"}
        </button>
      </div>

      {editing && (
        <section aria-label="Edit facts" className="ind-edit">
          <p className="small muted">
            Choices follow the ontology: properties whose domain fits this class, targets whose class fits the range. Each change is checked
            as you make it.
          </p>
          <MissingSlots ind={ind} tbox={tbox} abox={abox} onPatch={patch} />
          <h3 className="sec-label">Values</h3>
          <DataFacts ind={ind} tbox={tbox} showAll={showAll} onPatch={patch} />
          <h3 className="sec-label">Relations</h3>
          <LinkFacts ind={ind} tbox={tbox} abox={abox} showAll={showAll} onPatch={patch} />
          <label className="check small">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Offer all properties and targets
          </label>
          <p className="small muted">
            Missing a class or property? <Link to={`/p/${pid}/ontology?tab=terms&new=class`}>Add it to the ontology</Link>
          </p>
        </section>
      )}

      {issues.length > 0 && (
        <section aria-label="Findings">
          <h3 className="sec-label">Findings</h3>
          <ul className="issue-mini">
            {issues.map((i, n) => (
              <li key={n}>
                <StatusBadge tone={i.severity === "error" ? "alert" : "warn"}>{i.severity === "error" ? "Error" : "Warning"}</StatusBadge>{" "}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {duplicates.length > 0 && (
        <section aria-label="Possible duplicates">
          <h3 className="sec-label">Possible duplicates</h3>
          <p className="small muted">
            Same or similar name, different identifier. They stay separate until you merge them (Review duplicates) or remove one.
          </p>
          {duplicates.map((id) => (
            <button key={id} className="cite" onClick={() => onSelect(id)}>
              {byId.get(id)?.label ?? id}
            </button>
          ))}
        </section>
      )}

      <section aria-label="Evidence">
        <h3 className="sec-label">
          Evidence
          <FactBadge review={ind.review} />
        </h3>
        <ClaimEvidence evidence={legacyList(ind)} docNames={docNames} onOpen={(ev) => onOpenEvidence(ev, factKey(ind.id, "type"))} />
        {onInspectFact && !legacyList(ind).some((ev) => ev.documentId) && (
          <button className="btn ghost sm" type="button" onClick={() => onInspectFact(factKey(ind.id, "type"))}>
            Inspect evidence
          </button>
        )}
      </section>

      <section aria-label="Values">
        <h3 className="sec-label">Values ({ind.dataProperties?.length ?? 0})</h3>
        {(ind.dataProperties ?? []).map((d, i) => (
          <div className="claim" key={i}>
            <div className="claim-head">
              <span className="k">{localName(d.propUri)}</span>
              <span className="v">
                {d.value}
                {d.lang ? `@${d.lang}` : ""}
              </span>
              <FactBadge review={d.review} />
            </div>
            {d.evidence?.length ? (
              <ClaimEvidence evidence={d.evidence} docNames={docNames} onOpen={(ev) => onOpenEvidence(ev, factKey(ind.id, "data", d))} />
            ) : (
              onInspectFact && (
                <button className="btn ghost sm" type="button" onClick={() => onInspectFact(factKey(ind.id, "data", d))}>
                  Inspect evidence
                </button>
              )
            )}
          </div>
        ))}
      </section>

      <section aria-label="Relations">
        <h3 className="sec-label">Relations ({(ind.objectProperties?.length ?? 0) + incoming.length})</h3>
        {(ind.objectProperties ?? []).map((o, i) => (
          <div className="claim" key={`o${i}`}>
            <div className="claim-head">
              <span className="k">{localName(o.propUri)} →</span>
              <button className="cite" onClick={() => onSelect(o.targetId)}>
                {byId.get(o.targetId)?.label ?? o.targetId}
              </button>
              <FactBadge review={o.review} />
            </div>
            {o.evidence?.length ? (
              <ClaimEvidence evidence={o.evidence} docNames={docNames} onOpen={(ev) => onOpenEvidence(ev, factKey(ind.id, "link", o))} />
            ) : (
              onInspectFact && (
                <button className="btn ghost sm" type="button" onClick={() => onInspectFact(factKey(ind.id, "link", o))}>
                  Inspect evidence
                </button>
              )
            )}
          </div>
        ))}
        {incoming.map((r, i) => (
          <div className="claim" key={`i${i}`}>
            <div className="claim-head">
              <button className="cite" onClick={() => onSelect(r.from.id)}>
                {r.from.label ?? r.from.id}
              </button>
              <span className="k">→ {localName(r.prop)}</span>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
