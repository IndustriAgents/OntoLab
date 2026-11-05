import { describe, expect, it } from "vitest";
import { runOutcome } from "../src/lib/runOutcome";
import type { RunView } from "../src/types/project";
const run = (status: RunView["status"], resultRevisionId: string | undefined = "result") => ({ status, resultRevisionId }) as RunView;
describe("activity result state", () => {
  it.each(["queued", "running"] as const)("shows progress for %s", (status) => expect(runOutcome(run(status))).toBe("processing"));
  it.each([
    ["awaiting_answers", "answers"],
    ["failed", "failed"],
    ["paused", "paused"],
    ["cancelled", "cancelled"],
  ] as const)("keeps %s actionable", (status, expected) => expect(runOutcome(run(status))).toBe(expected));
  it("uses the result's current status rather than assuming a completed run is still a draft", () => {
    expect(runOutcome(run("ready_for_review"), { status: "draft" })).toBe("draft");
    expect(runOutcome(run("ready_for_review"), { status: "committed" })).toBe("saved");
  });
  it("distinguishes a missing result from a temporary failure to load it", () => {
    expect(runOutcome(run("ready_for_review"), undefined, "loading")).toBe("checking");
    expect(runOutcome(run("ready_for_review"), undefined, "missing")).toBe("missing");
    expect(runOutcome(run("ready_for_review"), undefined, "error")).toBe("unavailable");
    expect(runOutcome({ ...run("ready_for_review"), resultRevisionId: undefined })).toBe("missing");
    expect(runOutcome(run("ready_for_review"), { status: "committed" }, "error")).toBe("unavailable");
  });
});
