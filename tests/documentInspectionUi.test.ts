import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DocumentInspection } from "../src/features/documents/DocumentInspection";
import { qk } from "../src/lib/projectApi";
import type { ProjectDocument } from "../src/types/project";

const document = { id: "doc", name: "article.xml", parseState: "parsed", kind: "text", mediaType: "application/xml" } as ProjectDocument;
function render(initialView: "text" | "original", readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(qk.documentText("p", "doc"), { text: "Parsed article", pages: [], chunks: [] });
  const html = renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client },
      h(StaticRouter, { location: "/p/p/documents" }, h(DocumentInspection, { pid: "p", doc: document, initialView, readOnly })),
    ),
  );
  client.clear();
  return html;
}
describe("original file inspection", () => {
  it("opens the original file tab directly without showing extracted text", () => {
    const html = render("original");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Original file/);
    expect(html).toContain("Loading original file");
    expect(html).not.toContain("Parsed article");
    expect(html).toContain("Original file retained");
  });
  it("exposes reparse beside the document views and retains read-only behavior", () => {
    const html = render("text");
    expect(html.indexOf("Reparse original")).toBeLessThan(html.indexOf("Processing version &amp; source locations"));
    expect(html).toContain("Parsed article");
    expect(html).toContain("currently configured parser");
    expect(render("original", true)).toMatch(/<button[^>]*disabled=""[^>]*>Reparse original/);
  });
});
