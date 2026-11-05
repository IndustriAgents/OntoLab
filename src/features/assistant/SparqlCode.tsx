// Small, dependency-free SPARQL highlighter (from kg_chatbot). Renders React
// nodes, never HTML strings.

import { Fragment, useMemo } from "react";

const KEYWORDS =
  "SELECT|CONSTRUCT|DESCRIBE|ASK|WHERE|PREFIX|BASE|FROM|NAMED|GRAPH|OPTIONAL|UNION|MINUS|FILTER|BIND|VALUES|SERVICE|SILENT|AS|DISTINCT|REDUCED|ORDER|BY|ASC|DESC|GROUP|HAVING|LIMIT|OFFSET|NOT|EXISTS|IN|UNDEF|COUNT|SUM|MIN|MAX|AVG|SAMPLE|GROUP_CONCAT|SEPARATOR|STR|LANG|LANGMATCHES|DATATYPE|BOUND|IRI|URI|BNODE|isIRI|isURI|isBLANK|isLITERAL|isNUMERIC|REGEX|CONTAINS|STRSTARTS|STRENDS|LCASE|UCASE|CONCAT|COALESCE|IF|STRLEN|SUBSTR|REPLACE|YEAR|MONTH|DAY|NOW|a|true|false";

const TOKEN = new RegExp(
  [
    "(#[^\\n]*)", // comment
    "(<[^<>\\s\"{}|^`\\\\]*>)", // IRI
    "(\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')", // string
    "([?$][A-Za-z_][\\w]*)", // variable
    "((?:[A-Za-z][\\w.-]*)?:[\\w.-]*)", // prefixed name
    `\\b(${KEYWORDS})\\b`, // keyword
  ].join("|"),
  "gi",
);

export function SparqlCode({ query }: { query: string }) {
  const parts = useMemo(() => {
    const out: { text: string; cls?: string }[] = [];
    let last = 0;
    for (const m of query.matchAll(TOKEN)) {
      const i = m.index!;
      let cls: string | undefined;
      const text = m[0];
      if (m[1] !== undefined) {
        // Inside an IRI a '#' is not a comment.
        const lineStart = query.lastIndexOf("\n", i) + 1;
        const before = query.slice(lineStart, i);
        if ((before.match(/</g)?.length ?? 0) > (before.match(/>/g)?.length ?? 0)) continue;
        cls = "cm";
      } else if (m[2] !== undefined) cls = "iri";
      else if (m[3] !== undefined) cls = "str";
      else if (m[4] !== undefined) cls = "var";
      else if (m[5] !== undefined) cls = "pn";
      else if (m[6] !== undefined) cls = "kw";
      if (i > last) out.push({ text: query.slice(last, i) });
      out.push({ text, cls });
      last = i + text.length;
    }
    if (last < query.length) out.push({ text: query.slice(last) });
    return out;
  }, [query]);

  return (
    <pre className="gc-code">
      <code>
        {parts.map((p, i) =>
          p.cls ? (
            <span key={i} className={`sq-${p.cls}`}>
              {p.text}
            </span>
          ) : (
            <Fragment key={i}>{p.text}</Fragment>
          ),
        )}
      </code>
    </pre>
  );
}
