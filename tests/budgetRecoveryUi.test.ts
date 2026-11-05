import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { BudgetRecovery } from "../src/features/runs/BudgetRecovery";
vi.mock("../src/app/project", () => ({
  useProject: () => ({ pid: "p", project: { settings: { budget: { maxUsdPerRun: 3, maxUsdTotal: 20 } } } }),
}));
const render = (error: unknown) => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(h(QueryClientProvider, { client }, h(BudgetRecovery, { error })));
  client.clear();
  return html;
};
describe("spending limit recovery", () => {
  it("offers recovery beside actual spending failures with the existing limits", () => {
    const html = render(new Error("Stopped at the per-run budget of $3.00"));
    expect(html).toContain("Adjust spending limits to continue");
    expect(html).toContain('value="3"');
    expect(html).toContain('value="20"');
    expect(html).toContain("Save spending limits");
    expect(render("The project has reached its total budget.")).toContain("Save spending limits");
  });
  it("does not offer spending changes for context-window or model errors", () => {
    expect(render("Chunk and output reserves exceed the context budget.")).toBe("");
    expect(render(new Error("Provider unavailable"))).toBe("");
    expect(render(undefined)).toBe("");
  });
});
