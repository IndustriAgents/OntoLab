import { memo, useEffect, useMemo, useState } from "react";
import { IconUpload, IconSearch } from "../icons";
import { localName } from "../../lib/ontology/iri";
import { CommitInput, ClassPicker, DataFacts, LinkFacts, MissingSlots } from "./FactEditors";
import type { ABoxResult, ABoxIndividual, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";

interface RowProps {
  ind: ABoxIndividual;
  tbox: TBoxModel;
  abox: ABoxResult;
  issues: ValidationIssue[];
  selected: boolean;
  showAll: boolean;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ABoxIndividual>, label?: string) => void;
  onRemove: (id: string) => void;
}

const Row = memo(function Row({ ind, tbox, abox, issues, selected, showAll, onSelect, onPatch, onRemove }: RowProps) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.length - errors;
  const patch = (p: Partial<ABoxIndividual>, label: string) => onPatch(ind.id, p, label);

  return (
    <tr id={`row-${ind.id}`} className={selected ? "is-selected" : ""} onClick={() => onSelect(ind.id)}>
      <td data-label="Individual">
        <CommitInput
          className="ed-input"
          value={ind.label ?? ""}
          placeholder="label"
          ariaLabel={`Label for ${ind.id}`}
          onCommit={(v) => onPatch(ind.id, { label: v }, "Rename individual")}
        />
        <div className="ind-id">
          {ind.id}
          {issues.length > 0 && (
            <span className={"row-badge" + (errors ? " error" : "")} title={issues.map((i) => i.message).join("\n")}>
              {errors ? `${errors} error${errors === 1 ? "" : "s"}` : `${warns} warning${warns === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
      </td>

      <td data-label="Class">
        <ClassPicker value={ind.classUri} tbox={tbox} ariaLabel={`Class of ${ind.id}`} onChange={(uri) => onPatch(ind.id, { classUri: uri }, "Change class")} />
        <MissingSlots ind={ind} tbox={tbox} abox={abox} onPatch={patch} />
      </td>

      <td data-label="Data properties">
        <DataFacts ind={ind} tbox={tbox} showAll={showAll} onPatch={patch} />
      </td>

      <td data-label="Relations">
        <LinkFacts ind={ind} tbox={tbox} abox={abox} showAll={showAll} onPatch={patch} />
      </td>

      <td className="ed-rowx">
        <button className="ed-x big" title={`Remove ${ind.label || ind.id}`} aria-label={`Remove ${ind.label || ind.id}`} onClick={() => onRemove(ind.id)}>
          ×
        </button>
      </td>
    </tr>
  );
});

interface Props {
  abox: ABoxResult;
  tbox: TBoxModel;
  issues: ValidationIssue[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (next: ABoxResult, label?: string) => void;
  /** show only these rows (filters applied elsewhere); edits still apply to the whole A-Box */
  restrictTo?: Set<string> | null;
}

export function AboxEditor({ abox, tbox, issues, selectedId, onSelect, onChange, restrictTo }: Props) {
  const inds = abox.individuals;
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  const set = (next: ABoxIndividual[], label?: string) => onChange({ individuals: next }, label);
  const patch = (id: string, p: Partial<ABoxIndividual>, label = "Edit individual") => set(inds.map((i) => (i.id === id ? { ...i, ...p } : i)), label);
  const remove = (id: string) => set(inds.filter((i) => i.id !== id), "Remove individual");

  const add = () => {
    const ids = new Set(inds.map((i) => i.id));
    let n = inds.length + 1;
    let id = `individual-${n}`;
    while (ids.has(id)) id = `individual-${++n}`;
    set([{ id, classUri: tbox.classes[0]?.uri ?? "", label: "", dataProperties: [], objectProperties: [] }, ...inds], "Add individual");
  };

  const issuesById = useMemo(() => {
    const map = new Map<string, ValidationIssue[]>();
    for (const iss of issues) {
      if (!iss.id) continue;
      const arr = map.get(iss.id) ?? [];
      arr.push(iss);
      map.set(iss.id, arr);
    }
    return map;
  }, [issues]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const pool = restrictTo ? inds.filter((i) => restrictTo.has(i.id)) : inds;
    if (!q) return pool;
    return pool.filter(
      (i) =>
        i.id.toLowerCase().includes(q) ||
        (i.label ?? "").toLowerCase().includes(q) ||
        localName(i.classUri).toLowerCase().includes(q) ||
        (i.dataProperties ?? []).some((d) => d.value.toLowerCase().includes(q)),
    );
  }, [inds, filter, restrictTo]);

  // Bring a selection made elsewhere (graph, issue list) into view.
  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(`row-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div className="abox-editor">
      <div className="ed-toolbar">
        <button className="btn" onClick={add}>
          <IconUpload /> Add individual
        </button>
        <label className="ed-filter">
          <IconSearch className="ed-filter-icon" />
          <input value={filter} placeholder="Filter individuals…" aria-label="Filter individuals" onChange={(e) => setFilter(e.target.value)} />
        </label>
        <label className="check" title="Offer every property and target, not only those the ontology's domains and ranges allow">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All properties
        </label>
        <span className="ed-count">
          {visible.length !== inds.length ? `${visible.length} of ${inds.length}` : `${inds.length}`} individual{inds.length === 1 ? "" : "s"}
        </span>
      </div>

      {inds.length === 0 && <div className="empty-note">No individuals. Use “Add individual”, run an extraction, or ask the assistant to propose some.</div>}
      {inds.length > 0 && visible.length === 0 && <div className="empty-note">No individuals match the current filters.</div>}

      {visible.length > 0 && (
        <div className="atable-wrap">
        <table className="atable">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>Individual</th>
              <th style={{ width: "16%" }}>Class</th>
              <th style={{ width: "30%" }}>Data properties</th>
              <th style={{ width: "26%" }}>Relations</th>
              <th style={{ width: 30 }}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((ind) => (
              <Row
                key={ind.id}
                ind={ind}
                tbox={tbox}
                abox={abox}
                issues={issuesById.get(ind.id) ?? []}
                selected={selectedId === ind.id}
                showAll={showAll}
                onSelect={onSelect}
                onPatch={patch}
                onRemove={remove}
              />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
