// Classes and properties edited as forms instead of Turtle. A change is
// checked before it can be applied: the ontology check (structure, reasoning,
// regressions) plus what it does to the individuals already in the A-Box.
// Applying commits a new revision; the server re-validates it.

import { useMemo, useState } from "react";
import type { RevisionContent } from "../../types/project";
import type { TBoxModel, TBoxProperty } from "../../types/tbox";
import type { ABoxResult } from "../../types/abox";
import type { OntoModule } from "../../types/validation";
import { parseTBox, mergeTBox } from "../../lib/ontology/tboxParser";
import { COMMON_DATATYPES, localName, namespaceOf } from "../../lib/ontology/iri";
import { sanitizeLocal } from "../../lib/ontology/tboxEdit";
import { applyTermEdit, moduleOfTerm, tboxImpact, termUsage, type TBoxImpact, type TermSpec } from "../../lib/ontology/tboxForm";
import { InlineError, StatusBadge } from "../../components/ui/ui";
import { IconOntology, IconPlus, IconSearch } from "../../components/icons";
import "./termEditor.css";

type Kind = "class" | "object" | "data";

interface Props {
  content: RevisionContent;
  applyLabel?: string;
  /** Persist checked content; the caller chooses whether to save a draft or a version. */
  onApply: (next: RevisionContent, summary: string) => Promise<void>;
  /** open the form for a new term of this kind */
  initialNew?: Kind | null;
}

function mergedOf(modules: OntoModule[], baseIri: string): TBoxModel | null {
  const models: TBoxModel[] = [];
  for (const m of modules) {
    try {
      models.push(parseTBox(m.turtle));
    } catch {
      /* skipped: the ontology check reports it */
    }
  }
  return models.length ? mergeTBox(models, baseIri || undefined) : null;
}

const KIND_LABEL: Record<Kind, string> = { class: "Classes", object: "Relations", data: "Attributes" };
const TERM_LABEL: Record<Kind, string> = { class: "Class", object: "Relation", data: "Attribute" };

interface Form {
  /** the URI being edited; null for a new term */
  original: string | null;
  kind: Kind;
  name: string;
  label: string;
  comment: string;
  parents: string[];
  disjointWith: string[];
  domain: string[];
  range: string[];
  functional: boolean;
  inverseOf: string;
  moduleId: string;
}

function formFor(tbox: TBoxModel, kind: Kind, uri: string | null, moduleId: string): Form {
  const blank: Form = {
    original: null,
    kind,
    name: "",
    label: "",
    comment: "",
    parents: [],
    disjointWith: [],
    domain: [],
    range: [],
    functional: false,
    inverseOf: "",
    moduleId,
  };
  if (!uri) return blank;
  if (kind === "class") {
    const c = tbox.classes.find((x) => x.uri === uri);
    return {
      ...blank,
      original: uri,
      name: localName(uri),
      label: c?.label ?? "",
      comment: c?.comment ?? "",
      parents: tbox.subClassOf[uri] ?? [],
      disjointWith: c?.disjointWith ?? [],
    };
  }
  const p = (kind === "object" ? tbox.objectProps : tbox.dataProps).find((x) => x.uri === uri);
  return {
    ...blank,
    original: uri,
    name: localName(uri),
    label: p?.label ?? "",
    comment: p?.comment ?? "",
    parents: p?.subPropertyOf ?? [],
    domain: p?.domain ?? [],
    range: p?.range ?? [],
    functional: !!p?.functional,
    inverseOf: p?.inverseOf ?? "",
  };
}

/** Rename a term wherever the A-Box uses it, so the change does not orphan individuals. */
function renameInAbox(abox: ABoxResult | null, from: string, to: string): ABoxResult | null {
  if (!abox) return abox;
  const r = (u: string) => (u === from ? to : u);
  return {
    individuals: abox.individuals.map((i) => ({
      ...i,
      classUri: r(i.classUri),
      ...(i.additionalTypes ? { additionalTypes: i.additionalTypes.map(r) } : {}),
      ...(i.dataProperties ? { dataProperties: i.dataProperties.map((d) => ({ ...d, propUri: r(d.propUri) })) } : {}),
      ...(i.objectProperties ? { objectProperties: i.objectProperties.map((o) => ({ ...o, propUri: r(o.propUri) })) } : {}),
    })),
  };
}

/** Pick several terms: chips with remove buttons plus an "add" select. */
function MultiPick({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string[];
  options: { uri: string; text: string }[];
  onChange: (v: string[]) => void;
}) {
  const text = (u: string) => options.find((o) => o.uri === u)?.text ?? localName(u);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="te-chips">
        {value.map((u) => (
          <span key={u} className="te-chip">
            {text(u)}
            <button className="ed-x" aria-label={`Remove ${text(u)}`} onClick={() => onChange(value.filter((x) => x !== u))}>
              ×
            </button>
          </span>
        ))}
        <select aria-label={`Add to ${label}`} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">+ add</option>
          {options
            .filter((o) => !value.includes(o.uri))
            .map((o) => (
              <option key={o.uri} value={o.uri}>
                {o.text}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

export function TermEditor({ content, onApply, initialNew = null, applyLabel }: Props) {
  const modules = content.modules;
  const tbox = useMemo(() => mergedOf(modules, content.baseIri), [modules, content.baseIri]);
  const [kind, setKind] = useState<Kind>(initialNew ?? "class");
  const [filter, setFilter] = useState("");
  const defaultModule = modules[0]?.id ?? "";
  const [form, setForm] = useState<Form | null>(() => {
    if (!tbox) return null;
    if (initialNew) return formFor(tbox, initialNew, null, defaultModule);
    const first = tbox.classes[0];
    return first ? formFor(tbox, "class", first.uri, moduleOfTerm(modules, first.uri)?.id ?? defaultModule) : null;
  });
  const [impact, setImpact] = useState<{ key: string; result: TBoxImpact; next: RevisionContent; summary: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!tbox) return <p className="muted">Add an ontology module first; terms are edited inside a module.</p>;

  const ns = tbox.prefixes[""] || (tbox.classes[0] ? namespaceOf(tbox.classes[0].uri) : "http://ontolab.example/onto#");
  const terms: { uri: string; label?: string }[] = kind === "class" ? tbox.classes : kind === "object" ? tbox.objectProps : tbox.dataProps;
  const q = filter.trim().toLowerCase();
  const shown = terms.filter((t) => !q || localName(t.uri).toLowerCase().includes(q) || (t.label ?? "").toLowerCase().includes(q));
  const classOpts = tbox.classes.map((c) => ({ uri: c.uri, text: c.label || localName(c.uri) }));
  const propsOf = (k: Kind): TBoxProperty[] => (k === "object" ? tbox.objectProps : tbox.dataProps);

  const open = (k: Kind, uri: string | null) => {
    setKind(k);
    setForm(formFor(tbox, k, uri, (uri && moduleOfTerm(modules, uri)?.id) || defaultModule));
    setImpact(null);
    setError(null);
  };
  const patch = (p: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
    setImpact(null);
  };
  const browseKind = (k: Kind) => {
    const first = (k === "class" ? tbox.classes : propsOf(k))[0];
    setKind(k);
    setFilter("");
    setForm(first ? formFor(tbox, k, first.uri, moduleOfTerm(modules, first.uri)?.id ?? defaultModule) : null);
    setImpact(null);
    setError(null);
  };
  const reset = () => {
    const uri = form?.original ?? terms[0]?.uri;
    if (uri) open(kind, uri);
    else {
      setForm(null);
      setImpact(null);
      setError(null);
    }
  };

  /** Build the changed content for the form (or a deletion) and check it. */
  const check = (remove = false) => {
    if (!form) return;
    setError(null);
    const target = modules.find((m) => m.id === form.moduleId) ?? modules[0];
    const uri = ns.endsWith("#") || ns.endsWith("/") ? ns + sanitizeLocal(form.name) : `${ns}#${sanitizeLocal(form.name)}`;
    const finalUri = form.original && localName(form.original) === form.name ? form.original : uri;
    if (!remove && !sanitizeLocal(form.name)) return setError(new Error("Give the term a name."));
    if (!remove && !form.original && [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps].some((t) => t.uri === finalUri)) {
      return setError(new Error(`${localName(finalUri)} already exists. Pick it from the list to edit it.`));
    }
    try {
      let turtle = target.turtle;
      let abox = content.abox;
      let summary: string;
      if (remove && form.original) {
        turtle = applyTermEdit(turtle, { remove: form.original });
        summary = `Removed ${localName(form.original)}`;
      } else {
        if (form.original && finalUri !== form.original) {
          turtle = applyTermEdit(turtle, { rename: { from: form.original, to: finalUri } });
          abox = renameInAbox(abox, form.original, finalUri);
        }
        const spec: TermSpec =
          form.kind === "class"
            ? {
                kind: "class",
                uri: finalUri,
                label: form.label,
                comment: form.comment,
                parents: form.parents,
                disjointWith: form.disjointWith,
              }
            : {
                kind: form.kind,
                uri: finalUri,
                label: form.label,
                comment: form.comment,
                domain: form.domain,
                range: form.range,
                parents: form.parents,
                functional: form.functional,
                ...(form.kind === "object" && form.inverseOf ? { inverseOf: form.inverseOf } : {}),
              };
        turtle = applyTermEdit(turtle, { upsert: spec });
        summary = form.original
          ? `Changed ${localName(finalUri)}${finalUri !== form.original ? ` (renamed from ${localName(form.original)})` : ""}`
          : `Added ${localName(finalUri)}`;
      }
      const changed = { ...target, turtle };
      // a delete or rename the person asked for is not an accidental removal
      const intended = form.original && (remove || finalUri !== form.original) ? [form.original] : [];
      const result = tboxImpact(modules, changed, abox, content.baseIri, { intended });
      const next: RevisionContent = { ...content, modules: modules.map((m) => (m.id === changed.id ? changed : m)), abox };
      setImpact({ key: remove ? "remove" : "upsert", result, next, summary });
    } catch (e) {
      setError(e);
    }
  };

  const apply = async () => {
    if (!impact?.result.ok) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(impact.next, impact.summary);
      setForm(null);
      setImpact(null);
    } catch (e) {
      setError(e);
    } finally {
      setApplying(false);
    }
  };

  const used = form?.original ? termUsage(content.abox, form.original) : [];
  const r = impact?.result;
  const ontologyIssues = r?.ontology.issues.filter((i) => i.severity !== "info") ?? [];

  return (
    <div className="term-editor">
      <div className="te-header">
        <div>
          <h2>Browse ontology</h2>
          <p>Inspect and refine your classes, relations and attributes.</p>
        </div>
        <div className="tabbar" role="tablist" aria-label="Term kind">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={"tab" + (kind === k ? " on" : "")}
              onClick={() => browseKind(k)}
            >
              {KIND_LABEL[k]}
              <span className="count">{(k === "class" ? tbox.classes : propsOf(k)).length}</span>
            </button>
          ))}
        </div>
      </div>
      <aside className="te-list" aria-label={`${KIND_LABEL[kind]} browser`}>
        <div className="te-tools">
          <div className="te-search">
            <IconSearch />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Find ${KIND_LABEL[kind].toLowerCase()}…`}
              aria-label="Filter terms"
            />
          </div>
          <button className="btn ghost sm" onClick={() => open(kind, null)} aria-label={`New ${TERM_LABEL[kind].toLowerCase()}`}>
            <IconPlus /> New
          </button>
        </div>
        <p className="te-list-count" role="status">
          {q ? `${shown.length} of ${terms.length}` : terms.length} {KIND_LABEL[kind].toLowerCase()}
        </p>
        <ul className="te-terms">
          {shown.map((t) => (
            <li key={t.uri}>
              <button
                className={"te-term" + (form?.original === t.uri ? " on" : "")}
                aria-current={form?.original === t.uri ? "true" : undefined}
                onClick={() => open(kind, t.uri)}
              >
                <span className="te-term-label">{t.label || localName(t.uri)}</span>
                {t.label && t.label !== localName(t.uri) && <span className="te-term-id">{localName(t.uri)}</span>}
              </button>
            </li>
          ))}
          {!shown.length && (
            <li className="te-no-results">
              <b>{q ? "No matching terms" : `No ${KIND_LABEL[kind].toLowerCase()} yet`}</b>
              <p>{q ? "Try a different name or clear your search." : `Add a ${TERM_LABEL[kind].toLowerCase()} to get started.`}</p>
              {q && (
                <button className="btn ghost sm" onClick={() => setFilter("")}>
                  Clear search
                </button>
              )}
            </li>
          )}
        </ul>
      </aside>

      <section className="te-form" aria-label="Term">
        {!form ? (
          <div className="te-empty">
            <IconOntology />
            <h3>Define your first {TERM_LABEL[kind].toLowerCase()}</h3>
            <p>
              {kind === "class"
                ? "Classes describe the kinds of things in your domain."
                : kind === "object"
                  ? "Relations connect one thing to another."
                  : "Attributes describe values such as names, dates and measurements."}
            </p>
            <button className="btn" onClick={() => open(kind, null)}>
              <IconPlus /> Add {TERM_LABEL[kind].toLowerCase()}
            </button>
          </div>
        ) : (
          <>
            <div className="te-form-head">
              <span className="te-kind-label">
                {TERM_LABEL[form.kind]} · {modules.find((m) => m.id === form.moduleId)?.name ?? "Ontology"}
              </span>
              <h3>
                {form.original
                  ? terms.find((t) => t.uri === form.original)?.label || localName(form.original)
                  : `New ${TERM_LABEL[form.kind].toLowerCase()}`}
              </h3>
              <p>Changes are checked against the ontology and existing facts before saving.</p>
              {form.original && <code className="te-uri">{form.original}</code>}
            </div>
            <div className="te-identity-fields">
              <div className="field">
                <label htmlFor="te-name">Name</label>
                <input
                  id="te-name"
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder={form.kind === "class" ? "Valve" : "hasPart"}
                />
                {form.original && form.name !== localName(form.original) && (
                  <p className="field-hint">Renames the term; individuals that use it are updated too.</p>
                )}
              </div>
              <div className="field">
                <label htmlFor="te-label">Label</label>
                <input id="te-label" value={form.label} onChange={(e) => patch({ label: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="te-comment">Definition</label>
              <textarea id="te-comment" rows={2} value={form.comment} onChange={(e) => patch({ comment: e.target.value })} />
            </div>
            {form.kind === "class" ? (
              <>
                <MultiPick
                  label="Subclass of"
                  value={form.parents}
                  options={classOpts.filter((o) => o.uri !== form.original)}
                  onChange={(v) => patch({ parents: v })}
                />
                <MultiPick
                  label="Disjoint with"
                  value={form.disjointWith}
                  options={classOpts.filter((o) => o.uri !== form.original)}
                  onChange={(v) => patch({ disjointWith: v })}
                />
              </>
            ) : (
              <>
                <MultiPick label="Domain (any of)" value={form.domain} options={classOpts} onChange={(v) => patch({ domain: v })} />
                {form.kind === "object" ? (
                  <MultiPick label="Range (any of)" value={form.range} options={classOpts} onChange={(v) => patch({ range: v })} />
                ) : (
                  <div className="field">
                    <label htmlFor="te-range">Datatype</label>
                    <select
                      id="te-range"
                      value={form.range[0] ?? ""}
                      onChange={(e) => patch({ range: e.target.value ? [e.target.value] : [] })}
                    >
                      <option value="">(any literal)</option>
                      {[...new Set([...form.range, ...COMMON_DATATYPES])].map((d) => (
                        <option key={d} value={d}>
                          {localName(d)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <MultiPick
                  label="Sub-property of"
                  value={form.parents}
                  options={propsOf(form.kind)
                    .filter((p) => p.uri !== form.original)
                    .map((p) => ({ uri: p.uri, text: p.label || localName(p.uri) }))}
                  onChange={(v) => patch({ parents: v })}
                />
                {form.kind === "object" && (
                  <div className="field">
                    <label htmlFor="te-inverse">Inverse of</label>
                    <select id="te-inverse" value={form.inverseOf} onChange={(e) => patch({ inverseOf: e.target.value })}>
                      <option value="">(none)</option>
                      {tbox.objectProps
                        .filter((p) => p.uri !== form.original)
                        .map((p) => (
                          <option key={p.uri} value={p.uri}>
                            {p.label || localName(p.uri)}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <label className="check">
                  <input type="checkbox" checked={form.functional} onChange={(e) => patch({ functional: e.target.checked })} /> Functional
                  (at most one value)
                </label>
              </>
            )}
            {modules.length > 1 && (
              <div className="field">
                <label htmlFor="te-module">Module</label>
                <select
                  id="te-module"
                  value={form.moduleId}
                  disabled={!!form.original}
                  onChange={(e) => patch({ moduleId: e.target.value })}
                >
                  {modules.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="row-actions">
              <button className="btn" onClick={() => check(false)}>
                Check change
              </button>
              {form.original && (
                <button
                  className="btn ghost"
                  onClick={() => check(true)}
                  title={used.length ? `${used.length} individual(s) use this term` : undefined}
                >
                  Check deletion{used.length ? ` (used by ${used.length})` : ""}
                </button>
              )}
              <button className="btn ghost" onClick={reset}>
                {form.original ? "Reset changes" : "Cancel"}
              </button>
            </div>

            {r && impact && (
              <div className="te-impact" role="status">
                <p>
                  <b>{impact.summary}</b>:{" "}
                  {r.ok ? <StatusBadge tone="ok">Valid</StatusBadge> : <StatusBadge tone="alert">Cannot be applied</StatusBadge>}{" "}
                  {r.ontology.reasoning && r.ontology.reasoning.newlyUnsat.length > 0 && (
                    <StatusBadge tone="alert">{r.ontology.reasoning.newlyUnsat.length} class(es) become unsatisfiable</StatusBadge>
                  )}
                </p>
                {ontologyIssues.length > 0 && (
                  <ul className="issue-mini">
                    {ontologyIssues.slice(0, 10).map((i, n) => (
                      <li key={n}>
                        <StatusBadge tone={i.severity === "error" ? "alert" : "warn"}>
                          {i.severity === "error" ? "Error" : "Warning"}
                        </StatusBadge>{" "}
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                {r.introduced.length > 0 && (
                  <>
                    <p className="small">
                      Effect on the individuals: {r.affected.length} would get new findings
                      {r.resolved.length ? `, ${r.resolved.length} finding(s) would be resolved` : ""}.
                    </p>
                    <ul className="issue-mini">
                      {r.introduced.slice(0, 10).map((i, n) => (
                        <li key={n}>
                          <StatusBadge tone={i.severity === "error" ? "alert" : "warn"}>
                            {i.severity === "error" ? "Error" : "Warning"}
                          </StatusBadge>{" "}
                          <b>{i.where}</b>: {i.message}
                        </li>
                      ))}
                      {r.introduced.length > 10 && <li className="muted small">…and {r.introduced.length - 10} more</li>}
                    </ul>
                  </>
                )}
                {!r.ok && <p className="small">Errors must be fixed first, in the ontology or in the individuals (Explore).</p>}
                <button className="btn" disabled={!r.ok || applying} onClick={() => void apply()}>
                  {applying
                    ? "Applying…"
                    : (applyLabel ?? (r.ok && (r.introduced.length || ontologyIssues.length) ? "Apply with these warnings" : "Apply as new revision"))}
                </button>
              </div>
            )}
            {error != null && <InlineError error={error} />}
          </>
        )}
      </section>
    </div>
  );
}
