import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { NewProjectModal } from "../src/features/projects/ProjectsPage";

it("asks only for name and purpose when creating a project", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    h(QueryClientProvider, { client }, h(StaticRouter, { location: "/" }, h(NewProjectModal, { onClose: () => {} }))),
  );
  expect(html).toContain('for="np-name"');
  expect(html).toContain('for="np-purpose"');
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html.match(/<textarea/g)).toHaveLength(1);
  expect(html).not.toContain('type="radio"');
  expect(html).not.toContain("From my documents");
  expect(html).not.toContain("From a template");
  client.clear();
});
