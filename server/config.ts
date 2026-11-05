// Central runtime configuration. Every knob is read here exactly once so the
// server, the Vite dev proxy and the deploy script agree on what they mean.

/**
 * Port the API listens on.
 *
 * API_PORT wins over PORT. That matters in dev: the tooling that launches the
 * app often injects PORT for the *web* server (Vite is on 5173), and if the API
 * silently adopted it both processes would fight over one port and every /api
 * call would fail with ECONNREFUSED. Cloud Run only sets PORT, which still works.
 */
export const PORT = Number(process.env.API_PORT || process.env.PORT) || 3000;

/**
 * Mount prefix, e.g. "/ontolab" when served behind the gateway Worker.
 * Must match the base the SPA was built with (vite.config.ts).
 */
export const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");

/** Optional token for programmatic API access. */
export const API_TOKEN = process.env.API_TOKEN?.trim() || "";

/** Max JSON request body. PDFs are base64 (~1.33x), so this bounds ~12 MB of files. */
export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 16 * 1024 * 1024;

/** Max characters of document text sent to a model in one request (~1 token ≈ 4 chars). */
export const MAX_DOC_CHARS = Number(process.env.MAX_DOC_CHARS) || 1_500_000;

/** Max base64 length for a single uploaded PDF / DOCX. */
export const MAX_FILE_BASE64 = Number(process.env.MAX_FILE_BASE64) || 30 * 1024 * 1024;

/** Wall-clock budget for one provider call. Keep below the edge/proxy timeout. */
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 300_000;

/** Concurrent in-flight provider calls per instance. */
export const MAX_CONCURRENT_LLM = Number(process.env.MAX_CONCURRENT_LLM) || 4;

/** Requests per window per client for the LLM endpoints. */
export const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 30;
export const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 60_000;

/** Max output tokens per generation. */
export const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 16000;

/** Hard cap on SPARQL result rows returned to the client. */
export const MAX_SPARQL_ROWS = Number(process.env.MAX_SPARQL_ROWS) || 1000;

/** Time budget for running a competency-question SPARQL query. */
export const SPARQL_TIMEOUT_MS = Number(process.env.SPARQL_TIMEOUT_MS) || 15_000;

/* ───────────────────────── projects / persistence ───────────────────────── */

/** Where the local adapter keeps projects, documents and revisions. */
export const DATA_DIR = process.env.DATA_DIR || ".data";

/** Postgres runtime URL; migrations use DATABASE_URL_UNPOOLED. */
export const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const STORE_MODE = process.env.STORE_MODE || (DATABASE_URL ? "postgres" : "local");

/** Pilot limits, explained to the user before upload or execution. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 20 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_PROJECT = Number(process.env.MAX_DOCUMENTS_PER_PROJECT) || 50;
/** Corpus source files; historical versions and preparation variants do not consume source slots. */
export const MAX_SOURCES_PER_CORPUS = Number(process.env.MAX_SOURCES_PER_CORPUS) || 1000;
/** Per-user storage budget (originals + extracted text), configurable for the backing store. */
export const STORAGE_QUOTA_BYTES = Number(process.env.STORAGE_QUOTA_BYTES) || 10 * 1024 * 1024 * 1024;
/** Target size of one extraction chunk, in characters (split at paragraph boundaries). */
export const CHUNK_CHARS = Number(process.env.CHUNK_CHARS) || 12_000;
/** Concurrent extraction steps per deployment (free hosting: one). */
export const MAX_ACTIVE_STEPS = Number(process.env.MAX_ACTIVE_STEPS) || 1;
/** A step's lease must outlive the slowest provider call, or a second tab could steal it. */
export const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS) || LLM_TIMEOUT_MS + 30_000;
/** Consecutive failures of one step before the run is marked failed. */
export const MAX_STEP_ATTEMPTS = Number(process.env.MAX_STEP_ATTEMPTS) || 3;
/** Graph view renders at most this many nodes before asking the user to narrow it. */
export const MAX_GRAPH_NODES = Number(process.env.MAX_GRAPH_NODES) || 500;

/** Deterministic offline model for tests and demos — never calls a provider. */
export const MOCK_LLM = process.env.MOCK_LLM === "1";

/* ───────────────────────── retrieval and quality models ───────────────────────── */

export type EmbeddingsBackend = "local" | "provider" | "hash" | "off";
export type NliBackend = "local" | "provider" | "lexical" | "off";

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Embeddings for schema retrieval, dense passage retrieval, entity blocking and
 * clustering. "local" runs a small ONNX model in-process (transformers.js; the
 * model is downloaded once into MODEL_CACHE_DIR); "provider" uses the embedding
 * API of EMBEDDINGS_PROVIDER; "hash" is a deterministic lexical fallback used in
 * tests and whenever the local model cannot load.
 */
export const EMBEDDINGS_BACKEND: EmbeddingsBackend = oneOf(
  process.env.EMBEDDINGS_BACKEND,
  ["local", "provider", "hash", "off"] as const,
  MOCK_LLM ? "hash" : "local",
);
export const EMBEDDINGS_LOCAL_MODEL = process.env.EMBEDDINGS_LOCAL_MODEL || "Xenova/all-MiniLM-L6-v2";
export const EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || "";
export const EMBEDDINGS_PROVIDER_MODEL = process.env.EMBEDDINGS_PROVIDER_MODEL || "";

/** Entailment scoring of evidence quotes against verbalised claims (the NLI gate). */
export const NLI_BACKEND: NliBackend = oneOf(
  process.env.NLI_BACKEND,
  ["local", "provider", "lexical", "off"] as const,
  MOCK_LLM ? "lexical" : "local",
);
export const NLI_LOCAL_MODEL = process.env.NLI_LOCAL_MODEL || "Xenova/nli-deberta-v3-xsmall";
/** Claims whose entailment score falls below this go to review. */
export const NLI_REVIEW_THRESHOLD = Number(process.env.NLI_REVIEW_THRESHOLD) || 0.5;
/** A fact is trusted automatically when its verified evidence scores at least this (else it waits for review). */
export const FACT_ACCEPT_THRESHOLD = Number(process.env.FACT_ACCEPT_THRESHOLD) || 0.8;

/** Where transformers.js keeps downloaded models. */
export const MODEL_CACHE_DIR = process.env.MODEL_CACHE_DIR || `${DATA_DIR}/models`;

/* ───────────────────────── parsing and chunking ───────────────────────── */

/** Optional Docling sidecar (sidecar/docling). Empty = the built-in Node parsers. */
export const PARSER_URL = (process.env.PARSER_URL ?? "").replace(/\/+$/, "");
export const PARSER_TOKEN = process.env.PARSER_TOKEN ?? "";
export const PARSER_TIMEOUT_MS = Number(process.env.PARSER_TIMEOUT_MS) || 180_000;

/* ───────────────────────── reasoning ───────────────────────── */

/**
 * Optional DL reasoner sidecar (sidecar/reasoner: OWL API + HermiT/ELK). Without
 * it the in-process OWL 2 RL engine runs, which misses some inconsistencies
 * (existentials, cardinalities over unnamed individuals) and says so.
 */
export const REASONER_URL = (process.env.REASONER_URL ?? "").replace(/\/+$/, "");
export const REASONER_TOKEN = process.env.REASONER_TOKEN ?? "";
export const REASONER_TIMEOUT_MS = Number(process.env.REASONER_TIMEOUT_MS) || 60_000;
/** "auto" = DL when REASONER_URL is set, else RL; "off" skips reasoning in validation. */
export const REASONER_TIER: "auto" | "rl" | "dl" | "off" = oneOf(process.env.REASONER_TIER, ["auto", "rl", "dl", "off"] as const, "auto");
/** Share of each chunk repeated at the start of the next one, so a fact on a boundary is seen whole. */
export const CHUNK_OVERLAP = Math.min(0.3, Math.max(0, Number(process.env.CHUNK_OVERLAP ?? 0.12)));

/* ───────────────────────── GraphDB and graph chat ───────────────────────── */

/**
 * Optional GraphDB server (11+). Revisions can be published to one of its
 * repositories, and Ask can answer from it through GraphDB's MCP server.
 * The URL is server configuration only: users pick a repository, never a host.
 */
export const GRAPHDB_URL = (
  process.env.GRAPHDB_URL ?? (process.env.GRAPHDB_MCP_URL ? new URL(process.env.GRAPHDB_MCP_URL).origin : "")
).replace(/\/+$/, "");
export const GRAPHDB_MCP_URL = process.env.GRAPHDB_MCP_URL || (GRAPHDB_URL ? `${GRAPHDB_URL}/mcp` : "");
/** Basic auth for GraphDB's REST API when security is enabled ("user:password"). */
export const GRAPHDB_AUTH = process.env.GRAPHDB_AUTH ?? "";
/** Workbench links in the evidence window; defaults to GRAPHDB_URL. */
export const GRAPHDB_WORKBENCH_URL = (process.env.GRAPHDB_WORKBENCH_URL ?? GRAPHDB_URL).replace(/\/+$/, "");
/** Upper bound on tool-call rounds per Ask turn. */
export const MAX_TOOL_ROUNDS = Number(process.env.MAX_TOOL_ROUNDS) || 12;

/* ───────────────────────── extraction quality ───────────────────────── */

/** Above this many terms, extraction retrieves the relevant part of the T-Box per chunk. */
export const SCHEMA_RETRIEVAL_MIN_TERMS = Number(process.env.SCHEMA_RETRIEVAL_MIN_TERMS) || 60;
/** Classes and properties retrieved per chunk (before ancestors and domain/range closure). */
export const SCHEMA_TOP_K = Number(process.env.SCHEMA_TOP_K) || 24;
/** T-Box rendering in prompts: "code" (typed class definitions, KnowCoder-style) or "tree". */
export const PROMPT_STYLE: "code" | "tree" = process.env.PROMPT_STYLE === "tree" ? "tree" : "code";

/* ───────────────────────── scale and cost ───────────────────────── */

/**
 * In-process worker that advances runs without an open browser tab. Off by
 * default so local installs can run work from the browser as needed.
 */
export const WORKER_ENABLED = process.env.WORKER === "1";
export const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS) || 2000;
/** Independent chunk steps one advance may process concurrently. */
export const PARALLEL_STEPS = Math.max(1, Number(process.env.PARALLEL_STEPS) || 1);
/** Chunks scoring below this similarity to the ontology are skipped by the relevance screen (0 = off). */
export const RELEVANCE_THRESHOLD = Number(process.env.RELEVANCE_THRESHOLD ?? 0.12);
/** JSON object overriding the price table: {"model-id": {"input": usdPerMTok, "output": usdPerMTok}}. */
export const PRICING_JSON = process.env.PRICING_JSON ?? "";

/* ───────────────────────── external vocabularies ───────────────────────── */

/** Term-reuse sources consulted before minting (A3). Network access; off in tests. */
export const REUSE_SOURCES = (process.env.REUSE_SOURCES ?? (MOCK_LLM ? "" : "lov,schemaorg"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const BIOPORTAL_API_KEY = process.env.BIOPORTAL_API_KEY ?? "";
/** Entity grounding sources (B3): wikidata needs nothing, geonames a username, umls an API key. */
export const GEONAMES_USERNAME = process.env.GEONAMES_USERNAME ?? "";
export const UMLS_API_KEY = process.env.UMLS_API_KEY ?? "";
export const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS) || 15_000;
