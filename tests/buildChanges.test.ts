import { describe, expect, it } from "vitest";
import { buildSourceRelation, isUnchangedInductionBuild, summarizeBuildSources } from "../src/lib/buildChanges";
import type { ProjectDocument } from "../src/types/project";
import type { OntologyRevision, Project, RunView } from "../src/types/project";
import type { RunResearch } from "../src/types/research";
import { findOntologyBuild, ontologyBuildParams } from "../src/lib/ontologyBuild";

const source = (id: string, variantOf?: string) => ({ id, variantOf }) as ProjectDocument;
describe("build preparation change summary", () => {
  it("does not mark an original file or sibling chunk variant as the exact input used by a build", () => {
    const original = source("original");
    const used = source("used-52-chunks", "original");
    const sibling = source("other-8-chunks", "original");
    const docs = [original, used, sibling, source("unrelated")];
    expect(buildSourceRelation(used, [used.id], docs)).toBe("exact");
    expect(buildSourceRelation(original, [used.id], docs)).toBe("related");
    expect(buildSourceRelation(sibling, [used.id], docs)).toBe("related");
    expect(buildSourceRelation(source("unrelated"), [used.id], docs)).toBe("other");
  });
  it("can use a saved variant relationship after the original input is removed from the project", () => {
    expect(buildSourceRelation(source("original"), ["deleted-variant"], [source("deleted-variant", "original")])).toBe("related");
    expect(buildSourceRelation(source("original"), ["deleted-variant"], [])).toBe("other");
  });
  it("recognizes a chunk variant as the same source with a new configuration", () => {
    expect(summarizeBuildSources([source("original")], [source("new-chunks", "original")])).toEqual({
      added: 0,
      removed: 0,
      reconfigured: 1,
      embeddingChanged: 0,
    });
  });
  it("reports independent document additions and removals", () => {
    expect(summarizeBuildSources([source("a"), source("b")], [source("a"), source("c")])).toEqual({
      added: 1,
      removed: 1,
      reconfigured: 0,
      embeddingChanged: 0,
    });
  });
});

describe("continuing an ontology version", () => {
  const revisions = [
    { id: "draft", parentId: "manual" },
    { id: "manual", parentId: "saved" },
    { id: "saved", parentId: null, runId: "original" },
  ] as OntologyRevision[];
  const original = { id: "original", kind: "induction", resultRevisionId: "saved", documentIds: ["used-variant", "second"] } as RunView;
  it("recovers the originating build through manual drafts and saved versions", () => {
    expect(findOntologyBuild("draft", revisions, [original])).toBe(original);
    const params = ontologyBuildParams("draft", "chunks", original);
    expect(Object.fromEntries(params)).toEqual({
      start: "documents",
      step: "chunks",
      base: "draft",
      from: "original",
      docs: "used-variant,second",
    });
    expect(params.has("run")).toBe(false);
    expect(params.has("rev")).toBe(false);
  });
  it("uses explicit build provenance when a copied older version has a different current parent", () => {
    const older = { ...original, id: "older", resultRevisionId: "older-version" };
    expect(findOntologyBuild("draft", revisions, [original, older], "older")).toBe(older);
    expect(findOntologyBuild("draft", revisions, [original], "missing")).toBe(original);
  });
  it("does not use extraction settings and tolerates missing or cyclic ancestry", () => {
    expect(findOntologyBuild("saved", revisions, [{ ...original, kind: "extraction" }])).toBeUndefined();
    expect(findOntologyBuild("import", [], [original])).toBeUndefined();
    expect(findOntologyBuild("cycle", [{ id: "cycle", parentId: "cycle" }] as OntologyRevision[], [])).toBeUndefined();
    expect(Object.fromEntries(ontologyBuildParams("import", "sources"))).toEqual({ start: "documents", step: "sources", base: "import" });
  });
  it("keeps an explicitly empty original document selection empty", () => {
    expect(ontologyBuildParams("saved", "generate", { ...original, documentIds: [] }).get("docs")).toBe("");
  });
});

describe("avoiding an unchanged ontology rebuild", () => {
  const project = { purpose: "Find claims", scope: "Research", settings: {}, competencyQuestions: ["Which claims?"] } as Project;
  const document = { id: "doc", checksum: "original", parser: "text", charCount: 100, chunkCount: 2 } as ProjectDocument;
  const previous = {
    run: {
      id: "build",
      kind: "induction",
      status: "ready_for_review",
      resultRevisionId: "result",
      provider: "codex-cli",
      model: "model",
      options: { reasoningEffort: "low" },
    },
    inputs: {
      documents: [document],
      baseRevision: null,
      requirements: {
        purpose: project.purpose,
        scope: project.scope,
        requirements: null,
        competencyQuestions: project.competencyQuestions,
      },
    },
  } as RunResearch;
  const next = {
    documents: [document],
    starting: null,
    project,
    provider: "codex-cli",
    model: "model",
    options: { reasoningEffort: "low" },
  };

  it("matches default and explicit ablations, independently of object key ordering", () => {
    expect(isUnchangedInductionBuild(previous, next)).toBe(true);
    expect(
      isUnchangedInductionBuild(previous, {
        ...next,
        options: { ...next.options, cqGuided: true, repair: true, strictGrounding: false, inductionAxioms: true },
      }),
    ).toBe(true);
  });
  it("allows an improvement pass starting from the previous result", () => {
    expect(
      isUnchangedInductionBuild(previous, { ...next, starting: { id: "result", contentHash: "new-ontology" } as OntologyRevision }),
    ).toBe(false);
  });
  it("detects edits to a starting draft even when its ID stays the same", () => {
    const withBase = {
      ...previous,
      inputs: { ...previous.inputs!, baseRevision: { id: "draft", contentHash: "before", content: {} } },
    } as RunResearch;
    expect(isUnchangedInductionBuild(withBase, { ...next, starting: { id: "draft", contentHash: "before" } as OntologyRevision })).toBe(
      true,
    );
    expect(isUnchangedInductionBuild(withBase, { ...next, starting: { id: "draft", contentHash: "after" } as OntologyRevision })).toBe(
      false,
    );
  });
  it("allows changed documents, chunk configurations and membership", () => {
    for (const documents of [
      [],
      [{ ...document, checksum: "changed" }],
      [{ ...document, chunkCount: 3 }],
      [{ ...document, id: "variant" }],
      [document, { ...document, id: "added" }],
    ]) {
      expect(isUnchangedInductionBuild(previous, { ...next, documents })).toBe(false);
    }
  });
  it("allows a changed provider, model, reasoning effort or ablation", () => {
    for (const patch of [
      { provider: "other" },
      { model: "other" },
      { options: { reasoningEffort: "high" } },
      { options: { ...next.options, repair: false } },
    ]) {
      expect(isUnchangedInductionBuild(previous, { ...next, ...patch })).toBe(false);
    }
  });
  it("allows changes in guiding requirements", () => {
    expect(isUnchangedInductionBuild(previous, { ...next, project: { ...project, purpose: "Changed" } })).toBe(false);
    const unguided = { ...previous, run: { ...previous.run, options: { ...previous.run.options, cqGuided: false } } } as RunResearch;
    expect(
      isUnchangedInductionBuild(unguided, {
        ...next,
        options: { ...next.options, cqGuided: false },
        project: { ...project, purpose: "Changed" },
      }),
    ).toBe(true);
  });
  it("keeps retries and incomplete historical records buildable", () => {
    expect(isUnchangedInductionBuild(undefined, next)).toBe(false);
    expect(isUnchangedInductionBuild({ ...previous, inputs: null }, next)).toBe(false);
    expect(isUnchangedInductionBuild({ ...previous, inputs: { ...previous.inputs!, baseRevision: undefined } }, next)).toBe(false);
    for (const status of ["failed", "cancelled", "running"] as const) {
      expect(isUnchangedInductionBuild({ ...previous, run: { ...previous.run, status } }, next)).toBe(false);
    }
  });
});
