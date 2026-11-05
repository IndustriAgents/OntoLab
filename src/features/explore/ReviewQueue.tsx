// Fact review: the facts extraction could not trust on its own — evidence
// below the threshold, no located quote, or a validation finding pointing at
// them — least certain first. Accept or reject each (keyboard: j/k to move,
// a to accept, r to reject). Decisions edit the working copy like every other
// change in Explore; rejected facts leave the graph, export and answers.

import { useMemo, useState, type KeyboardEvent } from "react";
import type { RevisionContent } from "../../types/project";
import type { FactStatus } from "../../types/abox";
import { applyDecisions, listFacts, type FactRow } from "../../lib/ontology/factReview";
import { localName } from "../../lib/ontology/iri";
import { StatusBadge } from "../../components/ui/ui";

interface Props {
  content: RevisionContent;
  onChange: (next: RevisionContent, label: string) => void;
  onSelect: (id: string) => void;
  onInspect?: (key: string) => void;
}

const SHOWN = 50;

function describe(f: FactRow): string {
  if (f.kind === "type") return `is a ${localName(f.classUri ?? "")}`;
  if (f.kind === "data") return `${localName(f.propUri ?? "")} = “${f.value}”`;
  return `${localName(f.propUri ?? "")} → ${f.targetId}`;
}

export function ReviewQueue({ content, onChange, onSelect, onInspect }: Props) {
  const facts = useMemo(() => (content.abox ? listFacts(content.abox) : []), [content.abox]);
  const [show, setShow] = useState<FactStatus>("candidate");
  const [cursor, setCursor] = useState(0);
  const counts = { candidate: 0, accepted: 0, rejected: 0 };
  for (const f of facts) counts[f.status]++;
  if (!counts.candidate && !counts.rejected) return null;

  const list = facts.filter((f) => f.status === show).sort((a, b) => (a.confidence ?? -1) - (b.confidence ?? -1));
  const shown = list.slice(0, SHOWN);
  const decide = (rows: FactRow[], status: FactStatus) => {
    if (!content.abox || !rows.length) return;
    const { abox } = applyDecisions(
      content.abox,
      rows.map((r) => ({ key: r.key, status })),
      new Date().toISOString(),
    );
    const verb = status === "accepted" ? "Accept" : status === "rejected" ? "Reject" : "Reopen";
    onChange(
      { ...content, abox },
      rows.length === 1 ? `${verb} ${rows[0].individualId} ${describe(rows[0])}` : `${verb} ${rows.length} facts`,
    );
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = shown[cursor];
    if (e.key === "j" || e.key === "ArrowDown") setCursor((c) => Math.min(shown.length - 1, c + 1));
    else if (e.key === "k" || e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (row && e.key === "a" && show !== "accepted") decide([row], "accepted");
    else if (row && e.key === "r" && show !== "rejected") decide([row], "rejected");
    else return;
    e.preventDefault();
  };

  return (
    <section className="card review-queue" aria-labelledby="rq-h">
      <div className="card-head">
        <h3 id="rq-h">Facts to review</h3>
        <span className="file">
          {counts.candidate} waiting · {counts.accepted} trusted · {counts.rejected} rejected
        </span>
      </div>
      <div className="tabbar" role="tablist" aria-label="Fact status">
        {(["candidate", "rejected"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={show === s}
            className={"tab" + (show === s ? " on" : "")}
            onClick={() => (setShow(s), setCursor(0))}
          >
            {s === "candidate" ? "Waiting" : "Rejected"}
            <span className="count">{counts[s]}</span>
          </button>
        ))}
      </div>
      {!shown.length ? (
        <p className="muted">{show === "candidate" ? "Nothing waits for review." : "No rejected facts."}</p>
      ) : (
        <div
          className="rq-list"
          role="listbox"
          tabIndex={0}
          onKeyDown={onKey}
          aria-label="Facts; j and k move, a accepts, r rejects"
          aria-activedescendant={shown[cursor] ? `rq-${cursor}` : undefined}
        >
          {shown.map((f, i) => (
            <div key={f.key} id={`rq-${i}`} role="option" aria-selected={i === cursor} className={"rq-row" + (i === cursor ? " on" : "")}>
              <div className="rq-fact">
                <button className="cite" onClick={() => onSelect(f.individualId)} title="Show in the graph and table">
                  {f.label ?? f.individualId}
                </button>{" "}
                {describe(f)}{" "}
                {f.confidence != null && (
                  <StatusBadge
                    tone={f.confidence >= 0.8 ? "ok" : f.confidence >= 0.5 ? "warn" : "alert"}
                    title="Entailment of the claim by its quote"
                  >
                    {Math.round(f.confidence * 100)}%
                  </StatusBadge>
                )}
                {f.reason && <div className="row-sub">{f.reason}</div>}
                {f.evidence[0]?.quote && <blockquote className="quote">{f.evidence[0].quote}</blockquote>}
              </div>
              <div className="rq-actions">
                {onInspect && (
                  <button className="btn ghost sm" type="button" onClick={() => onInspect(f.key)}>
                    Inspect evidence
                  </button>
                )}
                {show !== "accepted" && (
                  <button className="btn ghost sm" onClick={() => decide([f], "accepted")}>
                    Accept
                  </button>
                )}
                {show !== "rejected" ? (
                  <button className="btn ghost sm" onClick={() => decide([f], "rejected")}>
                    Reject
                  </button>
                ) : (
                  <button className="btn ghost sm" onClick={() => decide([f], "candidate")}>
                    Reopen
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {show === "candidate" && shown.length > 0 && (
        <div className="row-actions">
          <button className="btn ghost sm" onClick={() => decide(shown, "accepted")}>
            Accept the {shown.length} shown
          </button>
          {list.length > SHOWN && <span className="muted">{list.length - SHOWN} more after these</span>}
        </div>
      )}
    </section>
  );
}
