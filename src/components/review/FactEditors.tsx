// Ontology-guided editors for one individual's assertions, shared by the
// A-Box table and the Explore inspector. Pickers offer what the T-Box allows
// (properties by domain, targets by range, inputs by datatype); anything
// already asserted outside that stays visible and is labelled, never hidden.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { localName, COMMON_DATATYPES, normalizeDatatype } from "../../lib/ontology/iri";
import { applicableProps, defaultDatatype, inputKindFor, missingSlots, rangeTargets, type MissingSlot } from "../../lib/ontology/schemaGuide";
import { satisfies } from "../../lib/ontology/hierarchy";
import type { ABoxDataProp, ABoxIndividual, ABoxObjectProp, ABoxResult } from "../../types/abox";
import type { TBoxModel, TBoxProperty } from "../../types/tbox";

/**
 * Text input that keeps its own draft while focused and commits on blur/Enter.
 * Committing per keystroke re-ran validation, SHACL and the graph build for the
 * whole A-Box on every character typed.
 */
export const CommitInput = memo(function CommitInput({
  value,
  placeholder,
  className,
  onCommit,
  ariaLabel,
  type = "text",
  step,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  type?: string;
  step?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  // Adopt external changes (undo, an AI edit) unless the user is mid-typing.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <input
      className={className}
      type={type}
      step={step}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
});

const typesOf = (ind: ABoxIndividual) => [ind.classUri, ...(ind.additionalTypes ?? [])];
const termLabel = (t: { uri: string; label?: string }) => t.label || localName(t.uri);

/** A literal input that fits the value's datatype; free text when the lexical form would not survive the control. */
function ValueInput({ value, datatype, onCommit }: { value: string; datatype?: string; onCommit: (v: string) => void }) {
  const kind = inputKindFor(datatype);
  if (kind === "boolean") {
    return (
      <select className="ed-select xs" aria-label="Value" value={value} onChange={(e) => onCommit(e.target.value)}>
        {!["true", "false"].includes(value) && <option value={value}>{value || "(choose)"}</option>}
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  // datetime-local drops seconds and time zones: keep a text box for values it cannot show
  const fits =
    kind === "date" ? /^\d{4}-\d{2}-\d{2}$/.test(value) || !value : kind === "datetime" ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/.test(value) || !value : true;
  if (kind === "datetime" && fits) {
    return <CommitInput className="ed-input sm" type="datetime-local" value={value.slice(0, 16)} ariaLabel="Value" onCommit={(v) => onCommit(v ? `${v}:00` : v)} />;
  }
  const type = !fits ? "text" : kind === "number" || kind === "integer" ? "number" : kind === "date" ? "date" : "text";
  return <CommitInput className="ed-input sm" type={type} step={kind === "integer" ? "1" : kind === "number" ? "any" : undefined} value={value} placeholder="value" ariaLabel="Value" onCommit={onCommit} />;
}

interface FactsProps {
  ind: ABoxIndividual;
  tbox: TBoxModel;
  abox: ABoxResult;
  /** offer every property and target, not only the ones the schema allows */
  showAll?: boolean;
  onPatch: (patch: Partial<ABoxIndividual>, label: string) => void;
}

/** Options for a property picker: the allowed ones, plus the current one labelled when it is not. */
function propOptions(allowed: TBoxProperty[], all: TBoxProperty[], current: string) {
  const opts = allowed.map((p) => ({ uri: p.uri, text: termLabel(p) }));
  if (current && !allowed.some((p) => p.uri === current)) {
    const known = all.find((p) => p.uri === current);
    opts.unshift({ uri: current, text: `${known ? termLabel(known) : localName(current)} (${known ? "outside domain" : "unknown"})` });
  }
  return opts;
}

export function DataFacts({ ind, tbox, showAll, onPatch }: Omit<FactsProps, "abox">) {
  const dataProps = ind.dataProperties ?? [];
  const allowed = useMemo(() => (showAll ? tbox.dataProps : applicableProps(tbox, typesOf(ind)).data), [tbox, ind, showAll]);
  const set = (dps: ABoxDataProp[], label: string) => onPatch({ dataProperties: dps }, label);
  const update = (i: number, d: Partial<ABoxDataProp>) => set(dataProps.map((x, j) => (j === i ? { ...x, ...d } : x)), "Edit value");
  // Stable keys survive removal of a middle row (index keys mis-associated state).
  const dpKey = (dp: ABoxDataProp, i: number) => `${dp.propUri}|${i}`;

  return (
    <>
      {dataProps.map((dp, i) => {
        const declared = tbox.dataProps.find((p) => p.uri === dp.propUri);
        const options = [...new Set([...(declared?.range.map((r) => normalizeDatatype(r) ?? r) ?? []), ...COMMON_DATATYPES])];
        const effective = normalizeDatatype(dp.datatype) ?? defaultDatatype(tbox, dp.propUri);
        return (
          <div className="ed-prop" key={dpKey(dp, i)}>
            <select
              className="ed-select sm"
              aria-label="Data property"
              value={dp.propUri}
              onChange={(e) => update(i, { propUri: e.target.value, datatype: defaultDatatype(tbox, e.target.value) ?? dp.datatype })}
            >
              {propOptions(allowed, tbox.dataProps, dp.propUri).map((o) => (
                <option key={o.uri} value={o.uri}>
                  {o.text}
                </option>
              ))}
            </select>
            <ValueInput value={dp.value} datatype={dp.lang ? undefined : effective} onCommit={(v) => update(i, { value: v })} />
            <select
              className="ed-select xs"
              aria-label="Datatype"
              value={dp.lang ? "@lang" : (normalizeDatatype(dp.datatype) ?? "")}
              onChange={(e) => {
                const v = e.target.value;
                update(i, v === "@lang" ? { datatype: undefined, lang: dp.lang || "en" } : { lang: undefined, datatype: v || undefined });
              }}
            >
              <option value="">(default)</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {localName(o)}
                </option>
              ))}
              <option value="@lang">text@lang</option>
            </select>
            {dp.lang != null && <CommitInput className="ed-input xs" value={dp.lang} placeholder="de" ariaLabel="Language tag" onCommit={(v) => update(i, { lang: v })} />}
            <button className="ed-x" title="Remove this value" aria-label="Remove value" onClick={() => set(dataProps.filter((_, j) => j !== i), "Remove value")}>
              ×
            </button>
          </div>
        );
      })}
      {allowed.length > 0 && (
        <button className="ed-add" onClick={() => set([...dataProps, { propUri: allowed[0].uri, value: "", ...(defaultDatatype(tbox, allowed[0].uri) ? { datatype: defaultDatatype(tbox, allowed[0].uri) } : {}) }], "Add value")}>
          + data
        </button>
      )}
    </>
  );
}

export function LinkFacts({ ind, tbox, abox, showAll, onPatch }: FactsProps) {
  const objProps = ind.objectProperties ?? [];
  const allowed = useMemo(() => (showAll ? tbox.objectProps : applicableProps(tbox, typesOf(ind)).object), [tbox, ind, showAll]);
  const set = (ops: ABoxObjectProp[], label: string) => onPatch({ objectProperties: ops }, label);
  const update = (i: number, o: Partial<ABoxObjectProp>) => set(objProps.map((x, j) => (j === i ? { ...x, ...o } : x)), "Edit link");
  const targetsFor = (propUri: string) => (showAll ? abox.individuals : rangeTargets(tbox, abox, propUri));
  const byId = useMemo(() => new Map(abox.individuals.map((x) => [x.id, x])), [abox]);
  const firstLink = allowed.map((p) => ({ p, t: targetsFor(p.uri).find((x) => x.id !== ind.id) })).find((x) => x.t);
  const opKey = (op: ABoxObjectProp, i: number) => `${op.propUri}|${op.targetId}|${i}`;

  return (
    <>
      {objProps.map((op, i) => {
        const targets = targetsFor(op.propUri);
        const current = byId.get(op.targetId);
        return (
          <div className="ed-prop" key={opKey(op, i)}>
            <select className="ed-select sm" aria-label="Relation" value={op.propUri} onChange={(e) => update(i, { propUri: e.target.value })}>
              {propOptions(allowed, tbox.objectProps, op.propUri).map((o) => (
                <option key={o.uri} value={o.uri}>
                  {o.text}
                </option>
              ))}
            </select>
            <select className="ed-select sm" aria-label="Target individual" value={op.targetId} onChange={(e) => update(i, { targetId: e.target.value })}>
              {!targets.some((x) => x.id === op.targetId) && op.targetId && (
                <option value={op.targetId}>
                  {current ? `${current.label || current.id} (out of range)` : `${op.targetId} (missing)`}
                </option>
              )}
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label || x.id}
                </option>
              ))}
            </select>
            <button className="ed-x" title="Remove this link" aria-label="Remove link" onClick={() => set(objProps.filter((_, j) => j !== i), "Remove link")}>
              ×
            </button>
          </div>
        );
      })}
      {firstLink && (
        <button className="ed-add" onClick={() => set([...objProps, { propUri: firstLink.p.uri, targetId: firstLink.t!.id }], "Add link")}>
          + link
        </button>
      )}
    </>
  );
}

/** Values the schema requires but the individual lacks; one click adds a slot for it. */
export function MissingSlots({ ind, tbox, abox, onPatch }: FactsProps) {
  const slots = useMemo(() => missingSlots(tbox, ind), [tbox, ind]);
  if (!slots.length) return null;
  const fill = (s: MissingSlot) => {
    if (s.kind === "data") {
      const dt = s.filler && normalizeDatatype(s.filler) ? normalizeDatatype(s.filler) : defaultDatatype(tbox, s.propUri);
      onPatch({ dataProperties: [...(ind.dataProperties ?? []), { propUri: s.propUri, value: "", ...(dt ? { datatype: dt } : {}) }] }, "Fill required value");
      return;
    }
    const pool = rangeTargets(tbox, abox, s.propUri).filter((x) => x.id !== ind.id && (!s.filler || satisfies(tbox, [s.filler], [x.classUri, ...(x.additionalTypes ?? [])])));
    if (!pool.length) return;
    onPatch({ objectProperties: [...(ind.objectProperties ?? []), { propUri: s.propUri, targetId: pool[0].id }] }, "Fill required link");
  };
  return (
    <div className="ed-missing" aria-label="Required by the ontology">
      {slots.map((s) => {
        const noTarget =
          s.kind === "object" &&
          !rangeTargets(tbox, abox, s.propUri).some((x) => x.id !== ind.id && (!s.filler || satisfies(tbox, [s.filler], [x.classUri, ...(x.additionalTypes ?? [])])));
        return (
          <button
            key={s.propUri}
            className="ed-add ed-required"
            title={noTarget ? `${s.reason} — no individual of a fitting class exists yet` : s.reason}
            disabled={noTarget}
            onClick={() => fill(s)}
          >
            + {localName(s.propUri)} <span className="muted">(required{s.need > 1 ? ` ×${s.need}` : ""})</span>
          </button>
        );
      })}
    </div>
  );
}

export function ClassPicker({ value, tbox, onChange, ariaLabel, className = "ed-select" }: { value: string; tbox: TBoxModel; onChange: (uri: string) => void; ariaLabel: string; className?: string }) {
  return (
    <select className={className} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {!tbox.classes.some((c) => c.uri === value) && value && <option value={value}>{localName(value)} (unknown)</option>}
      {tbox.classes.map((c) => (
        <option key={c.uri} value={c.uri}>
          {termLabel(c)}
        </option>
      ))}
    </select>
  );
}
