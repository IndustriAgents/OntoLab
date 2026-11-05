import { describe, expect, it } from "vitest";
import { detectKind, parseDocument } from "./parsing";

describe("XML source documents", () => {
  it("detects XML case-insensitively and extracts field names, attributes and Unicode", async () => {
    const xml = '<?xml version="1.0"?><catalog><part id="42">Motor &amp; sensor — Å</part></catalog>';
    expect(detectKind("catalog.XML", Buffer.from(xml))).toEqual({ kind: "text", mediaType: "application/xml" });
    const parsed = await parseDocument("catalog.XML", Buffer.from(xml));
    expect(parsed.text).toContain('id="42"');
    expect(parsed.text).toContain("Motor & sensor — Å");
    expect(parsed.text).toContain("/catalog[1]/part[1]");
    expect(parsed.sourceSpans?.length).toBeGreaterThan(0);
    expect(parsed.mediaType).toBe("application/xml");
    expect(parsed.parser).toBe("node");
    expect(parsed.sections).toEqual([]);
  });

  it("rejects binary content disguised as XML", () => {
    expect(() => detectKind("binary.xml", Buffer.from([0, 1, 2]))).toThrow("UTF-8 XML text");
  });

  it("rejects custom entities and malformed XML", async () => {
    await expect(parseDocument("source.xml", Buffer.from('<!DOCTYPE root [<!ENTITY a "x">]><root>&a;</root>'))).rejects.toThrow("entity");
    await expect(parseDocument("source.xml", Buffer.from("<root><open></root>"))).rejects.toThrow("well-formed");
  });

  it("extracts scientific article sections, mixed text, tables and source paths", async () => {
    const parsed = await parseDocument(
      "article.xml",
      Buffer.from(
        "<article><front><article-title>Study</article-title></front><body><sec><title>Results</title><p>Motor <italic>A</italic> moves.</p><table-wrap><caption>Measurements</caption><table><tr><th>Part</th><th>Count</th></tr><tr><td>Motor</td><td>2</td></tr></table></table-wrap></sec></body></article>",
      ),
    );
    expect(parsed.text).toContain("Motor A moves.");
    expect(parsed.text).toContain("| Motor | 2 |");
    expect(parsed.sections.map((s) => s.title)).toContain("Results");
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.sourceSpans?.every((s) => parsed.text.slice(s.start, s.end).length > 0)).toBe(true);
  });
});
