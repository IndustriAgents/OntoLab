import { expect, it } from "vitest";
import { pdfSections } from "../server/services/parsing.ts";
import { chunkText } from "../server/services/chunking.ts";

function fixture(firstLines: string[]) {
  const texts = [...firstLines, "Author", "email@example.org", "1 Introduction", ...Array(12).fill("Body text in the document.")];
  const text = texts.join("\n");
  let at = 0;
  const lines = texts.map((t, i) => {
    const start = at;
    at += t.length + 1;
    return { start, end: start + t.length, line: { text: t, height: i < firstLines.length ? 18 : /@|Introduction/.test(t) ? 12 : 10 } };
  });
  return { text, lines };
}
it("keeps a wrapped publication title in one section and extraction chunk without changing text", () => {
  const { text, lines } = fixture(["Developing a Test Suite", "for Application Portability"]);
  const sections = pdfSections(text, lines);
  expect(sections[0].title).toBe("Developing a Test Suite for Application Portability");
  expect(sections.some((s) => s.title.includes("@"))).toBe(false);
  const chunks = chunkText(text, [], 1000, { method: "section", sections });
  expect(chunks[0].text).toContain("Developing a Test Suite\nfor Application Portability");
  expect(chunks.every((c) => c.text === text.slice(c.start, c.end))).toBe(true);
});
it("does not combine a title with a numbered heading of the same size", () => {
  const { text, lines } = fixture(["Publication Title", "1 Introduction"]);
  expect(
    pdfSections(text, lines)
      .slice(0, 2)
      .map((s) => s.title),
  ).toEqual(["Publication Title", "1 Introduction"]);
});
