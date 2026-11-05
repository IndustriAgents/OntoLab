// Dedicated "Build with AI" page: capture the ontology's purpose, scope and
// competency questions, gather source documents and standards (ontologies as
// reusable vocabulary + spec documents as reference reading), then generate a
// starter T-Box in one shot via /api/generate-tbox.

import { Dropzone } from "../Dropzone";
import { IconSpark } from "../icons";
import { ProviderModelSelect } from "../common/ProviderModelSelect";
import { fmtSize } from "../../lib/format";
import type { DocEntry } from "../../lib/docs";
import type { ProviderId, ProviderInfo } from "../../lib/api";
import type { TBoxModel } from "../../types/tbox";

export interface StandardsOnto {
  id: string;
  name: string;
  turtle: string;
  /** parsed client-side for the summary row; unparseable files are rejected upstream */
  model: TBoxModel | null;
}

interface Props {
  onBack: () => void;
  // Purpose, scope & competency questions
  purpose: string;
  onPurpose: (v: string) => void;
  scope: string;
  onScope: (v: string) => void;
  cqs: string[];
  onCqs: (v: string[]) => void;
  // Source documents
  docs: DocEntry[];
  docBusy: boolean;
  docErr: string | null;
  onDocFiles: (files: File[]) => void;
  onRemoveDoc: (id: string) => void;
  // Standards — slot A: ontologies (reusable vocabulary)
  standardsOntos: StandardsOnto[];
  standardsOntoErr: string | null;
  onStandardsOntoFiles: (files: File[]) => void;
  onRemoveStandardsOnto: (id: string) => void;
  // Standards — slot B: documents (reference reading)
  standardsDocs: DocEntry[];
  standardsDocBusy: boolean;
  standardsDocErr: string | null;
  onStandardsDocFiles: (files: File[]) => void;
  onRemoveStandardsDoc: (id: string) => void;
  // Generation settings
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
  error: string | null;
  onGenerate: () => void;
}

function docList(docs: DocEntry[], onRemove: (id: string) => void) {
  if (docs.length === 0) return null;
  return (
    <div className="doc-list" style={{ marginTop: 12 }}>
      {docs.map((d) => (
        <div className="doc-row" key={d.id}>
          <div className="grow">
            <div className="doc-name">{d.name}</div>
            <div className="doc-meta">
              {d.kind.toUpperCase()} · {fmtSize(d.sizeBytes)} · {d.text.length.toLocaleString()} chars
            </div>
          </div>
          <button className="doc-remove" onClick={() => onRemove(d.id)} title="Remove" aria-label="Remove">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function BuildWithAiPage(props: Props) {
  const {
    onBack,
    purpose,
    onPurpose,
    scope,
    onScope,
    cqs,
    onCqs,
    docs,
    docBusy,
    docErr,
    onDocFiles,
    onRemoveDoc,
    standardsOntos,
    standardsOntoErr,
    onStandardsOntoFiles,
    onRemoveStandardsOnto,
    standardsDocs,
    standardsDocBusy,
    standardsDocErr,
    onStandardsDocFiles,
    onRemoveStandardsDoc,
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
    error,
    onGenerate,
  } = props;

  const anyEnabled = providers.some((p) => p.enabled);
  const providerEnabled = providers.some((p) => p.id === provider && p.enabled);
  const canGenerate = purpose.trim() !== "" || docs.length > 0 || guidance.trim() !== "";

  return (
    <>
      <div className="page-actions" style={{ marginBottom: 4 }}>
        <button className="btn ghost" onClick={onBack}>
          ← Back
        </button>
        <span className="spacer" />
      </div>

      <div className="page-head">
        <h1>Build a T-Box with AI</h1>
        <p>
          Define what the ontology is for, add the documents it should be designed from, and optionally point at
          standards to align with. The model designs a complete starter T-Box — classes, a subsumption hierarchy, and
          properties — that you then validate and commit.
        </p>
      </div>

      {/* ── 1. Purpose, scope & competency questions ── */}
      <div className="card">
        <div className="card-head">
          <h3>Purpose, scope &amp; competency questions</h3>
        </div>
        <div className="field">
          <label htmlFor="buildPurpose">Purpose — what is this ontology for?</label>
          <textarea
            id="buildPurpose"
            className="qa-input"
            placeholder="e.g. describe an automated manufacturing cell so maintenance planning can reason over its components and behaviour"
            value={purpose}
            onChange={(e) => onPurpose(e.target.value)}
            rows={2}
          />
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="buildScope">Scope — what is in / out of scope?</label>
          <textarea
            id="buildScope"
            className="qa-input"
            placeholder="e.g. covers mechanical and pneumatic components and their control signals; excludes procurement and cost data"
            value={scope}
            onChange={(e) => onScope(e.target.value)}
            rows={2}
          />
        </div>
        <div className="sec-label">Competency questions</div>
        <p className="panel-note">
          Questions the finished ontology must be able to answer. They guide the model's design and are pre-loaded into
          Review → Questions for verification.
        </p>
        {cqs.map((q, i) => (
          <div className="cq-edit-row" key={i}>
            <input
              value={q}
              placeholder="e.g. Which sensors monitor which components?"
              onChange={(e) => onCqs(cqs.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              className="doc-remove"
              onClick={() => onCqs(cqs.filter((_, j) => j !== i))}
              title="Remove question"
              aria-label="Remove question"
            >
              ×
            </button>
          </div>
        ))}
        <div style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={() => onCqs([...cqs, ""])}>
            + Add question
          </button>
        </div>
      </div>

      {/* ── 2. Source documents ── */}
      <div className="card">
        <div className="card-head">
          <h3>Source documents</h3>
          {docs.length > 0 && <span className="file">{docs.length} document{docs.length === 1 ? "" : "s"}</span>}
        </div>
        <Dropzone
          title="Source documents (optional)"
          hint="Drop the documents the ontology should be designed from (.txt, .md, .pdf, .docx). Their content is extracted and modelled."
          accept=".txt,.md,.pdf,.docx,text/plain,application/pdf"
          formats={[".txt", ".md", ".pdf", ".docx"]}
          multiple
          error={docErr}
          onFiles={onDocFiles}
        />
        {docBusy && <div className="empty-note">Extracting text…</div>}
        {docList(docs, onRemoveDoc)}
      </div>

      {/* ── 3. Standards ── */}
      <div className="card">
        <div className="card-head">
          <h3>Standards (optional)</h3>
        </div>
        <div className="sec-label" style={{ marginTop: 0 }}>
          Standard ontologies — vocabulary to align with
        </div>
        <Dropzone
          title="Standard ontologies"
          hint="Drop standard/reference ontologies in Turtle syntax (.ttl). Their classes and properties are given to the model as reusable vocabulary. RDF/XML-serialized .owl/.rdf files can't be parsed — convert them to Turtle first."
          accept=".ttl,.owl,.rdf,.n3,.nt,.turtle"
          formats={[".ttl", ".owl", ".rdf", ".n3"]}
          multiple
          error={standardsOntoErr}
          onFiles={onStandardsOntoFiles}
        />
        {standardsOntos.length > 0 && (
          <div className="doc-list" style={{ marginTop: 12 }}>
            {standardsOntos.map((s) => (
              <div className="doc-row" key={s.id}>
                <div className="grow">
                  <div className="doc-name">{s.name}</div>
                  <div className="doc-meta">
                    {s.model
                      ? `${s.model.classes.length} classes · ${s.model.objectProps.length} obj · ${s.model.dataProps.length} data`
                      : "parse error"}
                  </div>
                </div>
                <button
                  className="doc-remove"
                  onClick={() => onRemoveStandardsOnto(s.id)}
                  title="Remove"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="sec-label">Standards documents — reference reading</div>
        <Dropzone
          title="Standards documents"
          hint="Drop standards/spec documents (.pdf, .docx, .txt, .md). They're passed to the model as reference material to align terminology with, not as extraction sources."
          accept=".txt,.md,.pdf,.docx,text/plain,application/pdf"
          formats={[".txt", ".md", ".pdf", ".docx"]}
          multiple
          error={standardsDocErr}
          onFiles={onStandardsDocFiles}
        />
        {standardsDocBusy && <div className="empty-note">Extracting text…</div>}
        {docList(standardsDocs, onRemoveStandardsDoc)}
      </div>

      {/* ── 4. Generate ── */}
      <div className="card">
        <div className="card-head">
          <h3>Generate</h3>
        </div>
        {anyEnabled ? (
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
            No providers are configured on the server. Add a provider key (e.g. <b>ANTHROPIC_API_KEY</b>) to <b>.env</b>{" "}
            and restart to generate a T-Box with AI.
          </div>
        )}
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="buildGuidance">Additional guidance (optional)</label>
          <textarea
            id="buildGuidance"
            className="qa-input"
            placeholder="e.g. keep it to the instrumentation domain; prefer shallow hierarchies"
            value={guidance}
            onChange={(e) => onGuidance(e.target.value)}
            rows={2}
          />
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="buildBaseIri">Base IRI for your ontology's URIs</label>
          <input
            id="buildBaseIri"
            value={baseIri}
            onChange={(e) => onBaseIri(e.target.value)}
            spellCheck={false}
            placeholder="http://ontolab.example/onto#"
          />
        </div>
        {error && (
          <div className="dz-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        <div className="page-actions" style={{ marginTop: 14 }}>
          {generating && (
            <>
              <button className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
              <span className="muted" role="status" aria-live="polite">
                {elapsed}s elapsed
              </span>
            </>
          )}
          <span className="spacer" />
          <button className="btn" disabled={!providerEnabled || generating || !canGenerate} onClick={onGenerate}>
            {generating ? <span className="spinner sm" /> : <IconSpark />} {generating ? "Designing T-Box…" : "Generate T-Box"}
          </button>
        </div>
      </div>
    </>
  );
}
