// Ontology: build it from the project's documents (induction), review a draft
// (pitfalls, reuse, alignment), import modules or standards, author changes by
// hand or with AI, validate each candidate against the committed ontology
// (structural checks + regression diff), and commit it as a new revision.
// The revision history lives here too, with T-Box and A-Box versions shown
// separately: compare and restore.

import { useCallback, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useModelChoice, selectProps } from "../../app/providers";
import { api, qk } from "../../lib/projectApi";
import type { OntoModule } from "../../types/validation";
import type { OntologyRevision, RevisionContent, RevisionDiff } from "../../types/project";
import { runWorkspaceHref, isOntologyRevision } from "../../lib/runNavigation";
import { useTboxWorkspace, type TboxControl } from "../../hooks/useTboxWorkspace";
import { ModularOntologyStep } from "../../components/generate/ModularOntologyStep";
import { InducePanel } from "./InducePanel";
import { OntologyUsage } from "./OntologyOverview";
import { OntologyReview } from "./OntologyReview";
import { TermEditor } from "./TermEditor";
import { ConfirmButton, InlineError, LoadingState, Modal, PageHead, StatusBadge, fmtDate } from "../../components/ui/ui";
import { IconArrowRight } from "../../components/icons";
import { revisionLabel } from "../revisions/RevisionBar";

type Tab = "workspace" | "terms" | "induce" | "review" | "history";
const STEPS = ["Modules", "Author change", "Validate & commit"];

function DiffView({ diff }: { diff: RevisionDiff }) {
  const m = diff.modules;
  const i = diff.individuals;
  const none = !m.added.length && !m.removed.length && !m.changed.length && !i.added.length && !i.removed.length && !i.changed.length;
  if (none) return <p className="muted">No differences.</p>;
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div>
        <h4 className="sec-label">{title}</h4>
        <ul className="chip-list">
          {items.slice(0, 60).map((x) => (
            <li key={x} className="chip">
              {x}
            </li>
          ))}
          {items.length > 60 && <li className="muted">and {items.length - 60} more</li>}
        </ul>
      </div>
    );
  return (
    <div className="diff-view">
      {list("Modules added", m.added)}
      {list("Modules removed", m.removed)}
      {list("Modules changed", m.changed)}
      {list("Individuals added", i.added)}
      {list("Individuals removed", i.removed)}
      {list(
        "Individuals changed",
        i.changed.map((c) => `${c.id}: ${c.changes.join(", ")}`),
      )}
    </div>
  );
}

function History() {
  const { pid, revisions, project, select } = useProject();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const alignmentRuns = new Map((runs.data ?? []).filter((r) => r.kind === "alignment").map((r) => [r.resultRevisionId, r]));
  const buildRunIds = new Set((runs.data ?? []).filter((r) => r.kind === "induction").map((r) => r.id));
  const [compare, setCompare] = useState<OntologyRevision | null>(null);
  const diff = useQuery({
    queryKey: ["diff", pid, compare?.id, project?.currentRevisionId],
    queryFn: () => api.diff(pid, project!.currentRevisionId!, compare!.id),
    enabled: !!compare && !!project?.currentRevisionId,
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restore(pid, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      select(null);
    },
  });
  const committed = revisions.filter((r) => r.status === "committed").sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  const drafts = revisions.filter((r) => r.status === "draft");
  return (
    <>
      {drafts.length > 0 && (
        <section className="card" aria-labelledby="h-drafts">
          <div className="card-head">
            <h3 id="h-drafts">Open drafts</h3>
          </div>
          <ul className="rev-list">
            {drafts.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  <b>{revisionLabel(r)}</b>
                  <span className="row-sub">
                    {r.summary} · {isOntologyRevision(r) ? `${r.stats.classes} classes` : `${r.stats.individuals} entities`} ·{" "}
                    {fmtDate(r.updatedAt)}
                  </span>
                </span>
                {r.parentId !== project?.currentRevisionId && <StatusBadge tone="warn">Based on an older revision</StatusBadge>}
                <Link
                  className="btn ghost sm"
                  to={
                    alignmentRuns.has(r.id)
                      ? runWorkspaceHref(pid, alignmentRuns.get(r.id)!)
                      : isOntologyRevision(r)
                        ? `/p/${pid}/ontology?tab=review&rev=${r.id}`
                        : `/p/${pid}/explore?rev=${r.id}`
                  }
                >
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card" aria-labelledby="h-history">
        <div className="card-head">
          <h3 id="h-history">Saved versions</h3>
        </div>
        <p className="field-hint">
          Versions record what was saved. Activity records processing work, while Build history compares its recorded inputs and results.
        </p>
        <ul className="rev-list">
          {committed.map((r) => (
            <li key={r.id}>
              <span className="grow">
                <b>Version {r.number}</b> {r.id === project?.currentRevisionId && <StatusBadge tone="ok">Current</StatusBadge>}{" "}
                {r.scope && r.scope !== "none" && (
                  <StatusBadge tone="muted">
                    {r.scope === "both" ? "Ontology + graph" : r.scope === "tbox" ? "Ontology change" : "Graph change"}
                  </StatusBadge>
                )}
                <span className="row-sub">
                  {r.summary || r.source} · Ontology {r.tboxVersion ? `v${r.tboxVersion}` : "—"} ({r.stats.classes} classes) · Graph{" "}
                  {r.aboxVersion ? `v${r.aboxVersion}` : "—"} ({r.stats.individuals} individuals) · {fmtDate(r.committedAt)}
                </span>
              </span>
              <Link className="btn ghost sm" to={`/p/${pid}/ontology?tab=review&rev=${r.id}`}>
                View
              </Link>
              <Link
                className="btn ghost sm"
                to={`/p/${pid}/workflows/tbox?step=sources&base=${r.id}${r.runId && buildRunIds.has(r.runId) ? `&from=${r.runId}` : ""}`}
              >
                Improve
              </Link>
              {r.id !== project?.currentRevisionId && (
                <>
                  <button className="btn ghost sm" onClick={() => setCompare(r)}>
                    Compare
                  </button>
                  <ConfirmButton
                    label="Restore"
                    confirmLabel={`Restore version ${r.number}`}
                    onConfirm={() => restore.mutate(r.id)}
                    disabled={restore.isPending}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
        <InlineError error={restore.error} />
      </section>
      {compare && (
        <Modal title={`Revision ${compare.number} → current`} onClose={() => setCompare(null)} wide>
          {diff.isLoading ? (
            <LoadingState label="Comparing…" />
          ) : diff.data ? (
            <DiffView diff={diff.data} />
          ) : (
            <InlineError error={diff.error} />
          )}
        </Modal>
      )}
    </>
  );
}

export default function OntologyPage() {
  const { pid, project, current, revisions, selectedId } = useProject();
  const qc = useQueryClient();
  const choice = useModelChoice();
  const [params, setParams] = useSearchParams();
  const [improveOpen, setImproveOpen] = useState(false);
  const location = useLocation();
  const tab = (params.get("tab") as Tab) || (params.has("rev") ? "review" : "workspace");
  const shown = revisions.find((r) => r.id === selectedId) ?? current;
  const improveHref = (step: string) =>
    `/p/${pid}/workflows/tbox?step=${step}&base=${shown?.id ?? "none"}${shown?.runId ? `&from=${shown.runId}` : ""}`;
  const setTab = (t: Tab) =>
    setParams((p) => (t === "workspace" ? (p.delete("tab"), p) : (p.set("tab", t), p)), { replace: true, state: location.state });

  const currentRev = useQuery({
    queryKey: qk.revision(pid, shown?.id ?? "none"),
    queryFn: () => api.getRevision(pid, shown!.id),
    enabled: !!shown,
  });
  const modules = useMemo(() => currentRev.data?.content.modules ?? [], [currentRev.data]);

  const commitContent = useCallback(
    async (content: RevisionContent, summary: string) => {
      const draft = await api.createDraft(pid, content, summary, "ontology");
      // The change was checked before this point; warnings are confirmed, errors still refuse the commit.
      try {
        await api.commit(pid, draft.id, { acknowledgedWarnings: true });
      } catch (e) {
        await api.discardDraft(pid, draft.id).catch(() => undefined);
        throw e;
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.project(pid) }),
        qc.invalidateQueries({ queryKey: qk.revisions(pid) }),
        qc.invalidateQueries({ queryKey: qk.projects }),
      ]);
    },
    [pid, qc],
  );
  const commit = useCallback(
    (next: OntoModule[], summary: string) =>
      commitContent({ ...(currentRev.data?.content ?? { modules: [], abox: null, baseIri: "" }), modules: next }, summary),
    [commitContent, currentRev.data],
  );
  const control = useMemo<TboxControl>(() => ({ modules, commit }), [modules, commit]);
  const seedCqs = useCallback(
    (questions: string[]) => {
      if (!project) return;
      const merged = [...new Set([...project.competencyQuestions, ...questions])];
      void api.updateProject(pid, { competencyQuestions: merged }).then((p) => qc.setQueryData(qk.project(pid), p));
    },
    [pid, project, qc],
  );
  const ws = useTboxWorkspace(seedCqs, control);

  const provider = selectProps(choice);

  if (shown && currentRev.isLoading) return <LoadingState label="Loading ontology…" />;

  return (
    <div className="page">
      <div className="page-wide">
        <PageHead title={tab === "history" ? "Ontology versions" : "Terms & relations"}>
          {shown
            ? `${shown.status === "committed" ? `Version ${shown.number}` : "Draft"} · ${shown.stats.modules} module${shown.stats.modules === 1 ? "" : "s"} · ${shown.stats.classes} classes. New builds produce a separate draft to inspect and save as a version.`
            : "Build from documents, start from a template, or import a TTL ontology. Inspect the draft, validate it, then save your first version."}
        </PageHead>
        <div className="ontology-next-actions">
          {shown ? (
            <button className="btn" onClick={() => setImproveOpen(true)}>
              Improve ontology
            </button>
          ) : (
            <Link className="btn" to={`/p/${pid}/workflows/tbox`}>
              Start an ontology
            </Link>
          )}
          <Link className="btn ghost" to={`/p/${pid}/export${shown ? `?rev=${shown.id}` : ""}`} state={location.state}>
            Export ontology
          </Link>
        </div>
        {improveOpen && (
          <Modal
            title={shown ? "How would you like to improve this ontology?" : "Choose a starting point"}
            onClose={() => setImproveOpen(false)}
          >
            <p>
              {shown
                ? "The selected ontology is the starting point. Each new build produces a separate draft."
                : "Start with documents or an existing TTL ontology, then review and save a version."}
            </p>
            <div className="ontology-improve-choices">
              <Link to={improveHref("sources")}>
                Add or change source documents<small>Prepare the inputs for another build.</small>
              </Link>
              <Link to={improveHref("chunks")}>
                Change chunking or models<small>Create document variants and compare a different configuration.</small>
              </Link>
              <Link to={`/p/${pid}/workflows/tbox?step=requirements${shown ? `&rev=${shown.id}` : ""}`}>
                Revise questions to answer<small>Review approved questions before the next build.</small>
              </Link>
              <Link to={`/p/${pid}/ontology?tab=workspace`} onClick={() => setImproveOpen(false)}>
                Import a TTL ontology<small>Inspect and add ontology modules in the workspace.</small>
              </Link>
              <Link to={`/p/${pid}/workflows/alignment`}>
                Align another ontology<small>Review mappings and combine modules.</small>
              </Link>
              <Link to={`/p/${pid}/ontology?tab=terms`} onClick={() => setImproveOpen(false)}>
                Edit classes and properties<small>Use the term editor and review changes.</small>
              </Link>
            </div>
          </Modal>
        )}
        {tab !== "history" && (
          <div className="tabbar" role="tablist" aria-label="Ontology editor views">
            {(
              [
                ["workspace", "Modules & changes"],
                ["terms", "Classes & properties"],
                ["review", "Review"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={"tab" + (tab === id ? " on" : "")}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
            <Link className="tab" to={`/p/${pid}/assistant${shown ? `?rev=${shown.id}` : ""}`} state={location.state}>
              Ask
            </Link>
            <Link className="tab" to={`/p/${pid}/sparql${shown ? `?rev=${shown.id}` : ""}`} state={location.state}>
              SPARQL
            </Link>
          </div>
        )}

        {tab === "workspace" && (
          <>
            <ol className="stepper" aria-label="Change workflow">
              {STEPS.map((label, i) => (
                <li key={label} className={ws.step === i ? "on" : i < ws.step ? "done" : ""}>
                  <button disabled={!ws.canReach(i)} aria-current={ws.step === i ? "step" : undefined} onClick={() => ws.goTo(i)}>
                    <span className="step-num">{i + 1}</span> {label}
                  </button>
                </li>
              ))}
            </ol>
            {ws.committing && <LoadingState label="Committing a new revision…" />}
            <ModularOntologyStep
              step={ws.step}
              baseModules={ws.baseModules}
              baseModel={ws.baseModel}
              baseErr={ws.baseError}
              onBaseFiles={ws.addBaseFiles}
              onRemoveBaseModule={ws.removeBaseModule}
              onEditModule={ws.editModule}
              onExportMerged={ws.exportMerged}
              onStartScratch={() => setTab("induce")}
              authorTab={ws.authorTab}
              onAuthorTab={ws.setAuthorTab}
              draftName={ws.draftName}
              draftTurtle={ws.draftTurtle}
              draftEditId={ws.draftEditId}
              draftErr={ws.draftError}
              onDraftFile={ws.setDraftFromFile}
              onDraftName={ws.setDraftName}
              onDraftTurtle={ws.setDraft}
              onNewBlank={ws.newBlankModule}
              docs={ws.genDocs}
              docBusy={ws.genDocBusy}
              docErr={ws.genDocError}
              onDocFiles={ws.addGenDocs}
              onRemoveDoc={ws.removeGenDoc}
              {...provider}
              guidance={ws.guidance}
              onGuidance={ws.setGuidance}
              baseIri={ws.genBaseIri}
              onBaseIri={ws.setGenBaseIri}
              generating={ws.generating}
              elapsed={ws.generateElapsed}
              onCancel={ws.cancelGeneration}
              onGenerate={(instruction: string) => ws.generateDraft(choice.provider, choice.model, instruction)}
              onRefineDraft={(instruction: string) => ws.refineDraft(choice.provider, choice.model, instruction)}
              report={ws.report}
              onValidate={ws.runValidation}
              onCommit={() => void ws.commitDraft()}
            />
            <div className="page-actions">
              {ws.step > 0 && (
                <button className="btn ghost" onClick={() => ws.setStep(ws.step - 1)}>
                  Back
                </button>
              )}
              <span className="spacer" />
              {ws.step === 0 && (
                <button className="btn" onClick={() => ws.advance(1)}>
                  Author a change <IconArrowRight />
                </button>
              )}
              {ws.step === 1 && (
                <button className="btn" disabled={!ws.draftTurtle.trim()} onClick={() => ws.advance(2)}>
                  Validate <IconArrowRight />
                </button>
              )}
            </div>
          </>
        )}

        {tab === "induce" && <InducePanel />}

        {tab === "terms" && shown && shown.id !== current?.id ? (
          <OntologyReview revisionId={shown.id} />
        ) : (
          tab === "terms" &&
          (currentRev.data ? (
            <TermEditor
              key={currentRev.data.id}
              content={currentRev.data.content}
              onApply={commitContent}
              initialNew={(["class", "object", "data"] as const).find((k) => k === params.get("new")) ?? null}
            />
          ) : (
            <p className="muted">Commit an ontology first; its classes and properties can then be edited here.</p>
          ))
        )}
        {tab === "review" && <OntologyReview revisionId={params.get("rev")} />}

        {tab === "history" && <History />}
        {(tab === "review" || tab === "history") && <OntologyUsage revisionId={tab === "review" ? shown?.id : undefined} />}
      </div>
    </div>
  );
}
