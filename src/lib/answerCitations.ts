/** Shared syntax for individual, grouped and mixed source/query references. */
export const citationPattern = () => /\[((?:[CQ]\d+)(?:\s*[,;]\s*[CQ]\d+)*)\](?!\()/g;
export function citedReferences(text: string, kind?: "C" | "Q"): string[] {
  return [
    ...new Set(
      [...text.matchAll(citationPattern())].flatMap((m) => m[1].split(/\s*[,;]\s*/)).filter((ref) => !kind || ref.startsWith(kind)),
    ),
  ];
}
export function hasCitation(text: string, ref: string): boolean {
  return citedReferences(text).includes(ref);
}
export function linkAnswerCitations(text: string): string {
  return text.replace(citationPattern(), (_match, list: string) =>
    list
      .split(/\s*[,;]\s*/)
      .map((ref) => `[${ref}](#${ref.startsWith("C") ? "src" : "cite"}-${ref})`)
      .join(""),
  );
}
