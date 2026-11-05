import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/features/assistant/Markdown";
import { citedReferences, hasCitation } from "../src/lib/answerCitations";
import { citedQueryIds } from "../server/graphchat/turn";

describe("answer citation groups", () => {
  it("keeps mixed sources usable for query graphs, source lists, copying and feedback", () => {
    const text = "A [C1, Q2, C4]; B [C4; C5]. Existing [C9](https://example.org).";
    expect(citedReferences(text, "C")).toEqual(["C1", "C4", "C5"]);
    expect(citedQueryIds(text)).toEqual(["Q2"]);
    expect(hasCitation(text, "C4")).toBe(true);
    expect(hasCitation(text, "C9")).toBe(false);
    const html = renderToStaticMarkup(createElement(Markdown, { text }));
    expect((html.match(/data-citation-ref=/g) ?? []).length).toBe(4);
    expect(html).toContain('data-citation-ref="C5"');
    expect(html).toContain('href="https://example.org"');
    expect(html).not.toContain("[C1, Q2, C4]");
  });
});
