import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersProvider } from "../src/app/providers";
import { CorpusScopeBar } from "../src/features/corpora/CorpusScopeBar";
import CorpusPage from "../src/features/corpora/CorpusPage";
import { CorpusReview } from "../src/features/corpora/CorpusReview";
import { CorpusHistory } from "../src/features/corpora/CorpusUpdates";
import { corpusKeys, type CorpusDetail } from "../src/lib/corpusApi";
import { qk } from "../src/lib/projectApi";
import { corpusChanges, documentOrigins, withoutSources } from "../src/lib/corpusGraph";
import { corpusPlanSummary } from "../src/lib/corpusWorkflow";
import type { WorkingCopy } from "../src/app/project";
import type { CorpusPlan } from "../src/types/corpus";
import type { Project, RevisionContent, RevisionWithContent } from "../src/types/project";
import { parseTBox } from "../src/lib/ontology/tboxParser";

const state = vi.hoisted(() => ({ project: {} as Project, working: {} as WorkingCopy }));
vi.mock("../src/app/project", () => ({
  useProject: () => ({ pid: "cor", project: state.project, working: state.working, activeRun: null, driver: { start: vi.fn() } }),
}));
vi.mock("../src/app/auth", () => ({ useAuth: () => ({ config: { features: { worker: false } } }) }));
let client: QueryClient;
const cls = "http://ex/Pump",
  prop = "http://ex/pressure";
const pin = { projectId: "parent", revisionId: "ontology", number: 1, hash: "schema", name: "Equipment" };
const oldGraph = (): RevisionContent => ({
  modules: [],
  abox: documentOrigins(
    {
      individuals: [
        {
          id: "p101",
          classUri: cls,
          label: "Pump P-101",
          review: { by: "user", status: "accepted" },
          dataProperties: [{ propUri: prop, value: "6", review: { by: "user", status: "accepted" } }],
        },
        { id: "unchanged", classUri: cls, label: "Unchanged pump", review: { by: "user", status: "accepted" } },
      ],
    },
    "old",
    "chunk",
    "run",
  ),
  corpus: { ontology: pin, sources: [], suppressed: [], losses: [] },
});
const revision = (id: string, content: RevisionContent): RevisionWithContent => ({
  id,
  projectId: "cor",
  parentId: null,
  number: 1,
  status: "committed",
  source: "extraction",
  summary: "Equipment graph",
  contentHash: id,
  stats: { modules: 1, classes: 1, individuals: content.abox?.individuals.length ?? 0, assertions: 1 },
  createdBy: "user",
  createdAt: "2026-10-31T10:00:00Z",
  updatedAt: "2026-10-31T10:00:00Z",
  content,
});
beforeEach(() => {
  vi.stubGlobal("window", { location: { hostname: "localhost" } });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: 0 } } });
  state.project = {
    id: "cor",
    name: "Plant A",
    settings: {
      corpus: { version: 1, parentProjectId: "parent", parentName: "Equipment", members: [], requestedOntologyRevisionId: "ontology" },
    },
  } as Project;
  state.working = {
    revision: null,
    content: null,
    tbox: null,
    save: "idle",
    flush: vi.fn(),
    setContent: vi.fn(),
  } as unknown as WorkingCopy;
  client.setQueryData(qk.documents("cor"), []);
});
afterEach(() => vi.unstubAllGlobals());
function render(node: ReturnType<typeof h>, path = "/p/cor/workflows/abox") {
  const html = renderToStaticMarkup(
    h(QueryClientProvider, { client }, h(StaticRouter, { location: path }, h(ProvidersProvider, { children: node }))),
  );
  client.clear();
  return html;
}
function renderReview(content: RevisionContent, original = oldGraph()) {
  const base = revision("saved", original);
  const draft = { ...revision("draft", content), parentId: base.id, status: "draft" as const, number: null };
  state.working = { ...state.working, revision: draft, content };
  client.setQueryData(corpusKeys.review("cor", "draft"), {
    revision: draft,
    base,
    current: base,
    changes: corpusChanges(original.abox!, content.abox!),
    findings: [],
    stale: false,
  });
  return render(h(CorpusReview, { pid: "cor", revisionId: "draft", refresh: () => {} }), "/p/cor/workflows/abox?tab=updates&rev=draft");
}
describe("continuous ABox workflow", () => {
  it("offers a direct graph update for changed documents while keeping the saved version visible", () => {
    const graph = revision("saved", oldGraph());
    const detail: CorpusDetail = { corpus: state.project, graph, documents: [], revisions: [graph] };
    const plan: CorpusPlan = {
      corpusId: "cor",
      hash: "plan",
      mode: "changes",
      ontology: pin,
      currentOntology: pin,
      baseRevisionId: graph.id,
      sources: [],
      processDocumentIds: ["new"],
      removeDocumentIds: [],
      reused: 2,
      errors: [],
      warnings: [],
      estimatedUsd: 0.02,
      calls: 1,
      inputTokens: 100,
      outputTokens: 100,
      affected: { lost: 0, retained: 0 },
    };
    client.setQueryData(corpusKeys.detail("cor"), detail);
    client.setQueryData([...corpusKeys.plan("cor"), "changes", [], 1, []], plan);
    state.working = { ...state.working, revision: graph, content: graph.content };
    const html = render(h(Fragment, null, h(CorpusScopeBar), h(CorpusPage)));
    expect(html).toContain("Update knowledge graph");
    expect(html).toContain("Graph version 1");
    expect(html).toContain("Ontology v1 · pinned");
    expect(html).toContain("Your saved graph stays available");
    expect(html).not.toContain("Review extraction plan");
  });
  it("defaults review to entity changes, compares old and new values, and leaves unchanged facts out of the list", () => {
    const base = revision("saved", oldGraph());
    const content = structuredClone(base.content);
    content.abox!.individuals[0].dataProperties![0].value = "5";
    content.abox!.individuals[0].dataProperties![0].review = { by: "auto", status: "candidate" };
    content.corpus!.losses = withoutSources(base.content.abox!, new Set(["old"])).losses.filter((l) => l.fact.kind === "data");
    const draft = { ...revision("draft", content), parentId: base.id, status: "draft" as const, number: null };
    state.working = { ...state.working, revision: draft, content };
    client.setQueryData(corpusKeys.review("cor", "draft"), {
      revision: draft,
      base,
      current: base,
      changes: corpusChanges(base.content.abox!, content.abox!),
      findings: [],
      stale: false,
    });
    const html = render(
      h(CorpusReview, { pid: "cor", revisionId: "draft", refresh: () => {} }),
      "/p/cor/workflows/abox?tab=updates&rev=draft",
    );
    const list = html.split('aria-label="Changed facts"')[1].split('aria-label="Selected fact and evidence"')[0];
    expect(list).toContain("Pump P-101");
    expect(list).not.toContain("Unchanged pump");
    expect(html).toContain("Previous value");
    expect(html).toContain("Proposed value");
    expect(html).toContain("Use proposed value");
    expect(html).toContain("Save graph update");
  });
  it("describes a replacement distinctly from a new file or unchanged source", () => {
    const plan = {
      sources: [
        { document: { id: "new", checksum: "new" } },
        { document: { id: "v2", checksum: "updated" }, previous: { checksum: "original" } },
      ],
      processDocumentIds: ["new", "v2"],
      reused: 3,
    } as CorpusPlan;
    expect(corpusPlanSummary(plan)).toBe("1 new document · 1 replacement. 3 unchanged documents reused.");
  });
  it("keeps source-support and review-only changes in the default list without duplicating facts", () => {
    const original = oldGraph(),
      content = structuredClone(original);
    content.abox!.individuals[0].origins = [{ kind: "manual" }];
    content.abox!.individuals[0].review = { by: "user", status: "rejected" };
    const html = renderReview(content, original);
    const list = html.split('aria-label="Changed facts"')[1].split('aria-label="Selected fact and evidence"')[0];
    expect(list.match(/is a Pump/g)).toHaveLength(1);
    expect(list).not.toContain("Unchanged pump");
    expect(html).toContain("Source support reduced");
    expect(html).toContain("Review decisions changed");
  });
  it.each(["review", "unverified"])("excludes evidence flagged %s from bulk acceptance", (flag) => {
    const content = oldGraph();
    for (const i of content.abox!.individuals) {
      i.review = { by: "auto", status: "candidate" };
      i.evidence = [{ quote: "A pump", status: "verified", confidence: 0.99 }];
    }
    const p = content.abox!.individuals[0].dataProperties![0];
    p.review = { by: "auto", status: "candidate" };
    p.evidence = [
      { quote: "6 bar", status: "verified", confidence: 0.99 },
      { quote: "Conflicting passage", status: flag === "unverified" ? "unverified" : "verified", review: flag === "review" },
    ];
    const html = renderReview(content, { ...oldGraph(), abox: { individuals: [] } });
    expect(html).toContain("Accept 2 supported changes");
    expect(html).not.toContain("Accept 3 supported changes");
  });
  it("keeps drafts based on an earlier graph reachable in history", () => {
    const graph = revision("saved", oldGraph());
    const draft = { ...revision("old-draft", oldGraph()), status: "draft" as const, number: null, parentId: "earlier" };
    client.setQueryData(qk.revision("cor", graph.id), graph);
    const html = render(
      h(CorpusHistory, {
        pid: "cor",
        detail: { corpus: state.project, graph, documents: [], revisions: [graph, draft] },
        refresh: () => {},
      }),
    );
    expect(html).toContain("Based on an earlier graph version");
    expect(html).toContain("/p/cor/graph?tab=updates&amp;rev=old-draft");
  });
  it("excludes proposed removals from bulk acceptance and the candidate count", () => {
    const original = oldGraph();
    for (const i of original.abox!.individuals) {
      i.review = { by: "auto", status: "candidate" };
      i.evidence = [{ quote: "Pump", status: "verified", confidence: 0.99 }];
    }
    const html = renderReview({ ...oldGraph(), abox: { individuals: [] } }, original);
    expect(html).not.toContain("Accept 2 supported changes");
    expect(html).not.toContain("Needs review ·");
  });
  it("uses current draft validation for bulk acceptance even before the server report refreshes", () => {
    const content = oldGraph();
    for (const i of content.abox!.individuals) {
      i.review = { by: "auto", status: "candidate" };
      i.evidence = [{ quote: "Pump", status: "verified", confidence: 0.99 }];
    }
    content.abox!.individuals[0].classUri = "http://ex/UnknownClass";
    state.working.tbox = parseTBox(`<http://ex/Pump> a <http://www.w3.org/2002/07/owl#Class>.`);
    const html = renderReview(content, { ...oldGraph(), abox: { individuals: [] } });
    expect(html).not.toContain("Accept 2 supported changes");
  });
  it("falls back to Documents for an unknown workspace tab", () => {
    const graph = revision("saved", oldGraph());
    client.setQueryData(corpusKeys.detail("cor"), { corpus: state.project, graph, documents: [], revisions: [graph] });
    const html = render(h(CorpusPage), "/p/cor/workflows/abox?tab=missing");
    expect(html).toContain("Add documents");
  });
});
