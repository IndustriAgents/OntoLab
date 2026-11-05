/** Token-bounded source spans. Source offsets remain UTF-16, including whitespace and Unicode. */
export interface TokenCounter {
  id: string;
  exact: boolean;
  inputLimit?: number;
  count(text: string): number;
  note?: string;
}
export interface TokenSpan {
  start: number;
  end: number;
  tokens: number;
  overlap: number;
}

function boundary(text: string, start: number, end: number, method: string): number {
  if (method === "fixed") return end;
  const window = text.slice(start, end);
  for (const re of [/\n\s*\n/g, /[.!?。！？]\s+/gu, /\n/g, /\s+/gu]) {
    let cut = -1;
    for (const match of window.matchAll(re)) cut = match.index! + match[0].length;
    if (cut > window.length / 2) return start + cut;
  }
  return end;
}
function safeEnd(text: string, end: number): number {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}
/** Always verifies the final span; tokenizer counts need not be strictly monotone. */
export function tokenSpans(
  text: string,
  counter: TokenCounter,
  budget: number,
  options: { overlap?: number; method?: string; cuts?: number[] } = {},
): TokenSpan[] {
  if (!Number.isInteger(budget) || budget < 8 || counter.count("") >= budget)
    throw new Error("Token budget must leave room for text and special tokens.");
  const cuts = [...new Set([0, ...(options.cuts ?? []), text.length])].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const result: TokenSpan[] = [];
  const overlapBudget = Math.floor(budget * (options.overlap ?? 0));
  for (let section = 0; section < cuts.length - 1; section++) {
    let next = cuts[section];
    let previousStart = next;
    while (next < cuts[section + 1]) {
      let start = next;
      if (overlapBudget && next > cuts[section]) {
        let lo = previousStart,
          hi = next;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (counter.count(text.slice(mid, next)) <= overlapBudget) hi = mid;
          else lo = mid + 1;
        }
        start = lo;
        if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
      }
      let lo = next,
        hi = Math.min(cuts[section + 1], Math.max(next + 2, start + budget * 12));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (counter.count(text.slice(start, mid)) <= budget) lo = mid;
        else hi = mid - 1;
      }
      const candidate = safeEnd(text, lo);
      let end = candidate === cuts[section + 1] ? candidate : safeEnd(text, boundary(text, next, candidate, options.method ?? "paragraph"));
      while (end > next && counter.count(text.slice(start, end)) > budget) end = safeEnd(text, end - 1);
      if (end <= next) {
        // Drop overlap if it leaves insufficient room for even one source code point.
        if (start < next) {
          start = next;
          end = safeEnd(text, Math.min(next + 2, cuts[section + 1]));
        }
        if (end <= next || counter.count(text.slice(start, end)) > budget) throw new Error("Token budget is too small for this text.");
      }
      result.push({ start, end, tokens: counter.count(text.slice(start, end)), overlap: next - start });
      previousStart = start;
      next = end;
    }
  }
  return result;
}
