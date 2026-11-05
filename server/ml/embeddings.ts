// Text embeddings behind one interface. Three backends:
//
//   local    — a small sentence-embedding model run in-process by transformers.js
//              (ONNX). Private and free per call; the model downloads once.
//   provider — the embedding API of a configured provider (OpenAI, Gemini, Ollama).
//   hash     — deterministic feature hashing of words and character trigrams. No
//              model at all: used by tests, and as the fallback whenever the
//              local model cannot load, so retrieval degrades instead of failing.
//
// Every vector is L2-normalised, so cosine similarity is a dot product.

import { tokenSpans } from "./tokenSplitting.ts";
import { embeddingCounter, embeddingProfile, embeddingProfiles } from "./tokenization.ts";
import type { EmbeddingProfile } from "../../src/types/research.ts";
import { createHash } from "node:crypto";
import {
  EMBEDDINGS_BACKEND,
  EMBEDDINGS_LOCAL_MODEL,
  EMBEDDINGS_PROVIDER,
  EMBEDDINGS_PROVIDER_MODEL,
  EXTERNAL_TIMEOUT_MS,
  MODEL_CACHE_DIR,
  type EmbeddingsBackend,
} from "../config.ts";
import { postJson } from "../providers.ts";
import { tokenize } from "../store/search.ts";

export interface Embedder {
  /** stable id of backend + model; vectors from different ids are never compared */
  readonly id: string;
  readonly backend: Exclude<EmbeddingsBackend, "off">;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/* ───────────────────────── vector maths ───────────────────────── */

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function toBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function fromBase64(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

/* ───────────────────────── hash backend ───────────────────────── */

const HASH_DIMS = 384;

function bucket(feature: string): { index: number; sign: number } {
  const h = createHash("md5").update(feature).digest();
  return { index: h.readUInt32LE(0) % HASH_DIMS, sign: h[4] & 1 ? 1 : -1 };
}

/** Split camelCase / snake_case so "hasComponent" and "has component" share features. */
function words(text: string): string[] {
  return tokenize(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
}

export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(HASH_DIMS);
  for (const w of words(text)) {
    const stem = w.length > 4 ? w.replace(/(ings?|ed|es|s)$/, "") : w;
    const { index, sign } = bucket(`w:${stem}`);
    v[index] += 2 * sign;
    const padded = `#${stem}#`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const t = bucket(`t:${padded.slice(i, i + 3)}`);
      v[t.index] += 0.5 * t.sign;
    }
  }
  return normalize(v);
}

export const hashEmbedder: Embedder = {
  id: `hash-${HASH_DIMS}`,
  backend: "hash",
  async embed(texts) {
    return texts.map(hashEmbed);
  },
};

/* ───────────────────────── local backend (transformers.js) ───────────────────────── */

type FeaturePipeline = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

let localPipeline: Promise<FeaturePipeline> | null = null;

/** Loaded once per process; a failure is remembered so every call does not retry a download. */
async function loadLocal(): Promise<FeaturePipeline> {
  localPipeline ??= (async () => {
    const mod = (await import("@huggingface/transformers")) as unknown as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeaturePipeline>;
      env: { cacheDir: string };
    };
    mod.env.cacheDir = MODEL_CACHE_DIR;
    return mod.pipeline("feature-extraction", EMBEDDINGS_LOCAL_MODEL, { dtype: "q8" });
  })();
  return localPipeline;
}

export const localEmbedder: Embedder = {
  id: `local-${EMBEDDINGS_LOCAL_MODEL}`,
  backend: "local",
  async embed(texts) {
    const pipe = await loadLocal();
    const out: Float32Array[] = [];
    // Small batches keep memory flat on long documents.
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const res = await pipe(batch, { pooling: "mean", normalize: true });
      const dim = res.dims[res.dims.length - 1];
      for (let j = 0; j < batch.length; j++) out.push(normalize(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim))));
    }
    return out;
  },
};

/* ───────────────────────── provider backend ───────────────────────── */

const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
  ollama: "nomic-embed-text",
};

/** The provider used for embeddings: explicit setting, else the first configured one that has an embedding API. */
export function embeddingProvider(): string | null {
  if (EMBEDDINGS_PROVIDER) return EMBEDDINGS_PROVIDER;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OLLAMA_BASE_URL) return "ollama";
  return null;
}

export function providerEmbedder(provider: string, model = EMBEDDINGS_PROVIDER_MODEL || PROVIDER_DEFAULT_MODEL[provider] || ""): Embedder {
  const opts = { label: `${provider} embeddings`, timeoutMs: EXTERNAL_TIMEOUT_MS * 4, retries: 2 };
  return {
    id: `provider-${provider}-${model}`,
    backend: "provider",
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const batch = texts.slice(i, i + 64).map((t) => t || " ");
        let vectors: number[][];
        if (provider === "openai") {
          const data = (await postJson(
            "https://api.openai.com/v1/embeddings",
            { model, input: batch },
            { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            opts,
          )) as {
            data?: { embedding: number[] }[];
          };
          vectors = (data.data ?? []).map((d) => d.embedding);
        } else if (provider === "gemini") {
          const data = (await postJson(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
            { requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) },
            { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
            opts,
          )) as { embeddings?: { values: number[] }[] };
          vectors = (data.embeddings ?? []).map((e) => e.values);
        } else if (provider === "ollama") {
          const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
          const data = (await postJson(`${base}/api/embed`, { model, input: batch, truncate: false }, {}, opts)) as {
            embeddings?: number[][];
          };
          vectors = data.embeddings ?? [];
        } else {
          throw new Error(`${provider} has no embedding API configured`);
        }
        if (vectors.length !== batch.length) throw new Error(`${provider} returned ${vectors.length} embeddings for ${batch.length} texts`);
        for (const v of vectors) out.push(normalize(Float32Array.from(v)));
      }
      return out;
    },
  };
}

/** All source text is embedded. Long inputs become token-bounded passages; a normalized, token-weighted mean represents their parent. */
export function tokenBounded(inner: Embedder, profile: EmbeddingProfile, maxTokens: number): Embedder {
  return {
    id: `${inner.id}:full-coverage-v2:${maxTokens}`,
    backend: inner.backend,
    async embed(texts) {
      const counter = await embeddingCounter(profile);
      if (profile.backend === "local" && !counter.exact)
        throw new Error("The selected embedding tokenizer is unavailable. Retry or explicitly select the offline hash model.");
      if (counter.inputLimit && maxTokens > counter.inputLimit)
        throw new Error(`Embedding token budget exceeds the tokenizer input limit of ${counter.inputLimit}. Reconfigure chunks.`);
      const groups = texts.map((text) => {
        const value = text || " ";
        return tokenSpans(value, counter, maxTokens).map((span) => ({ text: value.slice(span.start, span.end), tokens: span.tokens }));
      });
      const flat = groups.flat();
      const vectors = await inner.embed(flat.map((p) => p.text));
      if (vectors.length !== flat.length) throw new Error("Embedding provider did not return a vector for every passage.");
      let index = 0;
      return groups.map((group) => {
        const first = vectors[index];
        if (!first) throw new Error("An embedding passage has no vector.");
        const combined = new Float32Array(first.length);
        let weight = 0;
        for (const part of group) {
          const vector = vectors[index++];
          if (vector.length !== combined.length) throw new Error("Embedding dimensions changed between passages.");
          for (let d = 0; d < vector.length; d++) combined[d] += vector[d] * part.tokens;
          weight += part.tokens;
        }
        if (weight) for (let d = 0; d < combined.length; d++) combined[d] /= weight;
        return normalize(combined);
      });
    },
  };
}

/* ───────────────────────── selection + caching ───────────────────────── */

export interface EmbedderChoice {
  /** project preference; falls back to the server default */
  backend?: EmbeddingsBackend;
  profile?: string;
  maxTokens?: number;
}

/** Wrap an embedder so repeated texts (T-Box terms, chunks) are embedded once per process. */
function cached(inner: Embedder): Embedder {
  const cache = new Map<string, Float32Array>();
  return {
    id: inner.id,
    backend: inner.backend,
    async embed(texts) {
      const keys = texts.map((t) => createHash("sha1").update(t).digest("base64"));
      const missing = [...new Set(keys.filter((k) => !cache.has(k)))];
      if (missing.length) {
        const firstText = new Map<string, string>();
        keys.forEach((k, i) => firstText.has(k) || firstText.set(k, texts[i]));
        const vecs = await inner.embed(missing.map((k) => firstText.get(k)!));
        missing.forEach((k, i) => cache.set(k, vecs[i]));
        while (cache.size > 20_000) cache.delete(cache.keys().next().value!);
      }
      return keys.map((k) => cache.get(k)!);
    },
  };
}

/**
 * Falls back to the hash backend (once, logged) when the local model cannot be
 * loaded — no network for the first download, or the optional package missing.
 * Provider failures are NOT masked: a configured provider that errors is an
 * error the user should see.
 */
function withLocalFallback(inner: Embedder): Embedder {
  let failed = false;
  return {
    get id() {
      return failed ? hashEmbedder.id : inner.id;
    },
    get backend() {
      return failed ? hashEmbedder.backend : inner.backend;
    },
    async embed(texts) {
      if (failed) return hashEmbedder.embed(texts);
      try {
        return await inner.embed(texts);
      } catch (e) {
        failed = true;
        console.warn(`[embeddings] local model unavailable (${e instanceof Error ? e.message : e}); using the lexical hash fallback`);
        return hashEmbedder.embed(texts);
      }
    },
  };
}

const instances = new Map<string, Embedder>();

/** The embedder for a request, or null when embeddings are switched off. */
export function getEmbedder(choice: EmbedderChoice = {}): Embedder | null {
  const profile = choice.profile ? embeddingProfile(choice.profile) : null;
  const backend = profile?.backend ?? choice.backend ?? EMBEDDINGS_BACKEND;
  if (backend === "off") return null;
  const provider = profile?.provider ?? embeddingProvider();
  const selected =
    profile ??
    (backend === "local"
      ? embeddingProfiles().find((p) => p.backend === "local")!
      : backend === "hash"
        ? embeddingProfile("hash:384")
        : embeddingProfiles().find(
            (p) => p.provider === provider && (!EMBEDDINGS_PROVIDER_MODEL || p.model === EMBEDDINGS_PROVIDER_MODEL),
          ));
  if (!selected) throw new Error("No supported embedding model is configured. Select a model in chunk settings.");
  const maxTokens = choice.maxTokens ?? selected.inputLimit;
  if (maxTokens < 8 || maxTokens > selected.inputLimit)
    throw new Error("Embedding token budget exceeds the model's configured input limit.");
  const key = `${selected.id}:${maxTokens}:full-coverage-v2:${choice.profile ? "selected" : "default"}`;
  let e = instances.get(key);
  if (!e) {
    if (backend === "hash") e = cached(choice.profile ? tokenBounded(hashEmbedder, selected, maxTokens) : hashEmbedder);
    else if (backend === "local") {
      const bounded = cached(tokenBounded(localEmbedder, selected, maxTokens));
      e = choice.profile ? bounded : withLocalFallback(bounded);
    } else e = cached(tokenBounded(providerEmbedder(selected.provider!, selected.model), selected, maxTokens));
    instances.set(key, e);
  }
  return e;
}

/** Top-k indices of `candidates` by cosine similarity to `query`. */
export function topK(query: Float32Array, candidates: Float32Array[], k: number): { index: number; score: number }[] {
  return candidates
    .map((c, index) => ({ index, score: cosine(query, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
