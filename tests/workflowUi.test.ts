import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter, Routes, Route } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../src/lib/projectApi";
import { corpusKeys } from "../src/lib/corpusApi";
import { ProvidersProvider } from "../src/app/providers";
import WorkflowHome from "../src/features/workflows/WorkflowHome";
import WorkflowPage from "../src/features/workflows/WorkflowPage";
import { RunInspector } from "../src/features/research/RunInspector";
import { DocumentSources, SavedChunkConfigurations } from "../src/features/workflows/DocumentSteps";
import type { OntologyRevision, ProjectDocument, RevisionWithContent } from "../src/types/project";

const projectSelection = vi.hoisted(() => ({ id: null as string | null, revisions: [] as OntologyRevision[] }));
vi.mock("../src/app/project", () => ({
  useProject: () => ({
    pid: "p",
    project: { name: "Lab", purpose: "", scope: "", competencyQuestions: [], settings: {}, currentRevisionId: projectSelection.id },
    revisions: projectSelection.revisions,
    current: null,
    drafts: [],
    selectedId: projectSelection.id,
    activeRun: null,
    working: { save: "idle", flush: async () => null },
    driver: { runId: null },
  }),
}));
vi.mock("../src/app/auth", () => ({ useAuth: () => ({ config: { features: {} } }) }));
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("window", { location: { hostname: "localhost" } });
  projectSelection.id = null;
  projectSelection.revisions = [];
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: 0 } } });
  client.setQueryData(qk.documents("p"), []);
  client.setQueryData(qk.runs("p"), []);
});
afterEach(() => vi.unstubAllGlobals());
function render(url: string, home = false) {
  const output = renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client },
      h(
        StaticRouter,
        { location: url },
        home
          ? h(WorkflowHome)
          : h(ProvidersProvider, {
              children: h(Routes, null, h(Route, { path: "/p/:pid/workflows/:workflow", element: h(WorkflowPage) })),
            }),
      ),
    ),
  );
  client.clear();
  return output;
}
const document = { id: "doc", name: "Manual.txt", chunkCount: 1, charCount: 12, parseState: "parsed", parser: "node", kind: "text" };
const run = {
  id: "run",
  kind: "induction",
  documentIds: ["doc"],
  createdAt: "2026-10-01T00:00:00Z",
  status: "ready_for_review",
  steps: [],
  completedSteps: 0,
};
describe("workflow screens", () => {
  const alignmentRevision = (): RevisionWithContent =>
    ({
      id: "alignment-draft",
      status: "draft",
      summary: "Compare equipment vocabularies",
      contentHash: "alignment-content",
      source: "ontology",
      content: {
        modules: [
          {
            id: "source",
            name: "plant.ttl",
            turtle:
              '@prefix : <https://plant.example/#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . :Motor a owl:Class; rdfs:comment "A motor in the plant" . :Pump a owl:Class .',
          },
          {
            id: "target",
            name: "standard.ttl",
            turtle:
              '@prefix : <https://standard.example/#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . :Motor a owl:Class; rdfs:comment "A general motor definition" .',
          },
        ],
        abox: null,
        baseIri: "https://plant.example/#",
        review: {
          alignmentSetup: {
            sourceModules: ["source"],
            targetModules: ["target"],
            matchers: { lexical: true, semantic: false, structural: true },
            verify: false,
            maxSource: 1,
          },
          alignment: [
            {
              id: "mapping",
              source: "https://plant.example/#Motor",
              target: "https://standard.example/#Motor",
              kind: "class",
              relation: "broader",
              score: 0.8,
              verified: false,
              rationale: "Reviewed definitions",
              status: "open",
            },
          ],
        },
      },
    }) as RevisionWithContent;

  it("restores comparison setup and explains partial coverage before matching", () => {
    const revision = alignmentRevision();
    projectSelection.id = revision.id;
    projectSelection.revisions = [revision];
    client.setQueryData(qk.revision("p", revision.id), revision);
    const html = render(`/p/p/workflows/alignment?rev=${revision.id}&step=match`);
    expect(html).toContain("Comparison setup saved");
    expect(html).toContain('<option value="1" selected="">Up to 1 source terms</option>');
    expect(html).toContain("This is a partial comparison.");
    expect(html).toContain("Every source term");
    expect(html).toContain('aria-label="Group for plant.ttl"');
    expect(html).toContain('aria-label="Group for standard.ttl"');
  });

  it("restores paused alignment progress with resume, history and honest background availability", () => {
    const revision = alignmentRevision();
    projectSelection.id = revision.id;
    projectSelection.revisions = [revision];
    client.setQueryData(qk.revision("p", revision.id), revision);
    const paused = {
      ...run,
      kind: "alignment",
      status: "paused",
      baseRevisionId: revision.id,
      lease: null,
      steps: [
        { key: "alignment:retrieve", label: "Find candidate correspondences" },
        { key: "finalize", label: "Prepare the mapping review draft" },
      ],
      completedSteps: 1,
      completedStepKeys: ["alignment:retrieve"],
      usage: { inputTokens: 100, outputTokens: 20 },
      cost: { estimatedUsd: null, actualUsd: null, priced: false },
      alignment: { setup: revision.content.review!.alignmentSetup, estimate: { processedSourceTerms: 1, embeddingCostExcluded: true } },
    };
    client.setQueryData(qk.runs("p"), [paused]);
    client.setQueryData(qk.run("p", paused.id), paused);
    const html = render(`/p/p/workflows/alignment?rev=${revision.id}&step=match&run=${paused.id}`);
    expect(html).toContain("Resume");
    expect(html).toContain("Run history");
    expect(html).toContain("This server has no background worker");
    expect(html).toContain("price unavailable");
    expect(html).toContain("Embedding API charges are additional");
    expect(html).toContain('aria-valuenow="1"');
    expect(html).not.toContain("Your extraction");
  });

  it("shows both term definitions, readable relation direction, bridge preview and review actions", () => {
    const revision = alignmentRevision();
    projectSelection.id = revision.id;
    projectSelection.revisions = [revision];
    client.setQueryData(qk.revision("p", revision.id), revision);
    const html = render(`/p/p/workflows/alignment?rev=${revision.id}&step=merge&review=all&mapping=mapping`);
    expect(html).toContain('aria-label="Source term"');
    expect(html).toContain('aria-label="Target term"');
    expect(html).toContain("A motor in the plant");
    expect(html).toContain("A general motor definition");
    expect(html).toContain("Motor is narrower than Motor");
    expect(html).toContain("&lt;https://plant.example/#Motor&gt; rdfs:subClassOf &lt;https://standard.example/#Motor&gt;");
    expect(html).toContain("Accept mapping");
    expect(html).toContain(">Reject</button>");
    expect(html).toContain(">Defer</button>");
    expect(html).not.toContain("Add anyway");
  });
  it("manages each original once in Upload while retaining the previous build selection", () => {
    const original = { ...document, id: "original", name: "Original.xml", chunkCount: 8 } as ProjectDocument;
    const variant = { ...original, id: "variant", name: "Section variant.xml", variantOf: "original", chunkCount: 52 };
    const html = renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client },
        h(
          StaticRouter,
          { location: "/p/p" },
          h(DocumentSources, {
            pid: "p",
            documents: [original, variant],
            selected: [variant.id],
            previousBuild: { id: "build", documentIds: [variant.id] },
            onSelect: () => {},
            onInspect: () => {},
          }),
        ),
      ),
    );
    expect(html.match(/data-source-id=/g)).toHaveLength(1);
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain('data-document-id="original"');
    expect(html).not.toContain('data-document-id="variant"');
    expect(html).toContain("Original documents");
    expect(html).toContain("View original");
    expect(html).toContain("Delete file");
    expect(html).not.toContain("Chunk configuration for");
    expect(html).not.toContain("saved chunk configurations");
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Section variant.xml");
    expect(html).toContain("Selected for the next build");
    expect(html).toContain("Used in the previous build");
    expect(html).toContain("1 selected · 1 document");
    expect(html).toContain("?run=build&amp;step=sources");
  });
  it("offers saved configurations only in Chunks with the carried-forward variant selected", () => {
    const original = { ...document, id: "original", name: "Original.xml", chunkCount: 0 } as ProjectDocument;
    const variant = { ...original, id: "variant", variantOf: original.id, chunkCount: 52 };
    const html = renderToStaticMarkup(
      h(SavedChunkConfigurations, {
        doc: variant,
        documents: [original, variant],
        selected: [variant.id],
        onUseVariant: () => {},
      }),
    );
    expect(html).toContain("Saved chunk configurations");
    expect(html).toContain('aria-label="Chunk configuration for Original.xml"');
    expect(html).toContain('<option value="variant" selected=""');
    expect(html).toContain("Configure from parsed text");
    expect(html).not.toContain("Delete file");
  });
  it("chunks all selected files by default and keeps the document picker out of the batch view", () => {
    client.setQueryData(qk.documents("p"), [document, { ...document, id: "other", name: "Other.txt" }]);
    client.setQueryData(["chunk-defaults", "p"], { method: "paragraph", maxChars: 12000, overlap: 0.12 });
    const html = render("/p/p/workflows/tbox?step=chunks&docs=doc,other");
    expect(html).toContain("Chunk all selected documents");
    expect(html).toContain("Shared chunk settings");
    expect(html).toContain("Generate chunks for all");
    expect(html).toContain("Use these chunks for all");
    expect(html).toContain("Manual.txt");
    expect(html).toContain("Other.txt");
    expect(html).not.toContain('class="field workflow-document-picker"');
    expect(html.match(/data-chunk-document-id=/g)).toHaveLength(2);
  });
  it("asks legacy selections containing sibling configurations to choose one in Chunks", () => {
    const original = { ...document, id: "original" } as ProjectDocument;
    const variant = { ...original, id: "variant", variantOf: original.id };
    const html = renderToStaticMarkup(
      h(SavedChunkConfigurations, {
        doc: variant,
        documents: [original, variant],
        selected: [original.id, variant.id],
        onUseVariant: () => {},
      }),
    );
    expect(html).toContain("Multiple configurations are selected");
    expect(html).toContain('<option value="" disabled="" selected=""');
  });
  it("recognizes a selected source when viewing its original instead of its saved chunk variant", () => {
    const original = { ...document, id: "original" } as ProjectDocument;
    const variant = { ...original, id: "variant", variantOf: original.id };
    client.setQueryData(qk.documents("p"), [original, variant]);
    const html = render("/p/p/workflows/tbox?step=parse&view=original&doc=original&docs=variant");
    expect(html).toContain("Original file retained");
    expect(html).not.toContain("Inspecting only");
  });
  it("presents ontology and graph workspaces with a compact requirements summary at entry", () => {
    const html = render("/p/p", true);
    for (const path of ["ontology/overview", "graphs", "workflows/tbox?step=requirements"]) expect(html).toContain(`href="/p/p/${path}"`);
    expect(html).not.toContain('href="/p/p/corpora"');
    expect(html.match(/class="navigation-card"/g)).toHaveLength(2);
  });
  it("opens knowledge graph selection without the legacy document-run steps", () => {
    client.setQueryData(corpusKeys.list("p"), [
      { id: "corpus", name: "Plant manuals", settings: { corpus: { members: [{ removed: false }, { removed: true }] } } },
    ]);
    const html = render("/p/p/workflows/abox");
    expect(html).toContain("Knowledge graphs");
    expect(html).toContain("Plant manuals");
    expect(html).toContain("1 documents");
    expect(html).toContain('href="/p/corpus/graph"');
    expect(html).toContain("New knowledge graph");
    expect(html).not.toContain('aria-label="A-Box workflow steps"');
    expect(html).not.toContain('href="/p/p/corpora"');
  });
  it("keeps technical details collapsed and renders only the selected document step", () => {
    client.setQueryData(qk.documents("p"), [document]);
    const html = render("/p/p/workflows/tbox?step=sources");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Add source documents");
    expect(html).toContain('<details class="method-details">');
    expect(html).not.toContain('<details class="method-details" open');
    expect(html).not.toContain("Processing stage");
  });
  it("shows saved parsed text rather than current document content for a historical experiment", () => {
    client.setQueryData(qk.runs("p"), [run]);
    client.setQueryData(qk.run("p", "run"), run);
    client.setQueryData(qk.documentText("p", "doc"), { text: "LIVE TEXT MUST NOT APPEAR", pages: [], chunks: [] });
    client.setQueryData(["run-research", "p", "run"], {
      run,
      checkpoints: [],
      inputs: { documents: [document], documentTexts: { doc: { text: "SAVED ORIGINAL TEXT", pages: [] } }, chunks: [] },
    });
    const html = render("/p/p/workflows/tbox?step=parse&run=run");
    expect(html).toContain("SAVED ORIGINAL TEXT");
    expect(html).not.toContain("LIVE TEXT MUST NOT APPEAR");
    expect(html).toContain("Saved run input");
  });
  it("explicitly marks older missing snapshots instead of using live data", () => {
    client.setQueryData(qk.documents("p"), [document]);
    client.setQueryData(qk.runs("p"), [run]);
    client.setQueryData(qk.run("p", "run"), run);
    client.setQueryData(["run-research", "p", "run"], { run, checkpoints: [], inputs: null });
    const html = render("/p/p/workflows/tbox?step=parse&run=run");
    expect(html).toContain("No recorded source snapshot is available");
    expect(html).not.toContain("Current document");
  });
  it("keeps numerical stage records available while the evidence explorer leads the workflow", () => {
    const savedRun = { ...run, steps: [{ key: "merge", kind: "merge", label: "Consolidation" }], completedSteps: 1 };
    client.setQueryData(qk.runs("p"), [savedRun]);
    client.setQueryData(qk.run("p", "run"), savedRun);
    client.setQueryData(["run-research", "p", "run"], {
      run: savedRun,
      inputs: null,
      checkpoints: [
        {
          key: "merge",
          abox: { individuals: [] },
          notes: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          trace: {
            durationMs: 1,
            technical: [
              {
                title: "Class consolidation comparisons",
                method: "First cosine ≥ 0.93",
                parameters: { cosineThreshold: 0.93 },
                rows: [{ proposal: "Detector", retainedClass: "Sensor", cosine: 0.954321, decision: "Merge" }],
                columns: ["proposal", "retainedClass", "cosine", "decision"],
              },
            ],
          },
        },
      ],
    });
    const technical = renderToStaticMarkup(
      h(QueryClientProvider, { client }, h(StaticRouter, { location: "/p/p" }, h(RunInspector, { pid: "p", runId: "run", compact: true }))),
    );
    expect(technical).toContain("Class consolidation comparisons");
    expect(technical).toContain("0.954321");
    expect(technical).toContain("Detector");
    expect(technical).toContain("Export measurements");
    const html = render("/p/p/workflows/tbox?step=results&run=run");
    expect(html).toContain("Explore topics and their sources");
    expect(html).toContain("Technical details &amp; stage records");
    expect(html).not.toContain("0.954321");
  });
  it("keeps one validation action in the footer and places editing beside the result", () => {
    const complete = { ...run, resultRevisionId: "result" };
    client.setQueryData(qk.runs("p"), [complete]);
    client.setQueryData(qk.run("p", "run"), complete);
    client.setQueryData(qk.revision("p", "result"), {
      id: "result",
      status: "draft",
      content: { modules: [], abox: null, baseIri: "" },
      stats: { classes: 0, objectProperties: 0, dataProperties: 0 },
    });
    client.setQueryData(["run-research", "p", "run"], { run: complete, checkpoints: [], inputs: null });
    const html = render("/p/p/workflows/tbox?step=results&run=run");
    expect(html).not.toContain("Validate result");
    expect(html).not.toContain("Review &amp; edit result");
    expect(html).toContain("Review &amp; edit ontology");
    expect(html.match(/Next: Validate &amp; save version/g)).toHaveLength(1);
  });
  it("requires a prepared draft before template review and validation", () => {
    const html = render("/p/p/workflows/tbox?start=template&step=start");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Review &amp; edit/s);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Validate &amp; save version/s);
    expect(html).not.toContain("Parsed text");
    expect(html).not.toContain("Next:");
  });
  it("keeps review available after saving clears the revision URL parameter", () => {
    projectSelection.id = "saved";
    client.setQueryData(qk.revision("p", "saved"), {
      id: "saved",
      number: 1,
      status: "committed",
      content: { modules: [], abox: null, baseIri: "" },
    });
    const html = render("/p/p/workflows/tbox?start=template&step=validate");
    const nav = html.split('aria-label="T-Box workflow steps"')[1].split("</nav>")[0];
    expect(nav).toContain("Review &amp; edit");
    expect(nav).not.toContain('disabled=""');
    expect(html).toContain("Ontology version saved");
    expect(html).toContain("New knowledge graph using this ontology");
    expect(html).toContain('href="/p/p/graphs?ontology=saved"');
  });
  it("continues the selected ontology without asking for the version again", () => {
    projectSelection.id = "saved";
    projectSelection.revisions = [
      { id: "saved", status: "committed", number: 2, summary: "Selected science schema", stats: { modules: 1, classes: 27 } },
    ] as OntologyRevision[];
    client.setQueryData(qk.runs("p"), []);
    const html = render("/p/p/workflows/tbox?rev=saved");
    expect(html).toContain("Continue selected ontology");
    expect(html).toContain("Selected science schema");
    expect(html).toContain("Edit a new draft");
    expect(html).toContain("Improve with documents");
    expect(html).not.toContain('name="ontology-previous"');
    expect(html).not.toContain("Continue previous work");
  });
  it("offers starting options on project entry without showing document steps first", () => {
    const html = render("/p/p/workflows/tbox");
    expect(html).toContain("Start a new ontology");
    expect(html).toContain("From documents");
    expect(html).toContain("From a template");
    expect(html).toContain("Import an ontology");
    expect(html).not.toContain("Add source documents");
    expect(html).not.toContain("Continue previous work");
  });
  it.each(["review", "validate"])("exposes document iteration from %s with the original build settings and exact variants", (step) => {
    projectSelection.id = "saved";
    projectSelection.revisions = [
      { id: "draft", status: "draft", parentId: "saved" },
      { id: "saved", status: "committed", parentId: null, runId: "original" },
    ] as OntologyRevision[];
    client.setQueryData(qk.runs("p"), [{ ...run, id: "original", resultRevisionId: "saved", documentIds: ["original-variant"] }]);
    client.setQueryData(qk.revision("p", "draft"), {
      id: "draft",
      parentId: "saved",
      status: "draft",
      content: { modules: [], abox: null, baseIri: "" },
    });
    const html = render(`/p/p/workflows/tbox?start=previous&step=${step}&rev=draft`);
    expect(html).toContain('<section class="ontology-build-actions"');
    expect(html).toContain("Improve with documents");
    expect(html).toContain("Add or change documents");
    expect(html).toContain("Change chunks &amp; embeddings");
    expect(html).toContain("Generation settings");
    for (const target of ["sources", "chunks", "generate"]) {
      expect(html).toContain(`start=documents&amp;step=${target}&amp;base=draft&amp;from=original&amp;docs=original-variant`);
    }
    expect(html).toContain("Your previous document selection and build settings are carried forward");
  });
  it("shows the recorded chunk method and boundary measurements without opening settings", () => {
    client.setQueryData(qk.runs("p"), [run]);
    client.setQueryData(qk.run("p", "run"), run);
    client.setQueryData(["run-research", "p", "run"], {
      run,
      checkpoints: [],
      inputs: {
        documents: [{ ...document, preprocessing: { settings: { method: "fixed", maxChars: 200, overlap: 0.1 } } }],
        chunks: [{ id: "c", documentId: "doc", ordinal: 0, text: "Source", start: 0, end: 6, overlap: 0 }],
      },
    });
    const html = render("/p/p/workflows/tbox?step=chunks&run=run");
    expect(html).toContain("Chunking method: ");
    expect(html).toContain("Fixed character windows");
    expect(html).toContain("Chunk boundary measurements");
    expect(html).toContain("requested overlap: ");
  });
});
