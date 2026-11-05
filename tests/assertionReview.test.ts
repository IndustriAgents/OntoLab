import { beforeEach, expect, it, vi } from "vitest";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../server/structured.ts", () => ({ callStructured: call }));
import { reviewExtractionAssertions } from "../server/services/assertionReview.ts";
import { extractABox } from "../server/extract.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import type { ABoxResult } from "../src/types/abox.ts";
const tbox =
  parseTBox(`@prefix :<urn:review:>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. @prefix xsd:<http://www.w3.org/2001/XMLSchema#>.
:Study a owl:Class. :Tool a owl:Class. :description a owl:DatatypeProperty; rdfs:range xsd:string. :limitation a owl:DatatypeProperty; rdfs:domain :Study; rdfs:range xsd:string. :version a owl:DatatypeProperty; rdfs:domain :Tool; rdfs:range xsd:string.`);
const ctx = { provider: "gemini" as const, model: "test" };
const docs = [{ name: "paper", text: "Timing is modeled by spontaneous transitions.\nScalability on real examples needs analysis." }];
const input: ABoxResult = {
  individuals: [
    {
      id: "study",
      classUri: "urn:review:Study",
      sourceEvidence: docs[0].text,
      dataProperties: [{ propUri: "urn:review:limitation", value: "Timing is modeled by spontaneous transitions." }],
    },
  ],
};
const mapping = {
  subjectId: "study",
  replaceIndex: 1,
  propUri: "urn:review:description",
  value: "Timing is modeled by spontaneous transitions.",
  datatype: "string",
  reason: "Deliberate modeling choice, not a stated shortcoming",
  document: 1,
  firstLine: 1,
  lastLine: 1,
};
beforeEach(() => call.mockReset());
it("corrects a candidate mapping, recovers an omitted limitation, and retains source and edit lineage", async () => {
  call.mockResolvedValue({
    data: {
      changes: [
        mapping,
        {
          ...mapping,
          replaceIndex: 0,
          propUri: "urn:review:limitation",
          value: "Scalability on real examples needs analysis.",
          firstLine: 2,
          lastLine: 2,
        },
      ],
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const before = structuredClone(input);
  const result = await reviewExtractionAssertions(input, tbox, docs, ctx);
  expect(input).toEqual(before);
  expect(result.abox.individuals[0].dataProperties?.map((p) => p.propUri)).toEqual(["urn:review:description", "urn:review:limitation"]);
  expect(result.abox.individuals[0].dataProperties?.[1].evidence?.[0]).toEqual({
    quote: docs[0].text.split("\n")[1],
    status: "unverified",
  });
  expect(result.notes.join(" ")).toContain('"before":{"propUri":"urn:review:limitation"');
  expect(result.abox.individuals[0].dataProperties?.[0].review).toBeUndefined();
  expect(result.usage.input_tokens).toBe(10);
});
it.each([
  { subjectId: "invented" },
  { propUri: "urn:review:version" },
  { propUri: "urn:review:unknown" },
  { replaceIndex: 9 },
  { document: 2 },
  { firstLine: 0 },
  { lastLine: 99 },
  { datatype: "decimal" },
  { datatype: 12 },
  { value: "" },
])("retains original candidates when a proposed edit is invalid: %j", async (invalid) => {
  call.mockResolvedValue({ data: { changes: [{ ...mapping, ...invalid }] }, usage: { input_tokens: 1, output_tokens: 1 } });
  const result = await reviewExtractionAssertions(input, tbox, docs, ctx);
  expect(result.abox).toEqual(input);
  expect(result.notes.join(" ")).toContain("skipped invalid");
});
it("rejects competing replacements of the same assertion", async () => {
  call.mockResolvedValue({ data: { changes: [mapping, mapping] }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await reviewExtractionAssertions(input, tbox, docs, ctx)).abox).toEqual(input);
});
it("includes assertion review usage and coordinates in the extraction pipeline", async () => {
  call
    .mockResolvedValueOnce({
      data: {
        individuals: input.individuals.map((i) => ({
          ...i,
          dataProperties: i.dataProperties?.map((p) => ({ ...p, quote: docs[0].text.split("\n")[0] })),
        })),
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    })
    .mockResolvedValueOnce({ data: { changes: [mapping] }, usage: { input_tokens: 20, output_tokens: 5 } });
  const out = await extractABox({ tbox, documents: docs, requireEvidence: true, reviewAssertions: true }, ctx);
  expect(call).toHaveBeenCalledTimes(2);
  expect(out.usage).toMatchObject({ input_tokens: 30, output_tokens: 9 });
  expect(out.abox.individuals[0].dataProperties?.[0].propUri).toBe("urn:review:description");
});
it("recovers a continuation on a prior subject without copying old facts or relocating type evidence", async () => {
  const prior = structuredClone(input);
  prior.individuals[0].evidence = [{ quote: "Earlier study heading", documentId: "doc", start: 0, end: 21, status: "verified" }];
  call.mockResolvedValue({
    data: { changes: [{ ...mapping, replaceIndex: 0, value: "The expected output is 2m30s." }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const out = await reviewExtractionAssertions(
    { individuals: [] },
    tbox,
    [{ name: "continued", text: "The expected output is 2m30s." }],
    ctx,
    prior,
  );
  expect(out.abox.individuals[0]).toMatchObject({ id: "study", classUri: "urn:review:Study" });
  expect(out.abox.individuals[0].evidence).toBeUndefined();
  expect(out.abox.individuals[0].dataProperties).toHaveLength(1);
  expect(out.abox.individuals[0].dataProperties![0].evidence![0].quote).toBe("The expected output is 2m30s.");
  expect(prior.individuals[0].dataProperties![0].propUri).toBe("urn:review:limitation");
});
it("cannot replace a prior subject's assertion or emit unchanged prior entities", async () => {
  call.mockResolvedValue({ data: { changes: [mapping] }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await reviewExtractionAssertions({ individuals: [] }, tbox, docs, ctx, input)).abox.individuals).toEqual([]);
  call.mockResolvedValue({ data: { changes: [] }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await reviewExtractionAssertions({ individuals: [] }, tbox, docs, ctx, input)).abox.individuals).toEqual([]);
});

it("makes one focused recommendation review when a generic method description misses the action", async () => {
  const source = "The PIPE tool takes Petri net as input.\nIt is better to remove the Start and End states prior to reachability analysis.";
  const candidate = {
    individuals: [
      {
        id: "pipe",
        classUri: "urn:review:Tool",
        dataProperties: [{ propUri: "urn:review:description", value: "Takes Petri net as input." }],
      },
    ],
  };
  call.mockResolvedValueOnce({ data: { changes: [] }, usage: { input_tokens: 2, output_tokens: 3 } });
  call.mockResolvedValueOnce({
    data: {
      changes: [
        {
          ...mapping,
          subjectId: "pipe",
          replaceIndex: 0,
          value: "It is better to remove the Start and End states prior to reachability analysis.",
          firstLine: 2,
          lastLine: 2,
        },
      ],
    },
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  const result = await reviewExtractionAssertions(candidate, tbox, [{ name: "method", text: source }], ctx);
  expect(call).toHaveBeenCalledTimes(2);
  expect(result.abox.individuals[0].dataProperties).toHaveLength(2);
  expect(result.abox.individuals[0].dataProperties![1].evidence![0].quote).toBe(source.split("\n")[1]);
  expect(result.usage).toMatchObject({ input_tokens: 7, output_tokens: 10 });
  expect(result.notes.join(" ")).not.toContain("unresolved");
});

it("bounds recommendation retries and leaves unsupported subject/property decisions unresolved", async () => {
  call.mockResolvedValue({ data: { changes: [] }, usage: { input_tokens: 1, output_tokens: 1 } });
  const result = await reviewExtractionAssertions(
    input,
    tbox,
    [{ name: "method", text: "It is better to remove the Start and End states prior to reachability analysis." }],
    ctx,
  );
  expect(call).toHaveBeenCalledTimes(2);
  expect(result.abox).toEqual(input);
  expect(result.notes.join(" ")).toContain("Recommendation coverage unresolved");
});
it("does not repeat review when the recommended action is already a supported literal", async () => {
  const quote = "It is better to remove the Start and End states prior to reachability analysis.";
  const candidate = structuredClone(input);
  candidate.individuals[0].dataProperties = [
    { propUri: "urn:review:description", value: quote, evidence: [{ quote, status: "unverified" }] },
  ];
  call.mockResolvedValue({ data: { changes: [] }, usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await reviewExtractionAssertions(candidate, tbox, [{ name: "method", text: quote }], ctx)).abox).toEqual(candidate);
  expect(call).toHaveBeenCalledTimes(1);
});
