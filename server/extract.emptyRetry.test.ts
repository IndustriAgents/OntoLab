import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

const calls: unknown[] = [];
let answers: unknown[] = [];
vi.mock("./structured.ts", () => ({
  callStructured: vi.fn(async (req: unknown) => {
    calls.push(req);
    return { data: answers.shift() ?? { individuals: [] }, usage: { input_tokens: 10, output_tokens: 5 } };
  }),
}));

const { extractABox, isEmptyExtraction, extractableChars, EMPTY_RETRY_MIN_CHARS } = await import("./extract.ts");

const NS = "http://ex/music#";
const tbox = parseTBox(`
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Album a owl:Class . :Band a owl:Class .
:artist a owl:ObjectProperty ; rdfs:domain :Album ; rdfs:range :Band .
`);
const TEXT = "The sludge metal album Nord was produced by the artist Year of No Light. ".repeat(4);
const ctx = { provider: "mock" as const, model: "m" };
const FOUND = {
  individuals: [
    { id: "nord", classUri: `${NS}Album`, label: "Nord", objectProperties: [{ propUri: `${NS}artist`, targetId: "yonl" }] },
    { id: "yonl", classUri: `${NS}Band`, label: "Year of No Light" },
  ],
};

beforeEach(() => {
  calls.length = 0;
  answers = [];
});

describe("empty extraction retry", () => {
  it("asks a second time when a substantial text yields nothing, and uses the second answer", async () => {
    answers = [{ individuals: [], proposedTerms: [] }, FOUND];
    const r = await extractABox({ tbox, documents: [{ name: "d", text: TEXT }] }, ctx);
    expect(calls).toHaveLength(2);
    expect(r.abox.individuals.map((i) => i.id).sort()).toEqual(["nord", "yonl"]);
    expect(r.notes.join(" ")).toMatch(/first answer for this text was empty/);
    expect(r.usage.output_tokens).toBe(10); // both requests are counted
  });

  it("says so when the second answer is empty as well", async () => {
    answers = [{ individuals: [] }, { individuals: [] }];
    const r = await extractABox({ tbox, documents: [{ name: "d", text: TEXT }] }, ctx);
    expect(calls).toHaveLength(2);
    expect(r.abox.individuals).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/no facts in this text, also when asked a second time/);
  });

  it("does not retry a non-empty answer, or an empty answer for a short text", async () => {
    answers = [FOUND];
    await extractABox({ tbox, documents: [{ name: "d", text: TEXT }] }, ctx);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    answers = [{ individuals: [] }];
    const r = await extractABox({ tbox, documents: [{ name: "d", text: "Chapter 3" }] }, ctx);
    expect(calls).toHaveLength(1);
    expect(r.notes.join(" ")).not.toMatch(/second/);
  });

  it("treats proposed terms as an answer and does not count page images as text", () => {
    expect(isEmptyExtraction({ individuals: [], proposedTerms: [{ kind: "class", name: "X" }] })).toBe(false);
    expect(isEmptyExtraction(undefined)).toBe(true);
    expect(extractableChars([{ name: "p", text: "x".repeat(500), asVision: true }, { name: "t", text: "  abc  " }])).toBe(3);
    expect(EMPTY_RETRY_MIN_CHARS).toBeGreaterThan(0);
  });
});
