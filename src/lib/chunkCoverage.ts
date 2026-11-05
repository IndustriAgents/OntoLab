/** Count each parsed-text position once, including when chunk spans overlap. */
export function chunkCoverage(chunks: { start: number; end: number }[], total: number) {
  let covered = 0;
  let lastEnd = 0;
  const ordered = chunks.filter((c) => Number.isInteger(c.start) && Number.isInteger(c.end)).sort((a, b) => a.start - b.start);
  for (const chunk of ordered) {
    const start = Math.max(0, chunk.start);
    const end = Math.min(total, chunk.end);
    if (end <= start) continue;
    covered += Math.max(0, end - Math.max(start, lastEnd));
    lastEnd = Math.max(lastEnd, end);
  }
  const missing = total - covered;
  return { total, covered, missing, missingTail: total - lastEnd, complete: missing === 0 };
}
