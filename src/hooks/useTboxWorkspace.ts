import { useCallback, useEffect, useMemo, useState } from "react";
import { parseTBox, mergeTBox } from "../lib/ontology/tboxParser";
import { validateOntology } from "../lib/ontology/validate";
import { fileToDocEntry, toExtractDoc, type DocEntry } from "../lib/docs";
import { generateTbox, type ProviderId } from "../lib/api";
import { downloadText, uid } from "../lib/format";
import { api as projectApi } from "../lib/projectApi";
import { useCancellableRun } from "./useCancellableRun";
import type { TBoxModel } from "../types/tbox";
import type { OntoModule, ValidationReport } from "../types/validation";
import type { StandardsOnto } from "../components/generate/BuildWithAiPage";

const ONTO_RE = /\.(ttl|owl|rdf|xml|n3|nt|turtle|jsonld)$/i;
/** Standards (FIBO, SNOMED, schema.org) often ship as RDF/XML or JSON-LD: converted to Turtle on import. */
const NON_TURTLE_RE = /\.(owl|rdf|xml|jsonld)$/i;

export type AuthorTab = "upload" | "ai" | "edit";

/**
 * The T-Box Generation workspace: load a base ontology, author a change
 * (upload / AI / by hand), validate it against the base, commit.
 *
 * Separate from the A-Box pipeline — the two used to share `generating` and
 * `draftErr`, so an error from one workflow surfaced in the other.
 */
/**
 * Controlled mode (project workspace): the base modules are the current
 * committed revision's, and every change to them — importing, removing, or
 * committing a validated candidate — is handed to `commit`, which records a
 * new revision. Without it the hook keeps the modules in local state.
 */
export interface TboxControl {
  modules: OntoModule[];
  commit: (modules: OntoModule[], summary: string) => Promise<void>;
}

export function useTboxWorkspace(seedSavedCqs: (questions: string[]) => void, control?: TboxControl) {
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [ownModules, setOwnModules] = useState<OntoModule[]>([]);
  const baseModules = control ? control.modules : ownModules;
  const [committing, setCommitting] = useState(false);
  const applyBase = useCallback(
    async (next: OntoModule[], summary: string): Promise<boolean> => {
      if (!control) {
        setOwnModules(next);
        return true;
      }
      setCommitting(true);
      try {
        await control.commit(next, summary);
        return true;
      } catch (e) {
        setBaseError(e instanceof Error ? e.message : "Could not save the change.");
        return false;
      } finally {
        setCommitting(false);
      }
    },
    [control],
  );
  const [baseError, setBaseError] = useState<string | null>(null);

  const [authorTab, setAuthorTab] = useState<AuthorTab>("upload");
  const [draftName, setDraftName] = useState("");
  const [draftTurtle, setDraftTurtle] = useState("");
  const [draftEditId, setDraftEditId] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);

  const [genDocs, setGenDocs] = useState<DocEntry[]>([]);
  const [genDocBusy, setGenDocBusy] = useState(false);
  const [genDocError, setGenDocError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [genBaseIri, setGenBaseIri] = useState("");
  const generation = useCancellableRun();

  // Build with AI page
  const [buildAiOpen, setBuildAiOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState("");
  const [cqs, setCqs] = useState<string[]>([]);
  const [standardsOntos, setStandardsOntos] = useState<StandardsOnto[]>([]);
  const [standardsOntoError, setStandardsOntoError] = useState<string | null>(null);
  const [standardsDocs, setStandardsDocs] = useState<DocEntry[]>([]);
  const [standardsDocBusy, setStandardsDocBusy] = useState(false);
  const [standardsDocError, setStandardsDocError] = useState<string | null>(null);

  const baseModel = useMemo<TBoxModel | null>(() => {
    if (!baseModules.length) return null;
    const models: TBoxModel[] = [];
    for (const m of baseModules) {
      try {
        models.push(parseTBox(m.turtle));
      } catch {
        /* unparseable modules are reported at upload time */
      }
    }
    return models.length ? mergeTBox(models) : null;
  }, [baseModules]);

  const canReach = useCallback((i: number) => i <= 0 || i <= maxReached, [maxReached]);
  const goTo = useCallback((i: number) => setStep((prev) => (i <= maxReached ? i : prev)), [maxReached]);
  const advance = useCallback((to: number) => {
    setMaxReached((m) => Math.max(m, to));
    setStep(to);
  }, []);

  const baseTurtleContext = useCallback(() => baseModules.map((m) => `# ── ${m.name} ──\n${m.turtle}`).join("\n\n"), [baseModules]);

  /* ── loading ontology files ── */

  const loadOntoFiles = async (files: File[]): Promise<{ loaded: { name: string; turtle: string }[]; failed: string[] }> => {
    const onto = files.filter((f) => ONTO_RE.test(f.name));
    const loaded: { name: string; turtle: string }[] = [];
    const failed: string[] = [];
    for (const f of onto) {
      const text = await f.text();
      try {
        parseTBox(text);
        loaded.push({ name: f.name, turtle: text });
        continue;
      } catch {
        /* not Turtle: try converting below */
      }
      try {
        if (!NON_TURTLE_RE.test(f.name) && !/^\s*(<\?xml|<rdf:RDF|\{|\[)/.test(text)) throw new Error("not RDF");
        const { turtle } = await projectApi.convertRdf(f.name, text);
        parseTBox(turtle);
        loaded.push({ name: f.name.replace(/\.[^.]+$/, "") + ".ttl", turtle });
      } catch {
        failed.push(f.name);
      }
    }
    return { loaded, failed };
  };

  const addBaseFiles = useCallback(async (files: File[]) => {
    setBaseError(null);
    const { loaded, failed } = await loadOntoFiles(files);
    if (!loaded.length) {
      setBaseError(failed.length ? `Could not parse: ${failed.join(", ")}` : "No ontology files (.ttl / .owl / .rdf / .jsonld / .n3) in the selection.");
      return;
    }
    const ok = await applyBase([...baseModules, ...loaded.map((l) => ({ id: uid("mod"), ...l }))], `Imported ${loaded.map((l) => l.name).join(", ")}`);
    setReport(null);
    if (ok && failed.length) setBaseError(`Loaded ${loaded.length} module(s); skipped ${failed.length} with parse errors: ${failed.join(", ")}`);
  }, [applyBase, baseModules]);

  const removeBaseModule = useCallback(
    (id: string) => {
      const m = baseModules.find((x) => x.id === id);
      void applyBase(
        baseModules.filter((x) => x.id !== id),
        `Removed module ${m?.name ?? id}`,
      );
      setReport(null);
    },
    [applyBase, baseModules],
  );

  const addStandardsOntos = useCallback(async (files: File[]) => {
    setStandardsOntoError(null);
    const { loaded, failed } = await loadOntoFiles(files);
    if (!loaded.length) {
      setStandardsOntoError(
        failed.length
          ? `Could not parse: ${failed.join(", ")} (RDF/XML files must be converted to Turtle)`
          : "No ontology files (.ttl / .owl / .rdf / .jsonld / .n3) in the selection.",
      );
      return;
    }
    setStandardsOntos((prev) => [...prev, ...loaded.map((l) => ({ id: uid("std"), ...l, model: parseTBox(l.turtle) }))]);
    if (failed.length) setStandardsOntoError(`Loaded ${loaded.length}; skipped ${failed.length} with parse errors: ${failed.join(", ")}`);
  }, []);

  const removeStandardsOnto = useCallback((id: string) => setStandardsOntos((prev) => prev.filter((s) => s.id !== id)), []);

  /* ── documents ── */

  const readDocs = async (files: File[], setBusy: (b: boolean) => void, setErr: (e: string | null) => void, add: (entries: DocEntry[]) => void) => {
    setErr(null);
    setBusy(true);
    try {
      const entries: DocEntry[] = [];
      const failures: string[] = [];
      for (const f of files) {
        try {
          entries.push(await fileToDocEntry(f));
        } catch (e) {
          failures.push(`${f.name} (${e instanceof Error ? e.message : "unreadable"})`);
        }
      }
      if (entries.length) add(entries);
      if (failures.length) setErr(`Could not read: ${failures.join(", ")}`);
    } finally {
      setBusy(false);
    }
  };

  const addGenDocs = useCallback(
    (files: File[]) => readDocs(files, setGenDocBusy, setGenDocError, (e) => setGenDocs((prev) => [...prev, ...e])),
    [],
  );
  const removeGenDoc = useCallback((id: string) => setGenDocs((prev) => prev.filter((d) => d.id !== id)), []);

  const addStandardsDocs = useCallback(
    (files: File[]) => readDocs(files, setStandardsDocBusy, setStandardsDocError, (e) => setStandardsDocs((prev) => [...prev, ...e])),
    [],
  );
  const removeStandardsDoc = useCallback((id: string) => setStandardsDocs((prev) => prev.filter((d) => d.id !== id)), []);

  /* ── generation ── */

  const generateFromBuildPage = useCallback(
    async (provider: ProviderId, model: string) => {
      const questions = cqs.map((q) => q.trim()).filter(Boolean);
      setReport(null);
      await generation.run(
        (signal) =>
          generateTbox(
            {
              documents: genDocs.map(toExtractDoc),
              provider,
              model,
              baseIri: genBaseIri || baseModel?.baseIri || undefined,
              guidance: guidance.trim() || undefined,
              baseTurtle: baseModules.length ? baseTurtleContext() : undefined,
              purpose: purpose.trim() || undefined,
              scope: scope.trim() || undefined,
              competencyQuestions: questions,
              standardsOntologies: standardsOntos.map((s) => ({ name: s.name, turtle: s.turtle })),
              standardsDocuments: standardsDocs.map(toExtractDoc),
            },
            { signal },
          ),
        (r) => {
          setDraftName(`module-${baseModules.length + 1}.ttl`);
          setDraftTurtle(r.turtle);
          setDraftEditId(null);
          setAuthorTab("edit");
          advance(1);
          setBuildAiOpen(false);
          seedSavedCqs(questions);
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cqs, genDocs, genBaseIri, baseModel, guidance, baseModules, baseTurtleContext, purpose, scope, standardsOntos, standardsDocs, advance, generation.run, seedSavedCqs],
  );

  const generateDraft = useCallback(
    async (provider: ProviderId, model: string, instruction: string) => {
      setReport(null);
      await generation.run(
        (signal) =>
          generateTbox(
            {
              documents: genDocs.map(toExtractDoc),
              provider,
              model,
              baseIri: genBaseIri || baseModel?.baseIri || undefined,
              guidance: guidance.trim() || undefined,
              instruction: instruction || undefined,
              baseTurtle: baseModules.length ? baseTurtleContext() : undefined,
            },
            { signal },
          ),
        (r) => {
          setDraftName(`module-${baseModules.length + 1}.ttl`);
          setDraftTurtle(r.turtle);
          setDraftEditId(null);
          setAuthorTab("edit");
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [genDocs, genBaseIri, baseModel, guidance, baseModules, baseTurtleContext, generation.run],
  );

  const refineDraft = useCallback(
    async (provider: ProviderId, model: string, instruction: string) => {
      if (!instruction.trim() || !draftTurtle.trim()) return;
      setReport(null);
      await generation.run(
        (signal) =>
          generateTbox(
            { documents: [], provider, model, baseIri: genBaseIri || baseModel?.baseIri || undefined, currentTurtle: draftTurtle, instruction },
            { signal },
          ),
        (r) => setDraftTurtle(r.turtle),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftTurtle, genBaseIri, baseModel, generation.run],
  );

  /* ── authoring ── */

  const setDraftFromFile = useCallback(async (files: File[]) => {
    const f = files.find((x) => ONTO_RE.test(x.name));
    if (!f) {
      generation.setError("Pick a .ttl / .owl / .rdf / .n3 file.");
      return;
    }
    try {
      const turtle = await f.text();
      setDraftName(f.name);
      setDraftTurtle(turtle);
      setDraftEditId(null);
      generation.setError(null);
      setReport(null);
    } catch (e) {
      generation.setError(e instanceof Error ? e.message : "Could not read the file.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editModule = useCallback(
    (id: string) => {
      const m = baseModules.find((x) => x.id === id);
      if (!m) return;
      setDraftName(m.name);
      setDraftTurtle(m.turtle);
      setDraftEditId(id);
      generation.setError(null);
      setReport(null);
      setAuthorTab("edit");
      advance(1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseModules, advance],
  );

  const newBlankModule = useCallback(() => {
    const ns = baseModel?.baseIri ?? "http://ontolab.example/onto#";
    setDraftName("new-module.ttl");
    setDraftTurtle(
      `@prefix : <${ns}> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n`,
    );
    setDraftEditId(null);
    generation.setError(null);
    setReport(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseModel]);

  const setDraft = useCallback((v: string) => {
    setDraftTurtle(v);
    setReport(null);
  }, []);

  const runValidation = useCallback(() => {
    if (!draftTurtle.trim()) {
      generation.setError("Nothing to validate yet — author a module first.");
      return;
    }
    generation.setError(null);
    setReport(validateOntology(baseModules, { id: draftEditId ?? undefined, name: draftName || "draft.ttl", turtle: draftTurtle }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTurtle, baseModules, draftEditId, draftName]);

  const commitDraft = useCallback(async () => {
    if (!report?.ok) return;
    const name = draftName || `module-${baseModules.length + 1}.ttl`;
    const next = draftEditId
      ? baseModules.map((m) => (m.id === draftEditId ? { ...m, name: draftName, turtle: draftTurtle } : m))
      : [...baseModules, { id: uid("mod"), name, turtle: draftTurtle }];
    const ok = await applyBase(next, draftEditId ? `Changed module ${name}` : `Added module ${name}`);
    if (!ok) return;
    setDraftName("");
    setDraftTurtle("");
    setDraftEditId(null);
    setReport(null);
    setAuthorTab("upload");
    setStep(0);
  }, [report, draftEditId, draftName, draftTurtle, baseModules, applyBase]);

  const exportMerged = useCallback(() => {
    downloadText(baseTurtleContext(), "ontology-merged.ttl", "text/turtle;charset=utf-8");
  }, [baseTurtleContext]);

  // Leaving step 1/2 with nothing authored should not strand the user there.
  useEffect(() => {
    if (step === 2 && !draftTurtle.trim()) setStep(1);
  }, [step, draftTurtle]);

  return {
    step,
    goTo,
    advance,
    canReach,
    setStep,
    baseModules,
    baseModel,
    baseError,
    addBaseFiles,
    removeBaseModule,
    exportMerged,
    committing,

    authorTab,
    setAuthorTab,
    draftName,
    setDraftName,
    draftTurtle,
    setDraft,
    draftEditId,
    draftError: generation.error,
    setDraftFromFile,
    editModule,
    newBlankModule,
    report,
    runValidation,
    commitDraft,

    genDocs,
    genDocBusy,
    genDocError,
    addGenDocs,
    removeGenDoc,
    guidance,
    setGuidance,
    genBaseIri,
    setGenBaseIri,
    generating: generation.running,
    generateElapsed: generation.elapsed,
    cancelGeneration: generation.cancel,
    generateDraft,
    refineDraft,
    generateFromBuildPage,

    buildAiOpen,
    setBuildAiOpen,
    purpose,
    setPurpose,
    scope,
    setScope,
    cqs,
    setCqs,
    standardsOntos,
    standardsOntoError,
    addStandardsOntos,
    removeStandardsOnto,
    standardsDocs,
    standardsDocBusy,
    standardsDocError,
    addStandardsDocs,
    removeStandardsDoc,
  };
}

export type TboxWorkspace = ReturnType<typeof useTboxWorkspace>;
