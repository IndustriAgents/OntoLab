import type { ABoxIndividual, ABoxResult } from "../../types/abox";
/** Rank across the whole corpus before packing complete records into a conservative token estimate. No record or passage is clipped. */
export function selectKnownEntities(
  parts: ABoxResult[],
  text: string,
  maxEstimatedTokens: number,
  classes: Set<string>,
  identityOnly = false,
): ABoxResult {
  const query = text.toLocaleLowerCase(),
    terms = new Set(query.match(/[\p{L}\p{N}_-]{3,}/gu) ?? []),
    unique = new Map<string, ABoxIndividual>();
  for (const p of parts) for (const i of p.individuals) if (!unique.has(i.id)) unique.set(i.id, i);
  const mentions = (value: string) => {
    let at = -1;
    while ((at = query.indexOf(value, at + 1)) >= 0)
      if (!/[\p{L}\p{N}_]/u.test(query[at - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(query[at + value.length] ?? "")) return true;
    return false;
  };
  const score = (i: ABoxIndividual) => {
    let n = classes.has(i.classUri) ? 1 : 0;
    for (const [value, weight] of [[i.iri, 18], [i.id, 14], [i.label, 12], ...(i.sameAs ?? []).map((v) => [v, 16])] as [
      string | undefined,
      number,
    ][]) {
      if (!value || value.length < 3) continue;
      const v = value.toLocaleLowerCase();
      if (mentions(v)) n += weight;
      else n += (v.match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter((t) => terms.has(t)).length;
    }
    for (const p of i.dataProperties ?? []) if (p.value.length > 3 && query.includes(p.value.toLocaleLowerCase())) n += 4;
    return n;
  };
  const ranked = [...unique.values()]
    .map((i) => ({ i, score: score(i) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i.id.localeCompare(b.i.id));
  let used = 0;
  const individuals: ABoxIndividual[] = [];
  for (const { i } of ranked) {
    const tokens = new TextEncoder().encode(JSON.stringify(identityOnly ? { id: i.id, classUri: i.classUri, label: i.label } : i)).length;
    if (used + tokens > maxEstimatedTokens) continue;
    used += tokens;
    individuals.push(i);
  }
  return { individuals };
}
