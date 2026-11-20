// The local entailment model must see the premise and the hypothesis as a sentence
// pair. A previous implementation passed `{ text, text_pair }` objects to the
// text-classification pipeline, which ignores them: every claim scored 0.89, so the
// evidence gate passed contradictions as well as entailments.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_CACHE_DIR, NLI_LOCAL_MODEL } from "../server/config.ts";
import { entailmentProbabilities, localScorer } from "../server/ml/nli.ts";

describe("entailmentProbabilities", () => {
  it("returns the softmax probability of the entailment class per row", () => {
    // two rows, classes [contradiction, entailment, neutral]
    const logits = { dims: [2, 3], data: [0, 2, 0, 3, 0, 0] };
    const [a, b] = entailmentProbabilities(logits, 1);
    expect(a).toBeCloseTo(Math.exp(2) / (Math.exp(2) + 2), 6);
    expect(b).toBeCloseTo(1 / (Math.exp(3) + 2), 6);
  });

  it("is numerically stable for large logits", () => {
    const [p] = entailmentProbabilities({ dims: [1, 3], data: [1000, 1001, 999] }, 1);
    expect(p).toBeGreaterThan(0.6);
    expect(Number.isFinite(p)).toBe(true);
  });
});

// Runs only when the model is already in the local cache (no download in CI).
const cached = existsSync(join(MODEL_CACHE_DIR, NLI_LOCAL_MODEL));

describe.skipIf(!cached)("local NLI model (cached)", () => {
  it("separates entailed, contradicted and unrelated claims, batched and alone", async () => {
    const premise = "The pump has a maximum pressure of 10 bar.";
    const pairs = [
      { premise, hypothesis: "The pump's maximum pressure is 10 bar." },
      { premise, hypothesis: "The pump's maximum pressure is 50 bar." },
      { premise: "The cat sleeps on the sofa.", hypothesis: "Interest rates rose in March." },
    ];
    const [entailed, contradicted, unrelated] = await localScorer.score(pairs);
    expect(entailed).toBeGreaterThan(0.8);
    expect(contradicted).toBeLessThan(0.2);
    expect(unrelated).toBeLessThan(0.5);
    const [alone] = await localScorer.score([pairs[1]]);
    expect(Math.abs(alone - contradicted)).toBeLessThan(0.05);
  }, 120_000);
});
