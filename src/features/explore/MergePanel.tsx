// Merge review (B3): the duplicate candidates entity resolution found, each with
// why it thinks so — a shared Wikidata/GeoNames/UMLS identifier, matching
// names, close meaning, or the model's reason. Nothing is merged until a person
// says so; "Merge" moves every claim, its evidence and the incoming links to the
// kept individual, and Undo takes it back.

import { useState } from "react";
import type { ABoxResult } from "../../types/abox";
import type { MergeCandidate, RevisionContent } from "../../types/project";
import { applyMerge, displayName } from "../../lib/ontology/resolution";
import { localName } from "../../lib/ontology/iri";
import { StatusBadge } from "../../components/ui/ui";

const METHOD: Record<MergeCandidate["method"], string> = {
  grounding: "same external identifier",
  label: "matching names",
  embedding: "similar meaning",
  llm: "model's judgement",
};

interface Props {
  content: RevisionContent;
  onChange: (next: RevisionContent, label: string) => void;
  onSelect: (id: string) => void;
}

export function MergePanel({ content, onChange, onSelect }: Props) {
  const all = content.resolution?.candidates ?? [];
  const abox: ABoxResult = content.abox ?? { individuals: [] };
  const byId = new Map(abox.individuals.map((i) => [i.id, i]));
  // Candidates whose individuals no longer all exist (merged or deleted since) are stale.
  const live = all.filter((c) => c.ids.filter((id) => byId.has(id)).length >= 2);
  const [showDistinct, setShowDistinct] = useState(false);
  const [keep, setKeep] = useState<Record<string, string>>({});
  if (!live.length) return null;
  const recommended = live.filter((c) => c.decision === "merge");
  const shown = live.filter((c) => showDistinct || c.decision !== "distinct");

  const merge = (cands: MergeCandidate[]) => {
    let next = abox;
    const gone = new Set<string>();
    for (const c of cands) {
      const ids = c.ids.filter((id) => !gone.has(id) && next.individuals.some((i) => i.id === id));
      const k = keep[c.id] && ids.includes(keep[c.id]) ? keep[c.id] : ids[0];
      const order = [k, ...ids.filter((id) => id !== k)];
      if (order.length < 2) continue;
      next = applyMerge(next, order).abox;
      for (const id of order.slice(1)) gone.add(id);
    }
    const done = new Set(cands.map((c) => c.id));
    onChange({ ...content, abox: next, resolution: { candidates: all.filter((c) => !done.has(c.id)) } }, cands.length === 1 ? `Merge ${cands[0].label}` : `Merge ${cands.length} duplicates`);
  };
  const keepSeparate = (c: MergeCandidate) =>
    onChange({ ...content, resolution: { candidates: all.map((x) => (x.id === c.id ? { ...x, decision: "distinct" as const, explanation: `${x.explanation}; kept separate by a reviewer` } : x)) } }, `Keep ${c.label} separate`);

  return (
    <section className="merge-panel card" aria-labelledby="merge-h">
      <div className="card-head">
        <h3 id="merge-h">Possible duplicates</h3>
        <span className="file">
          {recommended.length} recommended · {live.length - recommended.length} to check
        </span>
      </div>
      <div className="row-actions">
        {recommended.length > 0 && (
          <button className="btn sm" onClick={() => merge(recommended)}>
            Merge {recommended.length} recommended
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={showDistinct} onChange={(e) => setShowDistinct(e.target.checked)} /> Show pairs judged different
        </label>
      </div>
      <ul className="merge-list">
        {shown.map((c) => {
          const members = c.ids.filter((id) => byId.has(id));
          return (
            <li key={c.id} className={`merge-${c.decision}`}>
              <div className="merge-head">
                <StatusBadge tone={c.decision === "merge" ? "ok" : c.decision === "distinct" ? "muted" : "info"}>
                  {c.decision === "merge" ? "recommended" : c.decision === "distinct" ? "different" : "unsure"}
                </StatusBadge>
                <span className="muted">
                  {METHOD[c.method]} · {Math.round(c.score * 100)}%
                </span>
              </div>
              <div className="merge-members" role="radiogroup" aria-label="Individual to keep">
                {members.map((id) => {
                  const ind = byId.get(id)!;
                  return (
                    <label key={id} className="merge-member">
                      <input type="radio" name={`keep-${c.id}`} checked={(keep[c.id] ?? members[0]) === id} onChange={() => setKeep((k) => ({ ...k, [c.id]: id }))} />
                      <button type="button" className="cite" onClick={() => onSelect(id)}>
                        {displayName(ind)}
                      </button>
                      <span className="muted small">
                        {localName(ind.classUri)} · {(ind.dataProperties?.length ?? 0) + (ind.objectProperties?.length ?? 0)} claims
                        {ind.sameAs?.length ? " · grounded" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="row-sub">{c.explanation}</div>
              <div className="row-actions">
                <button className="btn ghost sm" onClick={() => merge([c])}>
                  Merge into the selected one
                </button>
                {c.decision !== "distinct" && (
                  <button className="btn ghost sm" onClick={() => keepSeparate(c)}>
                    Keep separate
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
