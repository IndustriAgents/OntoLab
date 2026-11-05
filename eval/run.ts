// CLI for the evaluation harness.
//
//   npm run eval -- --provider gemini --model gemini-2.5-flash
//   npm run eval -- --provider claude --model claude-sonnet-4-6 --domains contracts --stages extraction,evidence
//   npm run eval -- --provider mock          (smoke test of the harness itself, no spend)
//
// Ablations (research testbed): one switch changed, everything else equal.
//   npm run eval -- --provider mock --stages induction --ablate repair=false,inductionAxioms=false
//   npm run eval -- --provider mock --grid eval/grids/study1-cq-tbox.json
// A grid file is [{ "name": "...", "options": { <RunOptions> } }, …]; each
// configuration gets its own data directory (no shared caches) and its own
// result files.
//
// Real providers cost money: the harness prints the plan and needs --yes to run
// anything but the mock. Results go to eval/results/<timestamp>-<model>[-<config>].{json,md}.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RunOptions } from "../src/types/project.ts";

const ALL_STAGES = ["cq", "induction", "extraction", "evidence", "assistant", "extension", "alignment"];
const DEFAULT_STAGES = ["cq", "induction", "extraction", "evidence", "assistant"];
const ALL_DOMAINS = ["contracts", "clinical", "manuals"];

function parse(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** `k=v,k2=v2` → run options (true/false/numbers/strings; `a|b` for lists). */
export function parseAblation(spec: string): Partial<RunOptions> {
  const out: Record<string, unknown> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, raw = "true"] = part.split("=");
    const v = raw.trim();
    out[k.trim()] = v === "true" ? true : v === "false" ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.includes("|") ? v.split("|") : v;
  }
  return out as Partial<RunOptions>;
}

const opts = parse(process.argv.slice(2));
const provider = String(opts.provider ?? "mock");
if (provider === "mock") process.env.MOCK_LLM = "1";
if (!opts.reuse) process.env.REUSE_SOURCES = "";

const base = {
  provider,
  model: String(opts.model ?? (provider === "mock" ? "mock-1" : "")),
  domains: String(opts.domains ?? ALL_DOMAINS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  stages: String(opts.stages ?? DEFAULT_STAGES.join(",")).split(",").map((s) => s.trim()).filter((s) => ALL_STAGES.includes(s)),
  goldDir: resolve(String(opts.gold ?? "eval/gold")),
  outDir: resolve(String(opts.out ?? "eval/results")),
  oaeiDir: resolve(String(opts.oaei ?? "eval/gold-oaei")),
  maxQuestions: Number(opts["max-questions"] ?? 12),
};

if (!base.model) {
  console.error("Pass --model (one the server lists for the provider).");
  process.exit(1);
}

/** align: which alignment matchers run, and whether a model verifies pairs (study 2) */
type Config = { name?: string; options: Partial<RunOptions>; align?: { lexical?: boolean; semantic?: boolean; structural?: boolean; verify?: boolean } };
let configs: Config[] = [{ options: {} }];
if (typeof opts.grid === "string") {
  const grid = JSON.parse(await readFile(resolve(opts.grid), "utf8")) as Config[];
  if (!Array.isArray(grid) || !grid.length) throw new Error(`${opts.grid}: expected a non-empty array of { name, options }`);
  configs = grid.map((c, i) => ({ name: c.name ?? `config-${i + 1}`, options: c.options ?? {}, ...(c.align ? { align: c.align } : {}) }));
} else if (typeof opts.ablate === "string") {
  configs = [{ name: opts.ablate.replace(/[^A-Za-z0-9=,.-]+/g, ""), options: parseAblation(opts.ablate) }];
}

console.log(`[eval] ${base.provider}/${base.model} · stages: ${base.stages.join(", ")} · domains: ${base.domains.join(", ")}`);
if (configs.length > 1 || configs[0].name) {
  console.log(`[eval] ${configs.length} configuration${configs.length === 1 ? "" : "s"} × ${base.domains.length} domain${base.domains.length === 1 ? "" : "s"}:`);
  for (const c of configs) console.log(`  · ${c.name}: ${JSON.stringify(c.options)}${c.align ? ` align ${JSON.stringify(c.align)}` : ""}`);
}
if (provider !== "mock" && !opts.yes) {
  console.log("[eval] This calls a paid model for every document, cluster and question, once per configuration. Re-run with --yes to proceed.");
  process.exit(0);
}

const { main } = await import("./harness.ts");
for (const c of configs) {
  // isolated data per configuration: caches never leak between ablations
  process.env.DATA_DIR = resolve(process.env.EVAL_DATA_DIR || tmpdir(), `ontolab-eval-data-${(c.name ?? "default").replace(/[^A-Za-z0-9.-]+/g, "_")}`);
  if (c.name) console.log(`[eval] configuration ${c.name}`);
  const { jsonPath, mdPath, gates } = await main({ ...base, options: c.options, ...(c.name ? { configName: c.name } : {}), ...(c.align ? { align: c.align } : {}) });
  for (const g of gates) console.log(`  ${g.pass == null ? "·" : g.pass ? "✓" : "✗"} ${g.name}: ${g.value == null ? "not run" : g.value.toFixed(3)} (target ${g.target})`);
  console.log(`[eval] wrote ${jsonPath}\n[eval] wrote ${mdPath}`);
}
