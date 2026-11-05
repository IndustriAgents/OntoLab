import type { ABoxResult, ExtractDoc } from "../../src/types/abox.ts";

/** Explicit source cues only. This requests model review; it never invents a
 * subject/property or accepts a fact. Lexical coverage is not entailment. */
export function recommendationCues(documents: ExtractDoc[]) {
  return documents
    .flatMap((d, index) => {
      const text = d.text ?? "";
      return [...text.matchAll(/\b(?:it is better to|we recommend|recommendation\s*:)[^.!?]{8,500}[.!?]?/gi)].map((m) => ({
        document: index + 1,
        quote: m[0],
        firstLine: text.slice(0, m.index).split("\n").length,
      }));
    })
    .slice(0, 12);
}

export function uncoveredRecommendations(cues: ReturnType<typeof recommendationCues>, abox: ABoxResult) {
  const tokens = (s: string) => [
    ...new Set(
      (s.toLowerCase().match(/[a-z]+/g) ?? [])
        .filter((w) => !/^(?:it|is|better|to|the|a|an|and|or|of|for|with|we|recommend|recommendation|prior|before|after|in|as)$/.test(w))
        .map((w) => w.replace(/(?:ing|ed|s)$/, "").replace(/e$/, "")),
    ),
  ];
  const assertions = abox.individuals.flatMap((i) => i.dataProperties ?? []);
  return cues.filter((cue) => {
    const keys = tokens(cue.quote);
    return (
      keys.length >= 3 &&
      !assertions.some((p) => {
        if (!/recommend|suggest|better|advis/i.test(p.value) || !p.evidence?.length) return false;
        const words = new Set(tokens(p.value));
        return keys.filter((k) => words.has(k)).length / keys.length >= 0.8;
      })
    );
  });
}
