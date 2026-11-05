import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunStages } from "../src/features/runs/RunStages";
import type { RunView } from "../src/types/project";
const steps = [
  { key: "terms:1", kind: "terms", label: "First topic" },
  { key: "terms:2", kind: "terms", label: "Second topic" },
  { key: "merge", kind: "merge", label: "Merge classes" },
  { key: "finalize", kind: "finalize", label: "Prepare draft" },
] as RunView["steps"];
const render = (patch: Partial<RunView>) =>
  renderToStaticMarkup(createElement(RunStages, { run: { steps, completedSteps: 0, status: "running", ...patch } as RunView }));
describe("run processing stages", () => {
  it("groups repeated tasks while keeping completed stages collapsed and the next stage open", () => {
    const html = render({ completedSteps: 2, completedStepKeys: ["terms:1", "terms:2"], nextStep: steps[2] });
    expect(html).toContain("Generate classes");
    expect(html).toContain("2 / 2");
    expect(html).toMatch(/class="run-stage is-done">/);
    expect(html).toMatch(/class="run-stage is-current" open=""/);
    expect(html.match(/<details /g)).toHaveLength(3);
    expect(html).toContain("First topic");
    expect(html).toContain("Second topic");
  });
  it("uses checkpoint keys for out-of-order completions and identifies a failed stage", () => {
    const html = render({ completedSteps: 1, completedStepKeys: ["terms:2"], nextStep: steps[0], status: "failed" });
    expect(html).toContain("Stopped here");
    expect(html).toContain("1 / 2");
    expect(html).toMatch(/class="current"><span class="step-dot"[^>]*><\/span><span class="grow">First topic/);
  });
  it("supports older runs without checkpoint keys and empty run plans", () => {
    expect(render({ completedSteps: 4, status: "ready_for_review" }).match(/class="run-stage is-done"/g)).toHaveLength(3);
    expect(render({ steps: [] })).toContain("No processing steps recorded");
  });
});
