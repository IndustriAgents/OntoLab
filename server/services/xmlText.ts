// Structured XML reading text. No external entity resolution or network access.
import { DOMParser } from "@xmldom/xmldom";
import { HttpError } from "../http.ts";
import { serializeBlocks, type Block } from "./structuredText.ts";

const children = (e: Element): Element[] => Array.from(e.childNodes).filter((n): n is Element => n.nodeType === 1);
const tag = (e: Element) => e.localName || e.tagName;
const compact = (s: string) => s.replace(/\s+/g, " ").trim();
const textOf = (e: Element) => compact(e.textContent ?? "");

export function xmlText(source: string) {
  if (/<!ENTITY\b/i.test(source) || /<!DOCTYPE[^>]*\[/i.test(source))
    throw new HttpError(422, "XML with custom entity declarations is not supported. The original file is retained.");
  const errors: string[] = [];
  const parsed = new DOMParser({
    errorHandler: { warning: (m) => errors.push(m), error: (m) => errors.push(m), fatalError: (m) => errors.push(m) },
  }).parseFromString(source, "application/xml");
  if (errors.length || !parsed.documentElement || Array.from(parsed.childNodes).filter((n) => n.nodeType === 1).length !== 1)
    throw new HttpError(
      422,
      "Could not read XML: the file is not well-formed. Inspect the original and correct it before uploading again.",
    );
  const root = parsed.documentElement;
  const article = tag(root) === "article";
  const entries: { block: Block; path: string }[] = [];
  const add = (block: Block, path: string) => {
    if (block.text || block.rows?.length) entries.push({ block, path });
  };
  let count = 0;
  const attrs = (e: Element) =>
    Array.from(e.attributes)
      .filter((a) => !a.name.startsWith("xmlns"))
      .map((a) => `${a.name}="${a.value}"`)
      .join(" ");
  function walk(e: Element, path: string, depth: number) {
    if (++count > 200_000 || depth > 128) throw new HttpError(422, "XML structure is too large or deeply nested to extract.");
    const name = tag(e);
    const nodes = children(e);
    if (article) {
      if (name === "article-title" || name === "title") {
        add({ kind: "heading", text: textOf(e), level: name === "article-title" ? 1 : Math.min(6, depth) }, path);
        return;
      }
      if (name === "abstract" || name === "ref-list")
        add({ kind: "heading", text: name === "abstract" ? "Abstract" : "References", level: 2 }, path);
      if (["p", "ref", "caption", "article-id", "journal-title", "contrib", "aff", "kwd", "label", "alt-text"].includes(name)) {
        add({ kind: "paragraph", text: textOf(e) }, path);
        return;
      }
      if (name === "table") {
        const rows = Array.from(e.getElementsByTagName("tr")).map((row) =>
          children(row)
            .filter((c) => ["td", "th"].includes(tag(c)))
            .map(textOf),
        );
        if (rows.length) {
          add({ kind: "table", text: "", rows }, path);
          return;
        }
      }
      if (name === "ext-link" || name === "graphic") {
        const value = [textOf(e), attrs(e)].filter(Boolean).join(" ");
        add({ kind: "paragraph", text: value }, path);
        return;
      }
    }
    // Generic XML retains element paths, attributes and mixed content, rather than stripping field names.
    if (!article && attrs(e)) add({ kind: "paragraph", text: `${path} ${attrs(e)}` }, path);
    if (!nodes.length) {
      const value = textOf(e);
      if (value) add({ kind: "paragraph", text: article ? `${name}: ${value}` : `${path}: ${value}` }, path);
      return;
    }
    const seen = new Map<string, number>();
    for (const node of Array.from(e.childNodes)) {
      if (node.nodeType === 1) {
        const child = node as Element;
        const n = (seen.get(child.tagName) ?? 0) + 1;
        seen.set(child.tagName, n);
        walk(child, `${path}/${child.tagName}[${n}]`, depth + 1);
      } else if (node.nodeType === 3 || node.nodeType === 4) {
        const value = compact(node.nodeValue ?? "");
        if (value) add({ kind: "paragraph", text: article ? value : `${path}: ${value}` }, path);
      }
    }
  }
  walk(root, `/${root.tagName}[1]`, 1);
  const output = serializeBlocks(entries.map((e) => e.block));
  let cursor = 0;
  const sourceSpans = entries.flatMap((e) => {
    const body = serializeBlocks([e.block]).text.trimEnd();
    const start = output.text.indexOf(body, cursor);
    if (!body || start < 0) return [];
    cursor = start + body.length;
    return [{ start, end: cursor, path: e.path }];
  });
  return {
    ...output,
    sourceSpans,
    version: article ? "xml-article-v1" : "xml-generic-v1",
    warnings: article
      ? ["Article XML extraction preserves reading text and simple tables; inspect complex layouts against the original."]
      : ["Generic XML extraction retains element paths and attributes. Inspect the reading text before generation."],
  };
}
