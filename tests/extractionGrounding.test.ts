import { beforeEach, expect, it, vi } from "vitest";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../server/structured.ts", () => ({ callStructured: call }));
import { extractABox } from "../server/extract.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { resolveEvidence } from "../server/services/evidence.ts";
const tbox = parseTBox(
  "@prefix :<urn:test:>. @prefix owl:<http://www.w3.org/2002/07/owl#>. :Tool a owl:Class. :version a owl:DatatypeProperty.",
);
beforeEach(() => call.mockReset());
it("removes an inherited unlocated title before quote repair while retaining the located prior assertion", async () => {
  const schema = parseTBox(
    "@prefix :<https://test.example/#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. :Study a owl:Class. :title a owl:DatatypeProperty.",
  );
  const prior = {
    individuals: [
      {
        id: "study",
        classUri: "https://test.example/#Study",
        dataProperties: [
          {
            propUri: "https://test.example/#title",
            value: "Wrapped Study Title ∗",
            datatype: "http://www.w3.org/2001/XMLSchema#string",
            evidence: [{ quote: "Wrapped Study\nTitle ∗", documentId: "paper", status: "verified" as const }],
          },
        ],
      },
    ],
  };
  call.mockResolvedValueOnce({
    data: {
      individuals: [
        {
          id: "study",
          classUri: "https://test.example/#Study",
          sourceEvidence: "This paper introduces the method.",
          dataProperties: [
            {
              propUri: "https://test.example/#title",
              value: "Wrapped Study Title",
              datatype: "http://www.w3.org/2001/XMLSchema#string",
              quote: "Wrapped Study Title",
            },
          ],
        },
      ],
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await extractABox(
    {
      tbox: schema,
      documents: [{ name: "abstract", text: "This paper introduces the method." }],
      requireEvidence: true,
      knownIndividuals: prior,
      assertionSubjects: prior,
    },
    { provider: "gemini", model: "gemini-3.8-flash" },
  );
  expect(call).toHaveBeenCalledTimes(1);
  expect(result.abox.individuals[0].dataProperties).toEqual([]);
  expect(result.notes.join(" ")).toContain("Omitted unlocated duplicate title");
  expect(prior.individuals[0].dataProperties).toHaveLength(1);
});
it("repairs summary-derived quotes and requires an assertion's own quote", async () => {
  const first = {
    individuals: [
      {
        id: "tool",
        classUri: "urn:test:Tool",
        sourceEvidence: "A generated summary",
        dataProperties: [{ propUri: "urn:test:version", value: "2" }],
      },
    ],
  };
  const second = {
    repairs: [
      { id: "E1", located: true, document: 1, firstLine: 1, lastLine: 1 },
      { id: "E2", located: true, document: 1, firstLine: 1, lastLine: 1 },
    ],
  };
  call
    .mockResolvedValueOnce({ data: first, usage: { input_tokens: 10, output_tokens: 5 } })
    .mockResolvedValueOnce({ data: second, usage: { input_tokens: 20, output_tokens: 7 } });
  const result = await extractABox(
    { tbox, documents: [{ name: "paper", text: "The tool is version 2." }], context: "A generated summary", requireEvidence: true },
    { provider: "gemini", model: "gemini-3.8-flash" },
  );
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0][0].schema.properties.individuals.items.properties.dataProperties.items.required).toContain("quote");
  expect(result.abox.individuals[0].dataProperties?.[0].evidence?.[0].quote).toBe("The tool is version 2.");
  expect(result.usage).toMatchObject({ input_tokens: 30, output_tokens: 12 });
  expect(result.notes.join(" ")).toContain("repair requested for 2 assertions");
});
it("bounds repairs and leaves unsupported output visible for review", async () => {
  call.mockResolvedValue({
    data: { individuals: [{ id: "tool", classUri: "urn:test:Tool", sourceEvidence: "Invented quotation" }] },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await extractABox(
    { tbox, documents: [{ name: "paper", text: "Only source text." }], requireEvidence: true },
    { provider: "gemini", model: "gemini-3.8-flash" },
  );
  expect(call).toHaveBeenCalledTimes(2);
  expect(result.notes.join(" ")).toContain("repair incomplete");
  expect(result.abox.individuals[0].evidence?.[0].status).toBe("unverified");
});
it("locates a later-page quote in a multi-page chunk with UTF-16 offsets", () => {
  const text = "🧪 First page.\nSecond page: tool version 2.";
  const start = text.indexOf("Second");
  const out = resolveEvidence(
    { individuals: [{ id: "t", classUri: "urn:test:Tool", sourceEvidence: "tool version 2" }] },
    {
      documentId: "d",
      chunk: { id: "c", projectId: "p", documentId: "d", ordinal: 0, start: 0, end: text.length, text, page: 1, pageEnd: 2 },
      pages: [
        { page: 1, start: 0, end: start },
        { page: 2, start, end: text.length },
      ],
    },
  );
  const ref = out.individuals[0].evidence![0];
  expect(ref.page).toBe(2);
  expect(text.slice(ref.start, ref.end)).toBe("tool version 2");
});

it("matches PDF-wrapped identifiers and dates without changing digits or inline hyphens", async () => {
  const { locateQuote } = await import("../src/lib/sourceQuote.ts");
  const text = "For DateAnd-\nTimeOfDayDataType, the date is LD#2177-11-\n30. Real-time control.";
  const hit = locateQuote("For DateAndTimeOfDayDataType, the date is LD#2177-11-30.", text);
  expect(hit).toEqual({ start: 0, end: text.indexOf(" Real-time") });
  expect(locateQuote("LD#2177-11-31", text)).toBeNull();
  expect(locateQuote("LD#21771130", text)).toBeNull();
  expect(locateQuote("Realtime control", text)).toBeNull();
});

it("does not mark a partial quote located when an elided segment was invented", async () => {
  const { locateQuote } = await import("../src/lib/sourceQuote.ts");
  const text = "The test used room temperature and the method needs evaluation.";
  expect(locateQuote("The test used room temperature … showed a 99% improvement", text)).toBeNull();
  expect(locateQuote("The test used room temperature … invented middle … method needs evaluation", text)).toBeNull();
  expect(locateQuote("The test used room temperature … method needs evaluation", text)).toMatchObject({ start: 0, end: text.length - 1 });
});

it("repairs a cross-page quotation by copying the complete original range, preserving the claim", async () => {
  const text = "The test evaluates correspond-\nLicensed footer\n\nFigure caption\ning input values.";
  const original = "The test evaluates corresponding input values.";
  call
    .mockResolvedValueOnce({
      data: { individuals: [{ id: "tool", classUri: "urn:test:Tool", sourceEvidence: original }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    .mockResolvedValueOnce({
      data: { repairs: [{ id: "E1", located: true, document: 1, firstLine: 1, lastLine: 5 }] },
      usage: { input_tokens: 2, output_tokens: 2 },
    });
  const result = await extractABox(
    { tbox, documents: [{ name: "paper", text }], requireEvidence: true },
    { provider: "gemini", model: "gemini-3.8-flash" },
  );
  expect(result.abox.individuals[0].id).toBe("tool");
  expect(result.abox.individuals[0].evidence?.[0]).toEqual({ quote: text, status: "unverified" });
  const located = resolveEvidence(result.abox, {
    documentId: "doc",
    chunk: { id: "c", projectId: "p", documentId: "doc", ordinal: 0, start: 0, end: text.length, text },
  });
  expect(located.individuals[0].evidence?.[0]).toMatchObject({ start: 0, end: text.length, quote: text, status: "verified" });
  expect(result.notes.join(" ")).toContain(JSON.stringify(original));
  expect(call).toHaveBeenCalledTimes(2);
});

it.each([
  [{ id: "E1", located: true, document: 2, firstLine: 1, lastLine: 1 }],
  [{ id: "E1", located: true, document: 1, firstLine: 0, lastLine: 99 }],
  [{ id: "E1", located: false, document: 1, firstLine: 1, lastLine: 1 }],
  [
    { id: "E1", located: true, document: 1, firstLine: 1, lastLine: 1 },
    { id: "E1", located: true, document: 1, firstLine: 1, lastLine: 1 },
  ],
])("rejects invalid, duplicate or unsupported repair coordinates: %j", async (...repairs) => {
  call
    .mockResolvedValueOnce({
      data: { individuals: [{ id: "tool", classUri: "urn:test:Tool", sourceEvidence: "Invented quotation" }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    .mockResolvedValueOnce({ data: { repairs }, usage: { input_tokens: 1, output_tokens: 1 } });
  const result = await extractABox(
    { tbox, documents: [{ name: "paper", text: "The actual source." }], requireEvidence: true },
    { provider: "gemini", model: "gemini-3.8-flash" },
  );
  expect(result.abox.individuals[0].evidence?.[0].quote).toBe("Invented quotation");
  expect(result.notes.join(" ")).toContain("repair incomplete");
});
