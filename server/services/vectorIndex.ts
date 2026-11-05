// Per-project chunk embeddings, kept in the project's private blob storage
// (works for the local and the Supabase adapter alike) and updated
// incrementally: only chunks whose text changed are embedded again. Used by the
// relevance screen, dense passage retrieval and induction's topic clustering.
// Brute-force cosine is fine at this scale (thousands of chunks).

import { createHash } from "node:crypto";
import type { DocumentChunk } from "../../src/types/project.ts";
import type { UserStore } from "../store/types.ts";
import { fromBase64, toBase64, type Embedder } from "../ml/embeddings.ts";

interface IndexFile {
  embedder: string;
  entries: Record<string, { h: string; v: string }>;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
const textHash = (t: string) => createHash("sha1").update(t).digest("base64url").slice(0, 16);
export const indexPath = (projectId: string, embedderId: string) =>
  `${projectId}/index/chunks-${safe(embedderId)}-${createHash("sha256").update(embedderId).digest("hex").slice(0, 12)}.json`;

/** What a chunk is embedded as: its section path gives short chunks their topic. */
export function chunkEmbeddingText(c: Pick<DocumentChunk, "text" | "sectionPath">): string {
  return `${c.sectionPath?.length ? `${c.sectionPath.join(" > ")}\n` : ""}${c.text}`;
}

/** Vectors for the given chunks (same order), computing and persisting the missing ones. */
export async function chunkVectors(
  store: UserStore,
  projectId: string,
  chunks: DocumentChunk[],
  embedder: Embedder,
): Promise<Float32Array[]> {
  const path = indexPath(projectId, embedder.id);
  let file: IndexFile = { embedder: embedder.id, entries: {} };
  try {
    const bytes = await store.blobs.get(path);
    if (bytes) {
      const parsed = JSON.parse(bytes.toString("utf8")) as IndexFile;
      if (parsed.embedder === embedder.id) file = parsed;
    }
  } catch {
    /* a corrupt index is rebuilt */
  }
  const texts = chunks.map(chunkEmbeddingText);
  const hashes = texts.map(textHash);
  const missing = chunks.map((_, i) => i).filter((i) => file.entries[chunks[i].id]?.h !== hashes[i]);
  if (missing.length) {
    const before = embedder.id;
    let vecs = await embedder.embed(missing.map((i) => texts[i]));
    let todo = missing;
    // The embedder may have fallen back (local → hash) during the call: never
    // mix vector spaces — re-embed everything in the space it now uses.
    if (embedder.id !== before) {
      file = { embedder: embedder.id, entries: {} };
      todo = chunks.map((_, i) => i);
      vecs = await embedder.embed(texts);
    }
    todo.forEach((i, j) => (file.entries[chunks[i].id] = { h: hashes[i], v: toBase64(vecs[j]) }));
    await store.blobs.put(indexPath(projectId, embedder.id), Buffer.from(JSON.stringify(file)), "application/json");
  }
  return chunks.map((c) => fromBase64(file.entries[c.id].v));
}
