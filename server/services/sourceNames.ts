import type { ABoxResult, ExtractDoc } from "../../src/types/abox.ts";

/** Keep a source-present acronym when a generated label invents its full form.
 * Does not guess names, merge entities, or change assertion values/identities. */
export function groundEntityNames(input: ABoxResult, documents: ExtractDoc[]) {
  const normalize = (s: string) =>
    s
      .replace(/-\s*\n/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const texts = documents.map((d) => d.text ?? "");
  const notes: string[] = [];
  const individuals = input.individuals.map((i) => {
    if (!i.label) return i;
    const reverse = i.label.match(/^(.+?)\s*\(([A-Z][A-Z0-9]{1,11})\)$/);
    const forward = i.label.match(/^([A-Z][A-Z0-9]{1,11})\s*\(([^()]+)\)$/);
    const acronym = reverse?.[2] ?? forward?.[1];
    const expansion = reverse?.[1] ?? forward?.[2];
    if (!acronym || !expansion || (expansion.match(/[A-Za-z]+/g) ?? []).length < 2) return i;
    if (!texts.some((t) => new RegExp(`\\b${acronym}\\b`).test(t))) return i;
    if (texts.some((t) => normalize(t).includes(normalize(expansion)))) return i;
    notes.push(
      `Grounded candidate label for ${i.id}: ${JSON.stringify(i.label)} → ${JSON.stringify(acronym)}. The acronym occurs in the source; its generated expansion does not. Identity and assertions unchanged.`,
    );
    return { ...i, label: acronym };
  });
  return { abox: { ...input, individuals }, notes };
}
