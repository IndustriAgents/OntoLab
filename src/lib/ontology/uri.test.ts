import { describe, it, expect } from "vitest";
import { toLocalName, fromLocalName, normalizeBase, mintUri } from "./uri";

describe("toLocalName", () => {
  it("preserves case, so differently-cased ids stay distinct individuals", () => {
    expect(toLocalName("Sensor B1")).toBe("Sensor-B1");
    expect(toLocalName("sensor-b1")).toBe("sensor-b1");
    expect(toLocalName("Sensor B1")).not.toBe(toLocalName("sensor-b1"));
  });

  it("preserves non-ASCII letters instead of stripping accents", () => {
    expect(toLocalName("ölfilter")).toBe("ölfilter");
    expect(toLocalName("Zylinder Ü")).toBe("Zylinder-Ü");
    expect(toLocalName("ölfilter")).not.toBe(toLocalName("olfilter"));
  });

  it("collapses whitespace runs into a single dash and trims", () => {
    expect(toLocalName("  a \t\n b  ")).toBe("a-b");
  });

  it("keeps the IRI-safe punctuation set", () => {
    expect(toLocalName("a-b_c.d~e")).toBe("a-b_c.d~e");
  });

  it("percent-encodes unsafe characters", () => {
    expect(toLocalName("a/b")).toBe("a%2Fb");
    expect(toLocalName("a#b")).toBe("a%23b");
    expect(toLocalName("50%")).toBe("50%25");
    expect(toLocalName("a?b&c")).toBe("a%3Fb%26c");
    expect(toLocalName("(x)")).toBe("%28x%29");
  });

  it("falls back to \"x\" for empty / whitespace-only ids", () => {
    expect(toLocalName("")).toBe("x");
    expect(toLocalName("   ")).toBe("x");
    expect(toLocalName(undefined as unknown as string)).toBe("x");
  });

  it("never emits a character that breaks an IRI", () => {
    const out = toLocalName("weird <>\"{}|\\^` id");
    expect(out).not.toMatch(/[<>"{}|\\^`\s]/);
  });
});

describe("fromLocalName", () => {
  it("round-trips percent-encoded segments", () => {
    for (const id of ["a/b", "50%", "a?b&c", "Sensor-B1", "ölfilter"]) {
      expect(fromLocalName(toLocalName(id))).toBe(id);
    }
  });

  it("returns the segment unchanged when it is not valid percent-encoding", () => {
    expect(fromLocalName("100%")).toBe("100%");
  });
});

describe("normalizeBase", () => {
  it("appends # when there is no separator", () => {
    expect(normalizeBase("http://ex/abox")).toBe("http://ex/abox#");
  });

  it("leaves an existing separator alone", () => {
    expect(normalizeBase("http://ex/abox#")).toBe("http://ex/abox#");
    expect(normalizeBase("http://ex/abox/")).toBe("http://ex/abox/");
  });

  it("falls back for an empty base", () => {
    expect(normalizeBase("")).toBe("http://ontolab.example/abox#");
  });
});

describe("mintUri", () => {
  it("joins a normalised base with a safe local name", () => {
    expect(mintUri("http://ex/abox", "Sensor B1")).toBe("http://ex/abox#Sensor-B1");
    expect(mintUri("http://ex/abox/", "Sensor B1")).toBe("http://ex/abox/Sensor-B1");
  });

  it("mints distinct IRIs for ids that differ only in case", () => {
    expect(mintUri("http://ex/abox#", "Pump")).not.toBe(mintUri("http://ex/abox#", "pump"));
  });
});
