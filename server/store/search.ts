// Keyword retrieval for the local adapter (the Postgres adapter uses Postgres
// full-text search instead). BM25 over the project's chunks — small, dependency
// free and good enough for a few thousand chunks.

import type { DocumentChunk } from "../../src/types/project.ts";
import type { ChunkHit } from "./types.ts";

const STOP = new Set(
  "a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why with does do did there their them they these those can into than then also any all"
    .split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function scoreChunks(chunks: DocumentChunk[], query: string, limit: number): ChunkHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !chunks.length) return [];

  const docs = chunks.map((c) => tokenize(c.text));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (terms.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  const hits: ChunkHit[] = [];
  chunks.forEach((c, i) => {
    const toks = docs[i];
    const tf = new Map<string, number>();
    for (const t of toks) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen));
    }
    if (score > 0) hits.push({ ...c, score });
  });
  return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
