/** A narrow quantity-matched check for capability being presented as observed
 * function-test coverage. It does not infer whether any test actually ran. */
export function overstatedTestingCoverage(answer: string, sources: { ref: string; text: string }[]) {
  const count = String.raw`(?:(?:over|more than|at least|up to)\s+)?(\d+)\s+(?:standard\s+)?functions?`;
  const capability = new RegExp(
    String.raw`\b(?:capable of|able to|designed to|can|could|supports)\s+(?:test|testing|evaluate|evaluating)\s+${count}\b`,
    "gi",
  );
  const observed = new RegExp(
    String.raw`\b${count}\s+(?:(?:were|are|have been|had been)\s+)?(?:tested|exercised|executed|evaluated)\b|\b(?:tested|exercised|executed|evaluated)\s+${count}\b`,
    "gi",
  );
  const claims = (text: string) =>
    text.split(/[\n|;.!?]|\bbut\b/i).flatMap((clause) =>
      [...clause.matchAll(observed)]
        .filter((m) => {
          const before = clause.slice(0, m.index);
          return !/\b(?:not|never|no|cannot|can't|can|could|may|might|would|will|capable|expected|planned|designed)\b/i.test(before);
        })
        .map((m) => ({ fragment: m[0], count: m[1] ?? m[2] })),
    );
  const normalized = sources.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ") }));
  return claims(answer).flatMap((claim) => {
    const capable = normalized.filter((s) => [...s.text.matchAll(capability)].some((m) => m[1] === claim.count));
    // A generated graph assertion cannot upgrade a source passage's capability
    // to observed coverage; require document support when that source is present.
    const observedSources = capable.some((s) => s.ref.startsWith("C")) ? normalized.filter((s) => s.ref.startsWith("C")) : normalized;
    if (!capable.length || observedSources.some((s) => claims(s.text).some((m) => m.count === claim.count))) return [];
    return [{ fragment: claim.fragment, citations: capable.map((s) => s.ref) }];
  });
}
