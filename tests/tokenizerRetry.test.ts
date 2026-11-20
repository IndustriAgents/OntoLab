import { describe, it, expect, vi, beforeEach } from "vitest";

const fromPretrained = vi.fn();
vi.mock("@huggingface/transformers", () => ({ AutoTokenizer: { from_pretrained: fromPretrained }, env: {} }));
process.env.TOKENIZER_RETRY_MS = "1";

const fakeTokenizer = { model_max_length: 512, encode: (t: string) => t.split(" ") };

describe("embedding tokenizer loading", () => {
  beforeEach(() => {
    vi.resetModules();
    fromPretrained.mockReset();
  });

  it("retries a transient load failure instead of falling back for the whole process", async () => {
    fromPretrained.mockRejectedValueOnce(new Error("cache busy")).mockResolvedValue(fakeTokenizer);
    const { embeddingCounter, embeddingProfiles } = await import("../server/ml/tokenization.ts");
    const profile = embeddingProfiles().find((p) => p.backend === "local")!;
    const counter = await embeddingCounter(profile);
    expect(counter.exact).toBe(true);
    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failed load: the next request tries again", async () => {
    fromPretrained.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { embeddingCounter, embeddingProfiles } = await import("../server/ml/tokenization.ts");
    const profile = embeddingProfiles().find((p) => p.backend === "local")!;
    expect((await embeddingCounter(profile)).exact).toBeFalsy();
    expect(fromPretrained).toHaveBeenCalledTimes(3);
    fromPretrained.mockReset().mockResolvedValue(fakeTokenizer);
    expect((await embeddingCounter(profile)).exact).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable after 3 attempts"));
    warn.mockRestore();
  });
});
