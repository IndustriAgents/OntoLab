// Reasoning over a revision, behind one interface: the optional DL sidecar
// (sidecar/reasoner — OWL API with HermiT for consistency, ELK for classifying
// large T-Boxes) when REASONER_URL is configured, otherwise the in-process
// OWL 2 RL engine. A DL failure falls back to RL and says so, so validation never
// breaks because a sidecar is asleep. Results are cached per content hash.

import { createHash } from "node:crypto";
import type { ABoxResult } from "../../src/types/abox.ts";
import type { RevisionContent } from "../../src/types/project.ts";
import type { OntoModule } from "../../src/types/validation.ts";
import { reasonModules, type Axiom, type ReasonerReport } from "../../src/lib/ontology/reasoner/index.ts";
import { serializeABox } from "../../src/lib/ontology/aboxSerializer.ts";
import { REASONER_TIER, REASONER_TIMEOUT_MS, REASONER_TOKEN, REASONER_URL } from "../config.ts";
import { tboxOf } from "./ontology.ts";
import type { ServiceCtx } from "./context.ts";

export type ReasonerTier = "off" | "rl" | "dl" | "auto";

export interface ReasonOptions {
  tier?: ReasonerTier;
  /** include the A-Box (default true) */
  abox?: boolean;
  una?: boolean;
  signal?: AbortSignal;
  /** sidecar URL (defaults to REASONER_URL; tests point it at a stand-in) */
  url?: string;
}

/** Which tier "auto" (and the deployment default) resolves to right now. */
export function effectiveTier(tier: ReasonerTier = REASONER_TIER, url = REASONER_URL): "off" | "rl" | "dl" {
  if (tier === "auto") return url ? "dl" : "rl";
  if (tier === "dl" && !url) return "rl";
  return tier;
}

/** The DL sidecar's answer, mapped onto the shared report shape. */
interface SidecarResponse extends Partial<ReasonerReport> {
  error?: string;
}

/**
 * Ask the DL sidecar. Individuals are sent as IRIs and mapped back to A-Box ids
 * so findings land on the right individual in Explore.
 */
export async function reasonWithSidecar(
  modules: Pick<OntoModule, "name" | "turtle">[],
  abox: ABoxResult | null,
  content: RevisionContent,
  opts: { signal?: AbortSignal; url?: string; reasoner?: "hermit" | "elk" } = {},
): Promise<ReasonerReport> {
  const url = opts.url ?? REASONER_URL;
  let aboxTurtle = "";
  const uriToId = new Map<string, string>();
  if (abox?.individuals.length) {
    const tbox = tboxOf(content);
    const out = serializeABox(abox, tbox, content.baseIri || tbox.baseIri, { header: false, provenance: false });
    aboxTurtle = out.turtle;
    for (const [id, uri] of out.idToUri) uriToId.set(uri, id);
  }
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(REASONER_TIMEOUT_MS)]) : AbortSignal.timeout(REASONER_TIMEOUT_MS);
  const started = Date.now();
  const res = await fetch(`${url}/reason`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(REASONER_TOKEN ? { "x-token": REASONER_TOKEN } : {}) },
    body: JSON.stringify({
      modules: modules.map((m) => ({ name: m.name, turtle: m.turtle })),
      abox: aboxTurtle,
      reasoner: opts.reasoner ?? (aboxTurtle ? "hermit" : "elk"),
      tasks: ["consistency", "unsat", "classify", "explain"],
      maxExplanations: 10,
    }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as SidecarResponse;
  if (!res.ok) throw new Error(body.error ?? `reasoner error ${res.status}`);
  const toId = (s: string) => uriToId.get(s) ?? s;
  // A-Box positions in an axiom's args carry individual IRIs: show them as A-Box ids
  const individualArgs: Partial<Record<Axiom["kind"], number[]>> = { type: [0], link: [0, 2], data: [0], sameAs: [0, 1], differentFrom: [0, 1] };
  const axioms = (xs: Axiom[] | undefined) =>
    (Array.isArray(xs) ? xs : []).map((a, i) => {
      const at = individualArgs[a.kind] ?? [];
      const args = Array.isArray(a.args) ? a.args.map((x, j) => (at.includes(j) ? toId(String(x)) : String(x))) : [];
      return { ...a, id: a.id ?? `d${i}`, args, ...(a.individualId ? { individualId: toId(a.individualId) } : {}) };
    });
  return {
    tier: "dl",
    reasoner: typeof body.reasoner === "string" ? body.reasoner : "dl",
    consistent: body.consistent !== false,
    clashes: (body.clashes ?? []).map((c) => ({ ...c, subjects: (c.subjects ?? []).map(toId), explanation: axioms(c.explanation) })),
    unsatisfiable: (body.unsatisfiable ?? []).map((u) => ({ ...u, explanation: axioms(u.explanation) })),
    subsumptions: body.subsumptions ?? [],
    propertySubsumptions: body.propertySubsumptions ?? [],
    inferredTypes: Object.fromEntries(Object.entries(body.inferredTypes ?? {}).map(([k, v]) => [toId(k), v])),
    inferredLinks: (body.inferredLinks ?? []).map((e) => ({ ...e, args: e.args.map((a, i) => (i === 1 ? a : toId(a))) })),
    sameAs: (body.sameAs ?? []).map((g) => g.map(toId)),
    incomplete: body.incomplete ?? [],
    stats: { axioms: body.stats?.axioms ?? 0, facts: body.stats?.facts ?? 0, ms: body.stats?.ms ?? Date.now() - started },
  };
}

function cacheKey(content: RevisionContent, tier: string, withAbox: boolean, una: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify(["reason-2", tier, withAbox, una, content.modules.map((m) => [m.name, m.turtle]), withAbox ? content.abox : null, content.baseIri]))
    .digest("hex")
    .slice(0, 40);
}

/**
 * Reason over a revision's content with the requested tier. Returns null when
 * reasoning is off. Cached as a blob under the project, keyed by everything the
 * result depends on.
 */
export async function reasonContent(ctx: ServiceCtx | null, projectId: string, content: RevisionContent, opts: ReasonOptions = {}): Promise<ReasonerReport | null> {
  const tier = effectiveTier(opts.tier, opts.url ?? REASONER_URL);
  if (tier === "off") return null;
  const withAbox = opts.abox !== false;
  const una = opts.una ?? true;
  const abox = withAbox ? content.abox : null;
  const key = cacheKey(content, tier, withAbox, una);
  const path = `${projectId}/reasoning/${key}.json`;
  if (ctx) {
    const hit = await ctx.store.blobs.get(path).catch(() => null);
    if (hit) {
      try {
        return JSON.parse(hit.toString("utf8")) as ReasonerReport;
      } catch {
        // fall through and recompute
      }
    }
  }

  let report: ReasonerReport;
  if (tier === "dl") {
    try {
      report = await reasonWithSidecar(content.modules, abox, content, { signal: opts.signal, url: opts.url });
    } catch (e) {
      ctx?.log.warn("reasoner.dl_failed", { requestId: ctx.requestId, projectId, error: e instanceof Error ? e.message : String(e) });
      report = reasonModules(content.modules, { abox: abox ?? undefined, una }).report;
      report.incomplete = [`The DL reasoner was unreachable (${e instanceof Error ? e.message : "error"}); these are OWL 2 RL results`, ...report.incomplete];
    }
  } else {
    report = reasonModules(content.modules, { abox: abox ?? undefined, una }).report;
  }
  if (ctx) await ctx.store.blobs.put(path, Buffer.from(JSON.stringify(report)), "application/json").catch(() => undefined);
  return report;
}

export { explanationLines } from "../../src/lib/ontology/reasoner/index.ts";
