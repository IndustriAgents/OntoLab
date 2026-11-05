import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { runKindLabel, runWorkspaceHref } from "../src/lib/runNavigation";
import ActivityPage from "../src/features/runs/ActivityPage";
import { ProjectNavigation } from "../src/app/ProjectNavigation";
import { qk } from "../src/lib/projectApi";
import { corpusKeys } from "../src/lib/corpusApi";
import type { RunView } from "../src/types/project";

vi.mock("../src/app/project", () => ({ useProject: () => ({ pid: "p", project: { name: "Lab" }, revisions: [] }) }));
const run = (patch: Partial<RunView> = {}) =>
  ({
    id: "alignment-run",
    kind: "alignment",
    status: "paused",
    resultRevisionId: null,
    documentIds: [],
    createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z",
    steps: [{ key: "retrieve" }, { key: "save" }],
    completedSteps: 1,
    alignment: { estimate: { processedSourceTerms: 24 } },
    ...patch,
  }) as RunView;

function renderActivity(runs: RunView[], legacy = true, sidebar = false) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: 0 } } });
  client.setQueryData(corpusKeys.list("p"), []);
  client.setQueryData(qk.runs("p"), runs);
  client.setQueryData(
    ["alignment-activity", "p", ""],
    legacy
      ? [
          { id: "record", createdAt: "2026-11-01T10:01:00Z", revisionId: "result", reviewed: false, resultRevisions: ["result"] },
          {
            id: "old-record",
            createdAt: "2026-10-01T10:00:00Z",
            revisionId: "old-result",
            reviewed: true,
            resultRevisions: ["old-result"],
          },
        ]
      : [],
  );
  const html = renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client },
      h(
        StaticRouter,
        { location: "/p/p/activity" },
        sidebar
          ? h(ProjectNavigation, { project: { id: "p", name: "Lab", save: "idle", saveError: null, activity: null } })
          : h(ActivityPage),
      ),
    ),
  );
  client.clear();
  return html;
}

describe("alignment integration with project navigation", () => {
  it("opens unfinished runs at matching and finished runs at their own review draft", () => {
    for (const status of ["paused", "running", "failed"] as const) {
      expect(runWorkspaceHref("p", run({ status }))).toBe("/p/p/workflows/alignment?step=match&run=alignment-run");
    }
    expect(runWorkspaceHref("p", run({ status: "ready_for_review", resultRevisionId: "result" }))).toBe(
      "/p/p/workflows/alignment?step=merge&run=alignment-run&rev=result",
    );
    expect(runKindLabel("alignment")).toBe("Ontology alignment");
    expect(runWorkspaceHref("p", run({ baseRevisionId: "source" }))).toBe(
      "/p/p/workflows/alignment?step=match&run=alignment-run&rev=source",
    );
  });
  it("keeps extraction and build destinations in their own workspaces", () => {
    expect(runWorkspaceHref("graph", run({ kind: "extraction" }), true)).toBe("/p/graph/graph?tab=updates&run=alignment-run");
    expect(runWorkspaceHref("p", run({ kind: "induction" }))).toBe("/p/p/runs/alignment-run");
  });
  it("shows alignment runs with source coverage instead of document counts", () => {
    const html = renderActivity([run()], false);
    expect(html).toContain("24 source terms");
    expect(html).toContain("Align &amp; merge");
    expect(html).not.toContain("Extract documents");
    expect(html).toContain("Paused");
    expect(html).toContain("step=match&amp;run=alignment-run");
  });
  it("deduplicates the result of a background run while retaining old comparisons", () => {
    const html = renderActivity([run({ status: "ready_for_review", resultRevisionId: "result" })]);
    expect(html.match(/class="activity-entry"/g)).toHaveLength(2);
    expect(html).toContain("step=merge&amp;run=alignment-run&amp;rev=result");
    expect(html).toContain("step=merge&amp;rev=old-result");
  });
  it("keeps paused alignment visible in the sidebar with a route to resume it", () => {
    const html = renderActivity([run()], false, true);
    expect(html).toContain("Ontology alignment paused");
    expect(html).toContain("step=match&amp;run=alignment-run");
    expect(html).toContain("1 paused");
  });
});
