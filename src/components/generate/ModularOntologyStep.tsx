import { useMemo, useState } from "react";
import { Dropzone } from "../Dropzone";
import { IconDownload, IconSpark, IconCheck } from "../icons";
import { parseTBox } from "../../lib/ontology/tboxParser";
import { localName } from "../../lib/ontology/iri";
import { ProviderModelSelect } from "../common/ProviderModelSelect";
import { fmtSize, downloadText } from "../../lib/format";
import type { DocEntry } from "../../lib/docs";
import type { ProviderId, ProviderInfo } from "../../lib/api";
import type { TBoxModel } from "../../types/tbox";
import type { OntoModule, ValidationReport, ValidationIssue } from "../../types/validation";

/** Parse a module's Turtle to its model (for per-module class/property detail). */
function moduleModel(turtle: string): TBoxModel | null {
  try {
    return parseTBox(turtle);
  } catch {
    return null;
  }
}

type AuthorTab = "upload" | "ai" | "edit";

interface Props {
  // base ontology
  baseModules: OntoModule[];
  baseModel: TBoxModel | null;
  baseErr: string | null;
  onBaseFiles: (files: File[]) => void;
  onRemoveBaseModule: (id: string) => void;
  onEditModule: (id: string) => void;
  onExportMerged: () => void;
  /** jump to the Author step with the AI tab open (build a fresh T-Box from scratch) */
  onStartScratch: () => void;
  // author tab
  authorTab: AuthorTab;
  onAuthorTab: (t: AuthorTab) => void;
  // draft (candidate change)
  draftName: string;
  draftTurtle: string;
  draftEditId: string | null;
  draftErr: string | null;
  onDraftFile: (files: File[]) => void;
  onDraftName: (v: string) => void;
  onDraftTurtle: (v: string) => void;
  onNewBlank: () => void;
  // AI authoring
  docs: DocEntry[];
  docBusy: boolean;
  docErr: string | null;
  onDocFiles: (files: File[]) => void;
  onRemoveDoc: (id: string) => void;
  providers: ProviderInfo[];
  provider: ProviderId;
  model: string;
  models: string[];
  onProvider: (id: ProviderId) => void;
  onModel: (m: string) => void;
  guidance: string;
  onGuidance: (v: string) => void;
  baseIri: string;
  onBaseIri: (v: string) => void;
  generating: boolean;
  /** seconds elapsed in the current generation */
  elapsed: number;
  onCancel: () => void;
  onGenerate: (instruction: string) => void;
  /** AI-edit the current draft Turtle (add/remove classes & properties via NL) */
  onRefineDraft: (instruction: string) => void;
  // validation
  report: ValidationReport | null;
  onValidate: () => void;
  onCommit: () => void;
  // which pipeline step to show: 0 = Base T-Box, 1 = Author, 2 = Validate & Commit
  step: number;
}

export function ModularOntologyStep(props: Props) {
  const {
    baseModules,
    baseModel,
    baseErr,
    onBaseFiles,
    onRemoveBaseModule,
    onEditModule,
    onExportMerged,
    onStartScratch,
    authorTab,
    onAuthorTab,
    draftName,
    draftTurtle,
    draftEditId,
    draftErr,
    onDraftFile,
    onDraftName,
    onDraftTurtle,
    onNewBlank,
    docs,
    docBusy,
    docErr,
    onDocFiles,
    onRemoveDoc,
    providers,
    provider,
    model,
    models,
    onProvider,
    onModel,
    guidance,
    onGuidance,
    baseIri,
    onBaseIri,
    generating,
    elapsed,
    onCancel,
    onGenerate,
    onRefineDraft,
    report,
    onValidate,
    onCommit,
    step,
  } = props;

  const [instruction, setInstruction] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const anyEnabled = providers.some((p) => p.enabled);
  const providerEnabled = providers.some((p) => p.id === provider && p.enabled);

  const parsedModules = useMemo<Record<string, TBoxModel | null>>(
    () => Object.fromEntries(baseModules.map((m) => [m.id, moduleModel(m.turtle)])),
    [baseModules],
  );

  const download = (text: string, name: string) => downloadText(text, name, "text/turtle;charset=utf-8");

  const providerControls = anyEnabled ? (
    <ProviderModelSelect
      providers={providers}
      provider={provider}
      model={model}
      models={models}
      onProvider={onProvider}
      onModel={onModel}
      structuredOnly
      disabled={generating}
    />
  ) : (
    <div className="dz-error" style={{ marginTop: 12 }}>
      No providers are configured on the server. Add a provider key (e.g. <b>ANTHROPIC_API_KEY</b>) to <b>.env</b> and
      restart to generate a module with AI.
    </div>
  );

  const tabBtn = (id: AuthorTab, label: string) => (
    <button className={"mode-tab" + (authorTab === id ? " is-active" : "")} onClick={() => onAuthorTab(id)} type="button">
      {label}
    </button>
  );

  return (
    <>
      {/* ── 1. Base T-Box ── */}
      {step === 0 && (
      <div className="card">
        <div className="card-head">
          <h3>Base T-Box</h3>
          <span className="file">{baseModules.length} module{baseModules.length === 1 ? "" : "s"}</span>
        </div>
        <Dropzone
          title="Load your T-Box"
          hint="Drop the .ttl module(s) of your T-Box (or choose a folder). They're merged into one committed T-Box that changes are validated against."
          accept=".ttl,.owl,.rdf,.xml,.jsonld,.n3,.nt,.turtle"
          formats={[".ttl", ".owl", ".rdf", ".jsonld"]}
          multiple
          allowDirectory
          error={baseErr}
          onFiles={onBaseFiles}
        />

        {baseModules.length === 0 && (
          <div className="scratch-cta">
            <div className="grow">
              <div className="scratch-title">No ontology yet? Start from scratch with AI</div>
              <div className="scratch-sub">
                Describe your domain (and optionally drop a document) and the model designs a complete starter T-Box —
                classes, a subsumption hierarchy, and properties — that you then validate and commit.
              </div>
            </div>
            <button className="btn" onClick={onStartScratch}>
              <IconSpark /> Build with AI
            </button>
          </div>
        )}

        {baseModules.length > 0 && (
          <>
            <div className="doc-list" style={{ marginTop: 14 }}>
              {baseModules.map((m) => {
                const model = parsedModules[m.id];
                const open = !!expanded[m.id];
                return (
                  <div key={m.id} className="module-item">
                    <div className="module-head">
                      <button className="module-toggle" onClick={() => toggle(m.id)} aria-expanded={open}>
                        <span className={"module-caret" + (open ? " open" : "")}>▸</span>
                        <span className="grow">
                          <span className="doc-name">{m.name}</span>
                          <span className="doc-meta">
                            {model
                              ? `${model.classes.length} classes · ${model.objectProps.length} obj · ${model.dataProps.length} data`
                              : "parse error"}
                          </span>
                        </span>
                      </button>
                      <button className="btn ghost" style={{ marginRight: 8 }} onClick={() => onEditModule(m.id)}>
                        Edit
                      </button>
                      <button className="doc-remove" onClick={() => onRemoveBaseModule(m.id)} title="Remove" aria-label="Remove">
                        ×
                      </button>
                    </div>

                    {open && model && (
                      <div className="module-body">
                        {model.classes.length > 0 && (
                          <>
                            <div className="sec-label" style={{ marginTop: 0 }}>Classes</div>
                            <div className="chip-list">
                              {model.classes.map((c) => (
                                <span className="chip" key={c.uri} title={c.comment || c.uri}>
                                  {c.label || localName(c.uri)}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                        {model.objectProps.length > 0 && (
                          <>
                            <div className="sec-label">Object properties</div>
                            <div className="chip-list">
                              {model.objectProps.map((p) => (
                                <span className="chip" key={p.uri} title={p.comment || p.uri}>
                                  {p.label || localName(p.uri)}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                        {model.dataProps.length > 0 && (
                          <>
                            <div className="sec-label">Data properties</div>
                            <div className="chip-list">
                              {model.dataProps.map((p) => (
                                <span className="chip" key={p.uri} title={p.comment || p.uri}>
                                  {p.label || localName(p.uri)}
                                  {p.range[0] && <span className="muted"> · {localName(p.range[0])}</span>}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {baseModel && (
              <div className="stat-row" style={{ marginTop: 14 }}>
                <div className="stat">
                  <span className="n">{baseModel.classes.length}</span>
                  <span className="l">Classes</span>
                </div>
                <div className="stat">
                  <span className="n">{baseModel.objectProps.length}</span>
                  <span className="l">Object properties</span>
                </div>
                <div className="stat">
                  <span className="n">{baseModel.dataProps.length}</span>
                  <span className="l">Data properties</span>
                </div>
              </div>
            )}

            <div className="page-actions" style={{ marginTop: 14 }}>
              <span className="spacer" />
              <button className="btn ghost" onClick={onExportMerged}>
                <IconDownload /> Download merged .ttl
              </button>
            </div>
          </>
        )}
      </div>
      )}

      {/* ── 2. Author a change ── */}
      {step === 1 && (
      <div className="card">
        <div className="card-head">
          <h3>Add or modify a module</h3>
          {draftEditId && <span className="file">editing existing module</span>}
        </div>
        <div className="mode-tabs" style={{ marginBottom: 16 }}>
          {tabBtn("upload", "Upload module")}
          {tabBtn("ai", "Generate with AI")}
          {tabBtn("edit", "Edit Turtle")}
        </div>

        {authorTab === "upload" && (
          <Dropzone
            title="Upload a new module"
            hint="Drop a single .ttl module to add onto the base T-Box. It is validated before you commit it."
            accept=".ttl,.owl,.rdf,.xml,.jsonld,.n3,.nt,.turtle"
            formats={[".ttl", ".owl", ".rdf", ".jsonld"]}
            error={null}
            onFiles={onDraftFile}
          />
        )}

        {authorTab === "ai" && (
          <>
            <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, marginBottom: 12 }}>
              {baseModules.length === 0 ? (
                <>
                  Describe your domain (and/or drop a document). The model designs a <b>complete starter T-Box from
                  scratch</b> — classes, a subsumption hierarchy, and object/data properties. Validate it before committing.
                </>
              ) : (
                <>
                  Describe the module to add (and/or drop a document). The model designs a <b>new</b> module that extends
                  the base T-Box — referencing existing classes by their exact names. Validate it before committing.
                </>
              )}
            </p>
            <Dropzone
              title="Optional: a source document"
              hint="Drop a document the module should be based on (.txt, .md, .pdf)."
              accept=".txt,.md,.pdf,text/plain,application/pdf"
              formats={[".txt", ".md", ".pdf"]}
              multiple
              error={docErr}
              onFiles={onDocFiles}
            />
            {docBusy && <div className="empty-note">Extracting text…</div>}
            {docs.length > 0 && (
              <div className="doc-list" style={{ marginTop: 12 }}>
                {docs.map((d) => (
                  <div className="doc-row" key={d.id}>
                    <div className="grow">
                      <div className="doc-name">{d.name}</div>
                      <div className="doc-meta">
                        {d.kind.toUpperCase()} · {fmtSize(d.sizeBytes)} · {d.text.length.toLocaleString()} chars
                      </div>
                    </div>
                    <button className="doc-remove" onClick={() => onRemoveDoc(d.id)} title="Remove" aria-label="Remove">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14 }}>{providerControls}</div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="genInstruction">Describe the new module</label>
              <textarea
                id="genInstruction"
                className="qa-input"
                placeholder="e.g. add a Sensor hierarchy (TemperatureSensor, PressureSensor) that `monitors` existing Component, with a `readingUnit` data property"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                disabled={generating}
              />
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="genGuidance">Scope guidance (optional)</label>
              <textarea
                id="genGuidance"
                className="qa-input"
                placeholder="e.g. keep it to the instrumentation domain; reuse existing component classes"
                value={guidance}
                onChange={(e) => onGuidance(e.target.value)}
                rows={2}
              />
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="genBaseIri">
                {baseModules.length === 0 ? "Base IRI for your ontology's URIs" : "Base IRI for minted URIs (match the base T-Box's namespace)"}
              </label>
              <input
                id="genBaseIri"
                value={baseIri}
                onChange={(e) => onBaseIri(e.target.value)}
                spellCheck={false}
                placeholder="http://ontolab.example/onto#"
              />
            </div>
            <div className="page-actions" style={{ marginTop: 14 }}>
              <span className="spacer" />
              <button
                className="btn"
                disabled={!providerEnabled || generating || (!instruction.trim() && docs.length === 0)}
                onClick={() => onGenerate(instruction.trim())}
              >
                {generating ? <span className="spinner sm" /> : <IconSpark />} {generating ? "Designing module…" : "Generate module"}
              </button>
              {generating && (
                <button className="btn ghost" onClick={onCancel}>
                  Cancel ({elapsed}s)
                </button>
              )}
            </div>
          </>
        )}

        {authorTab === "edit" && (
          <>
            <div className="page-actions" style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                Edit the draft Turtle below, or start a new blank module.
              </span>
              <span className="spacer" />
              <button className="btn ghost" onClick={onNewBlank}>
                New blank module
              </button>
            </div>
            <div className="field">
              <label htmlFor="draftName">Module file name</label>
              <input
                id="draftName"
                value={draftName}
                onChange={(e) => onDraftName(e.target.value)}
                spellCheck={false}
                placeholder="new-module.ttl"
              />
            </div>
            <textarea
              className="ttl-editor"
              style={{ marginTop: 12 }}
              value={draftTurtle}
              spellCheck={false}
              placeholder="@prefix : <…> .&#10;:Foo a owl:Class ; rdfs:subClassOf :ExistingClass ."
              onChange={(e) => onDraftTurtle(e.target.value)}
            />

            {/* AI assist — add/remove classes & properties in the draft Turtle */}
            <div className="ai-edit">
              <div className="sec-label" style={{ marginTop: 0 }}>Edit with AI</div>
              <p className="panel-note">
                Describe what to add or remove and the model rewrites the Turtle above. e.g. “add a PressureSensor
                subclass of Sensor with a ratingBar decimal property” or “remove the legacyId data property”.
              </p>
              {anyEnabled && providerControls}
              <textarea
                className="qa-input"
                style={{ marginTop: 12 }}
                placeholder="Add or remove classes / properties…"
                value={editInstruction}
                onChange={(e) => setEditInstruction(e.target.value)}
                rows={2}
                disabled={generating}
              />
              <div className="page-actions" style={{ marginTop: 12 }}>
                <span className="spacer" />
                <button
                  className="btn"
                  disabled={!providerEnabled || generating || !editInstruction.trim() || !draftTurtle.trim()}
                  onClick={() => onRefineDraft(editInstruction.trim())}
                >
                  {generating ? <span className="spinner sm" /> : <IconSpark />} {generating ? "Applying…" : "Apply with AI"}
                </button>
                {generating && (
                  <button className="btn ghost" onClick={onCancel}>
                    Cancel ({elapsed}s)
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {draftErr && (
          <div className="dz-error" role="alert" style={{ marginTop: 12 }}>
            {draftErr}
          </div>
        )}
      </div>
      )}

      {/* ── 3. Candidate + validation ── */}
      {step === 2 && (
        <>
          {!draftTurtle.trim() && !report && (
            <p className="panel-note">Author a module in the previous step, then validate and commit it here.</p>
          )}
      {draftTurtle.trim() && (
        <div className="card">
          <div className="card-head">
            <h3>Candidate change</h3>
            <span className="file">{draftName || "draft.ttl"}{draftEditId ? " · edit" : " · new module"}</span>
          </div>
          <div className="page-actions">
            <button className="btn ghost" onClick={() => download(draftTurtle, draftName || "module.ttl")}>
              <IconDownload /> Download module
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onValidate}>
              <IconCheck /> Validate against base
            </button>
          </div>
        </div>
      )}

          {report && <ValidationReportView report={report} onCommit={onCommit} />}
        </>
      )}
    </>
  );
}

function severityClass(s: ValidationIssue["severity"]): string {
  return s === "error" ? "issue-error" : s === "warning" ? "issue-warning" : "issue-info";
}

/** The asserted axioms behind a reasoner finding. */
function IssueExplanation({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <details className="issue-explain">
      <summary>Why</summary>
      <ol>
        {lines.map((l, j) => (
          <li key={j}>{l}</li>
        ))}
      </ol>
    </details>
  );
}

function ValidationReportView({ report, onCommit }: { report: ValidationReport; onCommit: () => void }) {
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  const { added } = report.diff;
  const addedCount = added.classes.length + added.objectProps.length + added.dataProps.length;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Validation report</h3>
        <span className="file" style={{ color: report.ok ? "var(--ok, #2a8)" : "var(--bad, #c44)" }}>
          {report.ok ? "valid — safe to commit" : `${errors.length} error${errors.length === 1 ? "" : "s"} — blocked`}
        </span>
      </div>

      {report.issues.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>No issues found. The change is structurally valid and preserves the existing T-Box.</p>
      )}

      {errors.length > 0 && (
        <>
          <div className="sec-label">Errors (block commit)</div>
          <ul className="issue-list">
            {errors.map((i, n) => (
              <li key={n} className={severityClass(i.severity)}>
                <code>{i.code}</code> {i.message}
                {i.module && <span className="muted"> · {i.module}</span>}
                <IssueExplanation lines={i.explanation} />
              </li>
            ))}
          </ul>
        </>
      )}

      {warnings.length > 0 && (
        <>
          <div className="sec-label">Warnings</div>
          <ul className="issue-list">
            {warnings.map((i, n) => (
              <li key={n} className={severityClass(i.severity)}>
                <code>{i.code}</code> {i.message}
                {i.module && <span className="muted"> · {i.module}</span>}
                <IssueExplanation lines={i.explanation} />
              </li>
            ))}
          </ul>
        </>
      )}

      {report.reasoning && (
        <p className="muted small" title={report.reasoning.incomplete.join(" · ")}>
          Reasoner (OWL 2 RL): {report.reasoning.unsatisfiable.length} unsatisfiable class{report.reasoning.unsatisfiable.length === 1 ? "" : "es"}, {report.reasoning.added} entailment
          {report.reasoning.added === 1 ? "" : "s"} added, {report.reasoning.removed} removed, {report.reasoning.unintended} between existing terms.
        </p>
      )}

      <div className="sec-label">Impact on the T-Box</div>
      <div className="stat-row">
        <div className="stat">
          <span className="n">{addedCount}</span>
          <span className="l">Added</span>
        </div>
        <div className="stat">
          <span className="n">{report.diff.modified.length}</span>
          <span className="l">Modified</span>
        </div>
        <div className="stat">
          <span className="n">
            {report.diff.removed.classes.length + report.diff.removed.objectProps.length + report.diff.removed.dataProps.length}
          </span>
          <span className="l">Removed</span>
        </div>
      </div>
      {addedCount > 0 && (
        <div className="chip-list" style={{ marginTop: 10 }}>
          {[...added.classes, ...added.objectProps, ...added.dataProps].map((u) => (
            <span className="chip" key={u} title={u}>
              {localName(u)}
            </span>
          ))}
        </div>
      )}

      <div className="page-actions" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <button className="btn" disabled={!report.ok} onClick={onCommit}>
          <IconCheck /> Commit to base T-Box
        </button>
      </div>
    </div>
  );
}
