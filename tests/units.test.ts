import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkText } from "../server/services/chunking.ts";
import { locateQuote, resolveEvidence, legacyEvidence } from "../server/services/evidence.ts";
import { assertReadOnlyQuery } from "../server/services/sparqlGuard.ts";
import { parseDocument } from "../server/services/parsing.ts";
import { createLocalStore } from "../server/store/local.ts";
import { scoreChunks } from "../server/store/search.ts";
import { mergeAboxes, findPossibleDuplicates, diffContents } from "../src/lib/ontology/aboxMerge.ts";
import type { DocumentChunk, ExtractionRun, Project } from "../src/types/project.ts";

/** A minimal, valid two-page PDF with one line of text per page. */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontObj = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("chunking", () => {
  const text = ["Alpha paragraph one.", "Beta paragraph two is a bit longer.", "Gamma three.", "Delta four."].join("\n\n");

  it("keeps exact offsets and paragraph boundaries", () => {
    const chunks = chunkText(text, [], 45);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
    expect(chunks.every((c) => !c.text.startsWith("\n") && !c.text.endsWith("\n"))).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("splits an over-long paragraph and records pages", () => {
    const long = "Sentence number one is here. ".repeat(40).trim();
    const pages = [{ page: 1, start: 0, end: 400 }, { page: 2, start: 400, end: long.length }];
    const chunks = chunkText(long, pages, 300);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.end - c.start <= 300)).toBe(true);
    expect(chunks[0].page).toBe(1);
    expect(chunks[chunks.length - 1].page).toBe(2);
    for (const c of chunks) expect(long.slice(c.start, c.end)).toBe(c.text);
  });
});

describe("evidence", () => {
  const chunk: DocumentChunk = {
    id: "doc_1_c0",
    documentId: "doc_1",
    projectId: "p",
    ordinal: 0,
    start: 1000,
    end: 1100,
    page: 3,
    text: "The ejection cylinder  1A pushes the\nworkpiece out of the “stack magazine”.",
  };

  it("locates quotes despite whitespace, case and typographic quotes", () => {
    const hit = locateQuote('the ejection cylinder 1A pushes the workpiece out of the "stack magazine"', chunk.text);
    expect(hit).toEqual({ start: 0, end: chunk.text.indexOf("magazine") + "magazine".length });
  });

  it("does not invent locations for quotes that are not there", () => {
    expect(locateQuote("the swivel drive rotates 180 degrees", chunk.text)).toBeNull();
  });

  it("resolves claim-level evidence to document offsets", () => {
    const out = resolveEvidence(
      {
        individuals: [
          {
            id: "cyl",
            classUri: "urn:Actuator",
            sourceEvidence: "ejection cylinder 1A",
            objectProperties: [{ propUri: "urn:actsOn", targetId: "wp", evidence: [{ quote: "pushes the workpiece", status: "unverified" }] }],
            dataProperties: [{ propUri: "urn:pressure", value: "6", evidence: [{ quote: "six bar", status: "unverified" }] }],
          },
        ],
      },
      { documentId: "doc_1", chunk },
    );
    const ind = out.individuals[0];
    expect(ind.evidence?.[0]).toMatchObject({ status: "verified", documentId: "doc_1", chunkId: "doc_1_c0", page: 3, start: 1004 });
    expect(ind.objectProperties?.[0].evidence?.[0].status).toBe("verified");
    expect(ind.dataProperties?.[0].evidence?.[0]).toMatchObject({ status: "unverified", chunkId: "doc_1_c0" });
    expect(ind.dataProperties?.[0].evidence?.[0].start).toBeUndefined();
  });

  it("marks vision-only references and keeps legacy evidence location-free", () => {
    const out = resolveEvidence({ individuals: [{ id: "a", classUri: "urn:C", sourceEvidence: "from the diagram" }] }, { documentId: "d", chunk: null });
    expect(out.individuals[0].evidence?.[0].status).toBe("vision");
    expect(legacyEvidence({ id: "b", classUri: "urn:C", sourceEvidence: "old quote" })).toEqual([{ quote: "old quote", status: "legacy" }]);
  });
});

describe("merging and duplicates", () => {
  it("merges by id, keeps conflicting claims and evidence, never merges by label", () => {
    const { abox, notes } = mergeAboxes([
      { individuals: [{ id: "s1", classUri: "urn:Sensor", label: "Sensor B1", dataProperties: [{ propUri: "urn:io", value: "input" }], evidence: [{ quote: "q1", status: "verified" }] }] },
      {
        individuals: [
          { id: "s1", classUri: "urn:Actuator", dataProperties: [{ propUri: "urn:io", value: "output" }], evidence: [{ quote: "q2", status: "verified" }] },
          { id: "sensor-b1", classUri: "urn:Sensor", label: "sensor b1" },
          { id: "x", classUri: "urn:C", objectProperties: [{ propUri: "urn:p", targetId: "ghost" }] },
        ],
      },
    ]);
    const s1 = abox.individuals.find((i) => i.id === "s1")!;
    expect(abox.individuals).toHaveLength(3);
    expect(s1.additionalTypes).toEqual(["urn:Actuator"]);
    expect(s1.dataProperties?.map((d) => d.value)).toEqual(["input", "output"]);
    expect(s1.evidence).toHaveLength(2);
    expect(abox.individuals.find((i) => i.id === "x")?.objectProperties).toBeUndefined();
    expect(notes.join(" ")).toMatch(/typed differently/);
    expect(findPossibleDuplicates(abox)).toEqual([{ label: "Sensor B1", ids: ["s1", "sensor-b1"] }]);
  });

  it("diffs revisions by module name and individual id", () => {
    const d = diffContents(
      { modules: [{ id: "1", name: "a.ttl", turtle: "x" }], abox: { individuals: [{ id: "a", classUri: "urn:C" }, { id: "b", classUri: "urn:C" }] }, baseIri: "" },
      { modules: [{ id: "1", name: "a.ttl", turtle: "y" }, { id: "2", name: "b.ttl", turtle: "z" }], abox: { individuals: [{ id: "a", classUri: "urn:D", label: "A" }, { id: "c", classUri: "urn:C" }] }, baseIri: "" },
    );
    expect(d.modules).toEqual({ added: ["b.ttl"], removed: [], changed: ["a.ttl"] });
    expect(d.individuals.added).toEqual(["c"]);
    expect(d.individuals.removed).toEqual(["b"]);
    expect(d.individuals.changed).toEqual([{ id: "a", changes: ["class", "label"] }]);
  });
});

describe("SPARQL guard", () => {
  it("accepts SELECT and ASK", () => {
    expect(assertReadOnlyQuery("PREFIX ex: <http://ex/> SELECT ?s WHERE { ?s a ex:C } LIMIT 3")).toBe("SELECT");
    expect(assertReadOnlyQuery("ASK { ?s ?p ?o }")).toBe("ASK");
  });
  it.each([
    ["DESCRIBE <http://ex/a>"],
    ["CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"],
    ["DELETE WHERE { ?s ?p ?o }"],
    ["LOAD <http://example.org/data.ttl>"],
    ["SELECT * WHERE { OPTIONAL { SERVICE <http://x/sparql> { ?s ?p ?o } } }"],
    ["SELECT * FROM NAMED <http://x/g> WHERE { GRAPH ?g { ?s ?p ?o } }"],
    ["SELECT WHERE {"],
  ])("rejects %s", (q) => {
    expect(() => assertReadOnlyQuery(q)).toThrow();
  });
});

describe("retrieval", () => {
  it("ranks chunks by keyword relevance", () => {
    const mk = (id: string, text: string): DocumentChunk => ({ id, documentId: "d", projectId: "p", ordinal: 0, start: 0, end: text.length, text });
    const hits = scoreChunks([mk("a", "The vacuum gripper picks the workpiece."), mk("b", "Safety instructions for operators."), mk("c", "Gripper gripper maintenance")], "How does the gripper pick a workpiece?", 2);
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
  });
});

describe("PDF parsing", () => {
  it("extracts text with page spans", async () => {
    const parsed = await parseDocument("plan.pdf", makePdf(["First page text", "Second page text"]));
    expect(parsed.kind).toBe("pdf");
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.text.slice(parsed.pages[1].start, parsed.pages[1].end)).toContain("Second page");
    expect(parsed.text.slice(parsed.pages[0].start, parsed.pages[0].end)).toContain("First page");
  });
});

describe("local store atomicity", () => {
  async function withStore<T>(fn: (s: ReturnType<ReturnType<typeof createLocalStore>["forUser"]>, project: Project) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), "ontolab-store-"));
    try {
      const s = createLocalStore(dir).forUser({ id: "u1" });
      const now = new Date().toISOString();
      const project: Project = { id: "prj_1", ownerId: "u1", name: "p", purpose: "", scope: "", competencyQuestions: [], settings: {}, currentRevisionId: null, archived: false, createdAt: now, updatedAt: now };
      await s.projects.create(project);
      return await fn(s, project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const run = (now: string): ExtractionRun => ({
    id: "run_1",
    projectId: "prj_1",
    ownerId: "u1",
    status: "running",
    mode: "automatic",
    documentIds: [],
    documentChecksums: {},
    baseRevisionId: null,
    provider: "mock",
    model: "mock-1",
    settings: { vision: [] },
    steps: [],
    completedSteps: 0,
    attempts: 0,
    lease: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    questions: [],
    clarifications: [],
    qaRound: 1,
    qaDone: false,
    notes: [],
    createdAt: now,
    updatedAt: now,
  });

  it("grants a lease to exactly one concurrent caller", async () => {
    await withStore(async (s) => {
      const now = new Date();
      await s.runs.create(run(now.toISOString()));
      const results = await Promise.all(["a", "b", "c", "d"].map((h) => s.runs.acquireLease("prj_1", "run_1", h, 60_000, now)));
      expect(results.filter(Boolean)).toHaveLength(1);
      // expired leases can be taken over
      const later = new Date(now.getTime() + 61_000);
      expect(await s.runs.acquireLease("prj_1", "run_1", "e", 60_000, later)).not.toBeNull();
    });
  });

  it("inserts a checkpoint key once, even under concurrent writes", async () => {
    await withStore(async (s) => {
      await s.runs.create(run(new Date().toISOString()));
      const cp = (n: number) => ({ runId: "run_1", key: "chunk:doc:0", ordinal: 0, abox: { individuals: [{ id: `i${n}`, classUri: "urn:C" }] }, notes: [], usage: { inputTokens: 0, outputTokens: 0 }, createdAt: "" });
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => s.runs.putCheckpoint("prj_1", cp(n))));
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await s.runs.checkpoints("prj_1", "run_1");
      expect(stored).toHaveLength(1);
    });
  });

  it("rejects a commit whose parent is stale", async () => {
    await withStore(async (s) => {
      const now = new Date().toISOString();
      const rev = (id: string, parentId: string | null) => ({
        id,
        projectId: "prj_1",
        parentId,
        number: null,
        status: "draft" as const,
        source: "manual" as const,
        summary: "",
        contentHash: id,
        stats: { modules: 0, classes: 0, individuals: 0, assertions: 0 },
        createdBy: "u1",
        createdAt: now,
        updatedAt: now,
      });
      await s.revisions.create(rev("rev_a", null), { modules: [], abox: null, baseIri: "" });
      await s.revisions.create(rev("rev_b", null), { modules: [], abox: null, baseIri: "" });
      const results = await Promise.allSettled([s.revisions.commit("prj_1", "rev_a", null, now), s.revisions.commit("prj_1", "rev_b", null, now)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    });
  });

  it("refuses path-like ids", async () => {
    await withStore(async (s) => {
      await expect(s.documents.get("prj_1", "../../secret")).rejects.toThrow();
      await expect(s.blobs.get("../outside")).rejects.toThrow();
    });
  });
});
