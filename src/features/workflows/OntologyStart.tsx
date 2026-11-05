import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { uid } from "../../lib/format";
import { parseTBox } from "../../lib/ontology/tboxParser";
import { Dropzone } from "../../components/Dropzone";
import { InlineError, LoadingState } from "../../components/ui/ui";
import { IconArrowRight, IconFile, IconFolder, IconUpload } from "../../components/icons";
import { revisionLabel } from "../revisions/RevisionBar";
import { tboxStart, type TboxStart } from "./model";
import { findOntologyBuild } from "../../lib/ontologyBuild";
import { OntologyBuildActions } from "./OntologyBuildActions";

const STARTS = [
  {
    id: "documents",
    title: "From documents",
    description: "Turn source documents into a new ontology, guided by your research questions.",
    icon: IconFile,
  },
  {
    id: "template",
    title: "From a template",
    description: "Choose a starter ontology and adapt its classes, properties and questions.",
    icon: IconFolder,
  },
  {
    id: "import",
    title: "Import an ontology",
    description: "Bring an existing ontology in Turtle, RDF/XML, OWL or JSON-LD.",
    icon: IconUpload,
  },
] as const;

export function OntologyStart({ onChoose }: { onChoose: (start: TboxStart) => void }) {
  const { pid, project, revisions, selectedId, working } = useProject();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const start = tboxStart(params);
  const [templateId, setTemplateId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const candidates = revisions.filter((revision) => revision.stats.modules > 0);
  const templates = useQuery({ queryKey: qk.templates, queryFn: api.listTemplates, enabled: start === "template", staleTime: Infinity });
  const chosen = templates.data?.find((template) => template.id === templateId);
  const selected = candidates.find((revision) => revision.id === selectedId);
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid), enabled: !!selected });
  const sourceBuild = selected ? findOntologyBuild(selected.id, revisions, runs.data ?? []) : undefined;
  const prepare = useMutation({
    mutationFn: async (mode: TboxStart) => {
      await working.flush();
      if (mode === "template") return api.applyTemplate(pid, templateId);
      if (mode === "previous") {
        if (!selected) throw new Error("Select an ontology version in the sidebar first.");
        const source = await api.getRevision(pid, selected.id);
        if (source.status === "draft") return source;
        return api.createDraft(pid, source.content, `New draft from version ${source.number}`, "ontology");
      }
      if (!files.length) throw new Error("Choose at least one ontology file.");
      const modules = await Promise.all(
        files.map(async (file) => {
          try {
            const converted = await api.convertRdf(file.name, await file.text());
            parseTBox(converted.turtle);
            return { id: uid("mod"), name: file.name.replace(/\.[^.]+$/, "") + ".ttl", turtle: converted.turtle };
          } catch (error) {
            throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      const current = project?.currentRevisionId ? await api.getRevision(pid, project.currentRevisionId) : null;
      return api.createDraft(
        pid,
        { modules, abox: current?.content.abox ?? null, baseIri: parseTBox(modules[0].turtle).baseIri ?? "" },
        `Imported ${files.map((file) => file.name).join(", ")}`,
        "import",
      );
    },
    onSuccess: async (revision, mode) => {
      await Promise.all([qc.invalidateQueries({ queryKey: qk.revisions(pid) }), qc.invalidateQueries({ queryKey: qk.project(pid) })]);
      setParams({ start: mode, step: "review", rev: revision.id, ...(mode === "previous" && sourceBuild ? { from: sourceBuild.id } : {}) });
    },
  });
  return (
    <div className="workflow-stack ontology-start">
      <div className="ontology-start-heading">
        <h2>Build & sources</h2>
        <p>Continue your selected ontology, or start a new one from documents, a template or an import.</p>
      </div>
      {selected && (!params.has("start") || start === "previous") && (
        <section className="ontology-continue" aria-label="Continue selected ontology">
          <div>
            <span className="research-eyebrow">Continue selected ontology</span>
            <h3>{revisionLabel(selected)}</h3>
            <p>
              {selected.summary || "Ontology"} · {selected.stats.classes} classes
            </p>
            <p className="field-hint">
              {selected.status === "draft"
                ? "Resume this draft where you left off."
                : "Your saved version stays unchanged. Editing creates a new draft."}{" "}
              Choose another version in the sidebar.
            </p>
          </div>
          <div className="row-actions">
            <button className="btn" disabled={prepare.isPending} onClick={() => prepare.mutate("previous")}>
              {prepare.isPending ? "Opening…" : selected.status === "draft" ? "Resume draft" : "Edit a new draft"}
            </button>
            <OntologyBuildActions revision={selected} compact />
          </div>
        </section>
      )}
      <h3>Start a new ontology</h3>
      <div className="ontology-start-grid" aria-label="Ontology starting options">
        {STARTS.map((item) => (
          <button
            key={item.id}
            className={"ontology-start-card" + (params.get("start") === item.id ? " is-selected" : "")}
            disabled={prepare.isPending}
            onClick={() => {
              prepare.reset();
              onChoose(item.id);
            }}
            aria-pressed={params.get("start") === item.id}
          >
            <item.icon />
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
            <IconArrowRight />
          </button>
        ))}
      </div>
      {start === "template" && params.has("start") && (
        <section className="ontology-start-panel" aria-labelledby="template-heading">
          <h3 id="template-heading">Choose a template</h3>
          {templates.isLoading ? (
            <LoadingState label="Loading templates…" />
          ) : templates.error ? (
            <InlineError error={templates.error} />
          ) : (
            <div className="ontology-template-grid">
              {(templates.data ?? []).map((template) => (
                <label key={template.id} className={"mode-card" + (templateId === template.id ? " on" : "")}>
                  <input
                    type="radio"
                    name="ontology-template"
                    value={template.id}
                    checked={templateId === template.id}
                    disabled={prepare.isPending}
                    onChange={() => {
                      setTemplateId(template.id);
                      prepare.reset();
                    }}
                  />
                  <span className="mode-title">{template.name}</span>
                  <span className="mode-desc">{template.description}</span>
                  <small>
                    {template.classes} classes · {template.properties} properties
                  </small>
                </label>
              ))}
            </div>
          )}
          {chosen && (
            <details className="template-cqs">
              <summary>Questions this template answers</summary>
              <ul>
                {chosen.cqs.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="field-hint">The template opens as a draft in this project. Existing purpose and research questions are kept.</p>
          <button className="btn" disabled={!chosen || prepare.isPending} onClick={() => prepare.mutate(start)}>
            {prepare.isPending ? "Preparing draft…" : "Use template & review"}
          </button>
        </section>
      )}
      {start === "import" && (
        <section className="ontology-start-panel" aria-label="Import ontology">
          <Dropzone
            title="Add ontology files"
            hint="Import structured ontology files, then review their classes and properties."
            accept=".ttl,.turtle,.rdf,.owl,.xml,.jsonld,.nt,.n3"
            formats={["TTL", "RDF/XML", "OWL", "JSON-LD"]}
            multiple
            onFiles={(next) => {
              if (!prepare.isPending) {
                setFiles(next);
                prepare.reset();
              }
            }}
          />
          {!!files.length && (
            <ul className="ontology-file-list">
              {files.map((file, index) => (
                <li key={`${index}-${file.name}`}>
                  <IconFile />
                  {file.name}
                </li>
              ))}
            </ul>
          )}
          <button className="btn" disabled={!files.length || prepare.isPending} onClick={() => prepare.mutate(start)}>
            {prepare.isPending ? "Importing…" : "Import & review"}
          </button>
        </section>
      )}
      <InlineError error={prepare.error} />
    </div>
  );
}
