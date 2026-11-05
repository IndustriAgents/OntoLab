import { HttpError } from "../http.ts";
import { getEncoding } from "js-tiktoken";
import { EMBEDDINGS_LOCAL_MODEL, EMBEDDINGS_PROVIDER_MODEL, MODEL_CACHE_DIR } from "../config.ts";
import type { EmbeddingProfile } from "../../src/types/research.ts";
import type { TokenCounter } from "./tokenSplitting.ts";
export { defaultGenerationBudget } from "../../src/lib/generationLimits.ts";

export const byteCounter: TokenCounter = {
  id: "utf8-byte-upper-estimate-v1",
  exact: false,
  count: (text) => Buffer.byteLength(text, "utf8"),
  note: "Conservative estimate: one token per UTF-8 byte. Not the model's tokenizer.",
};
const encodings = new Map<string, ReturnType<typeof getEncoding>>();
function bpe(name: "cl100k_base" | "o200k_base"): TokenCounter {
  let encoding = encodings.get(name);
  if (!encoding) {
    encoding = getEncoding(name);
    encodings.set(name, encoding);
  }
  return { id: name, exact: true, count: (text) => encoding!.encode(text, [], []).length };
}
export function generationCounter(provider: string, model: string): TokenCounter {
  if (provider === "openai" && /^gpt-4o/.test(model)) return bpe("o200k_base");
  if (provider === "openai" && /^gpt-4\.1/.test(model)) return bpe("o200k_base");
  return byteCounter;
}
export function embeddingProfiles(): EmbeddingProfile[] {
  const list: EmbeddingProfile[] = [
    {
      id: `local:${EMBEDDINGS_LOCAL_MODEL}`,
      label: `Local · ${EMBEDDINGS_LOCAL_MODEL}`,
      backend: "local",
      model: EMBEDDINGS_LOCAL_MODEL,
      inputLimit: /MiniLM/i.test(EMBEDDINGS_LOCAL_MODEL) ? 256 : 512,
      tokenizer: "Model tokenizer (loaded on preview)",
    },
    {
      id: "hash:384",
      label: "Lexical hash · offline",
      backend: "hash",
      model: "hash-384",
      inputLimit: 8192,
      tokenizer: "UTF-8 byte estimate; hashing itself has no token limit",
    },
  ];
  if (process.env.OPENAI_API_KEY)
    for (const model of ["text-embedding-3-small", "text-embedding-3-large"])
      list.push({
        id: `openai:${model}`,
        label: `OpenAI · ${model}`,
        backend: "provider",
        provider: "openai",
        model,
        inputLimit: 8191,
        tokenizer: "cl100k_base",
      });
  if (process.env.GEMINI_API_KEY)
    list.push({
      id: "gemini:gemini-embedding-001",
      label: "Gemini · gemini-embedding-001",
      backend: "provider",
      provider: "gemini",
      model: "gemini-embedding-001",
      inputLimit: 2048,
      tokenizer: "Conservative UTF-8 byte estimate",
    });
  if (process.env.OLLAMA_BASE_URL) {
    const model = EMBEDDINGS_PROVIDER_MODEL || "nomic-embed-text";
    list.push({
      id: `ollama:${model}`,
      label: `Ollama · ${model}`,
      backend: "provider",
      provider: "ollama",
      model,
      inputLimit: 512,
      tokenizer: "Conservative UTF-8 byte estimate; truncation disabled",
    });
  }
  return list;
}
export function embeddingProfile(id: string): EmbeddingProfile {
  const found = embeddingProfiles().find((p) => p.id === id);
  if (!found) throw new HttpError(400, "Embedding model is unavailable. Select a configured model before chunking.");
  return found;
}
const tokenizers = new Map<string, Promise<TokenCounter>>();
export async function embeddingCounter(profile: EmbeddingProfile): Promise<TokenCounter> {
  if (profile.provider === "openai") return bpe("cl100k_base");
  if (profile.backend !== "local") return byteCounter;
  let loading = tokenizers.get(profile.model);
  if (!loading) {
    loading = (async () => {
      try {
        const { AutoTokenizer, env } = await import("@huggingface/transformers");
        env.cacheDir = MODEL_CACHE_DIR;
        const tokenizer = await AutoTokenizer.from_pretrained(profile.model);
        return {
          id: `${profile.model}:tokenizer-v1`,
          exact: true,
          inputLimit: Math.min(profile.inputLimit, tokenizer.model_max_length),
          count: (text: string) => tokenizer.encode(text, { add_special_tokens: true }).length,
        };
      } catch {
        return {
          ...byteCounter,
          count: (text: string) => byteCounter.count(text) + 2,
          note: "Model tokenizer unavailable. Using a conservative UTF-8 byte estimate; preview records this fallback.",
        };
      }
    })();
    tokenizers.set(profile.model, loading);
  }
  return loading;
}
