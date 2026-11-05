import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chunkCoverage } from "../src/lib/chunkCoverage";
import { ChunkBrowser } from "../src/features/research/ChunkLab";
import type { DocumentChunk } from "../src/types/project";

const chunk = (start: number, end: number, ordinal = 0): DocumentChunk => ({
  id: `c${ordinal}`,
  documentId: "doc",
  projectId: "project",
  ordinal,
  start,
  end,
  text: "x".repeat(end - start),
});

describe("parsed text coverage", () => {
  it("counts overlapping and nested spans once regardless of their order", () => {
    expect(chunkCoverage([chunk(50, 100), chunk(0, 60, 1), chunk(10, 30, 2)], 100)).toEqual({
      total: 100,
      covered: 100,
      missing: 0,
      missingTail: 0,
      complete: true,
    });
  });

  it("detects an internal gap even when the final chunk reaches the document end", () => {
    expect(chunkCoverage([chunk(0, 60), chunk(70, 100, 1)], 100)).toEqual({
      total: 100,
      covered: 90,
      missing: 10,
      missingTail: 0,
      complete: false,
    });
  });

  it("includes missing text before, between and after chunks", () => {
    expect(chunkCoverage([chunk(10, 30), chunk(40, 80, 1)], 100)).toEqual({
      total: 100,
      covered: 60,
      missing: 40,
      missingTail: 20,
      complete: false,
    });
    expect(chunkCoverage([], 100).missing).toBe(100);
  });

  it("compares offsets using the parsed string's UTF-16 length", () => {
    const text = "A😀B";
    expect(chunkCoverage([{ start: 0, end: text.length }], text.length).covered).toBe(4);
  });
});

describe("chunk viewer coverage messages", () => {
  it("shows verified coverage and places the end marker after the final chunk text", () => {
    const html = renderToStaticMarkup(h(ChunkBrowser, { chunks: [chunk(0, 10)], documentLength: 10 }));
    expect(html).toContain("10 / 10 characters covered");
    expect(html).toContain("100% covered");
    expect(html).toContain("0 characters missing");
    expect(html).toContain("All 10 parsed characters are covered. Nothing remains after this chunk.");
    expect(html.indexOf("End of document")).toBeGreaterThan(html.indexOf("</pre>"));
  });

  it("warns about an uncovered tail rather than claiming the document ends", () => {
    const html = renderToStaticMarkup(h(ChunkBrowser, { chunks: [chunk(0, 8)], documentLength: 10 }));
    expect(html).toContain("Incomplete coverage");
    expect(html).toContain("End of available chunks");
    expect(html).toContain("2 characters remain after this chunk.");
    expect(html).not.toContain("End of document");
  });

  it("distinguishes reaching the end from covering the full document", () => {
    const html = renderToStaticMarkup(h(ChunkBrowser, { chunks: [chunk(5, 10, 1)], documentLength: 10 }));
    expect(html).toContain("End of document");
    expect(html).toContain("5 characters are uncovered elsewhere");
    expect(html).not.toContain("100% covered");
  });

  it("does not infer document length from the last chunk when the source length is unavailable", () => {
    const html = renderToStaticMarkup(h(ChunkBrowser, { chunks: [chunk(0, 10)] }));
    expect(html).not.toContain("Parsed text coverage");
    expect(html).not.toContain("End of document");
  });
});
