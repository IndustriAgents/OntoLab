// Shared source-location matching for stored evidence and its viewer.

/** Normalised text plus a map from each normalised index back to the original. */
function normalise(s: string, lineWrap: "literal" | "keep-hyphen" | "join-word" = "literal"): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    // PDF line wrapping can split identifiers and dates. Keep the original
    // index map and never remove an in-line hyphen or a numeric separator.
    const wrap = lineWrap !== "literal" && /[-‐\u00ad]/.test(ch) ? /^[ \t]*\r?\n[ \t]*/.exec(s.slice(i + 1)) : null;
    if (wrap) {
      const next = i + 1 + wrap[0].length;
      if (lineWrap === "join-word" && /[a-z]/i.test(s[i - 1] ?? "") && /[a-z]/i.test(s[next] ?? "")) {
        i = next - 1;
        continue;
      }
      norm += "-";
      map.push(i);
      prevSpace = false;
      i = next - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      ch = " ";
      prevSpace = true;
    } else {
      prevSpace = false;
      ch = ch
        .replace(/[‘’‚′]/g, "'")
        .replace(/[“”„″]/g, '"')
        .replace(/[‐-―−]/g, "-")
        .toLowerCase();
    }
    norm += ch;
    map.push(i);
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/** Offsets of `quote` within `text`, or null. Every elided segment must occur in order. */
export function locateQuoteDetailed(
  quote: string,
  text: string,
): { start: number; end: number; kind: "exact" | "normalized" | "partial" } | null {
  const q = quote.trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  if (q.length < 4) return null;
  const hay = normalise(text);
  const tryFind = (needle: string, after = 0) => {
    const n = normalise(needle).norm;
    if (n.length < 4) return null;
    const from = after ? hay.map.findIndex((i) => i >= after) : 0;
    if (from < 0) return null;
    const at = hay.norm.indexOf(n, from);
    if (at < 0) return null;
    return { start: hay.map[at], end: hay.map[at + n.length - 1] + 1 };
  };
  const whole = tryFind(q);
  if (whole) return { ...whole, kind: text.slice(whole.start, whole.end) === q ? "exact" : "normalized" };
  for (const mode of ["keep-hyphen", "join-word"] as const) {
    const wrapped = normalise(text, mode);
    const needle = normalise(q, mode).norm;
    const at = wrapped.norm.indexOf(needle);
    if (needle.length >= 4 && at >= 0) return { start: wrapped.map[at], end: wrapped.map[at + needle.length - 1] + 1, kind: "normalized" };
  }
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.trim().length);
  if (parts.length > 1) {
    let start = -1;
    let end = 0;
    for (const part of parts) {
      const hit = tryFind(part, end);
      if (!hit) return null;
      if (start < 0) start = hit.start;
      end = hit.end;
    }
    return { start, end, kind: "partial" };
  }
  return null;
}

export function locateQuote(quote: string, text: string): { start: number; end: number } | null {
  const hit = locateQuoteDetailed(quote, text);
  return hit ? { start: hit.start, end: hit.end } : null;
}
