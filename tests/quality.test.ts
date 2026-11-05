// Unit tests for the domain-neutral update: layout-aware text, chunk overlap,
// pitfalls, code-style schemas, schema retrieval, entity resolution, the
// evidence gate, schema migration, the improvement loop, pricing, routed
// retrieval, the SPARQL worker, grounding and RDF conversion.

import { afterAll, describe, expect, it } from "vitest";
import type { ABoxResult } from "../src/types/abox.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { scanPitfalls, pitfallCounts, repairInstruction } from "../src/lib/ontology/pitfalls.ts";
import { applyMerge, applyMergeDecisions, classesCompatible, nameSimilarity, normalizeEntityName } from "../src/lib/ontology/resolution.ts";
import { serializeABox } from "../src/lib/ontology/aboxSerializer.ts";
import { parseABoxTurtle } from "../src/lib/ontology/aboxFromTurtle.ts";
import { htmlToBlocks, markdownStructure, serializeBlocks } from "../server/services/structuredText.ts";
import { chunkText, sectionPathAt } from "../server/services/chunking.ts";
import { describeTBoxCode } from "../server/prompts.ts";
import { retrieveSchema, subTBox } from "../server/services/schemaRetrieval.ts";
import { hashEmbedder, hashEmbed, cosine } from "../server/ml/embeddings.ts";
import { lexicalEntailment, lexicalScorer } from "../server/ml/nli.ts";
import { findMergeCandidates } from "../server/services/resolution.ts";
import { verifyAbox, verbaliseData } from "../server/services/verification.ts";
import { detectRenames, migrateAbox } from "../server/services/migration.ts";
import { groupProposals, proposalsToContent } from "../server/services/proposals.ts";
import { costUsd, priceOf } from "../server/services/pricing.ts";
import { personalizedPageRank, routeQuestion, rrf, text2sparql } from "../server/services/assistant.ts";
import { querySparql, stopSparqlPool } from "../server/services/sparqlPool.ts";
import { lookup, sourceForClass } from "../server/services/grounding.ts";
import { toTurtle, detectRdfFormat } from "../server/services/rdfConvert.ts";
import { withVersions } from "../server/services/revisions.ts";
import { readProposedTerms } from "../server/extract.ts";
import { conformAbox } from "../server/validation.ts";
import { clusterChunks } from "../server/services/induction.ts";
import type { DocumentChunk, OntologyRevision } from "../src/types/project.ts";

afterAll(async () => stopSparqlPool());

const NS = "http://ex.org/onto#";
const TBOX = `
@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Organisation a owl:Class ; rdfs:label "Organisation" ; rdfs:comment "A company or institution." .
:Supplier a owl:Class ; rdfs:subClassOf :Organisation ; rdfs:label "Supplier" ; rdfs:comment "An organisation that delivers goods." .
:Customer a owl:Class ; rdfs:subClassOf :Organisation ; rdfs:label "Customer" ; rdfs:comment "An organisation that buys goods." .
:Agreement a owl:Class ; rdfs:label "Agreement" ; rdfs:comment "A contract between parties." .
:Person a owl:Class ; rdfs:label "Person" ; rdfs:comment "A human being." ; owl:disjointWith :Organisation .
:isPartyTo a owl:ObjectProperty ; rdfs:domain :Organisation ; rdfs:range :Agreement ; rdfs:label "is party to" ; rdfs:comment "Links a party to an agreement." .
:value a owl:DatatypeProperty ; rdfs:domain :Agreement ; rdfs:range xsd:decimal ; rdfs:label "value" ; rdfs:comment "Contract value." .
`;
const tbox = parseTBox(TBOX);

describe("layout-aware text", () => {
  it("serialises blocks with exact section and table spans", () => {
    const st = serializeBlocks([
      { kind: "heading", text: "Supply agreement", level: 1, page: 1 },
      { kind: "paragraph", text: "Acme supplies widgets.", page: 1 },
      { kind: "heading", text: "Payment", level: 2, page: 2 },
      { kind: "table", text: "", rows: [["Item", "Price"], ["Widget", "10 | EUR"]], page: 2 },
    ]);
    expect(st.text.slice(st.sections[1].start, st.sections[1].start + 10)).toBe("## Payment");
    expect(st.sections[1].path).toEqual(["Supply agreement", "Payment"]);
    expect(st.sections[0].end).toBe(st.text.length);
    expect(st.text.slice(st.tables[0].start, st.tables[0].end)).toContain("| Widget | 10 \\| EUR |");
    expect(st.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(st.pages[1].end).toBe(st.text.length);
  });

  it("turns HTML (and mammoth's DOCX HTML) into headings, lists and tables", () => {
    const blocks = htmlToBlocks("<html><head><style>x{}</style></head><body><h1>Title &amp; more</h1><p>Intro</p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>evil()</script></body></html>");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list_item", "list_item", "table"]);
    expect(blocks[0].text).toBe("Title & more");
    expect(serializeBlocks(blocks).text).not.toContain("evil");
  });

  it("finds Markdown sections and pipe tables without changing the text", () => {
    const text = "# A\n\nintro\n\n## B\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n# C\n";
    const st = markdownStructure(text);
    expect(st.sections.map((s) => s.path.join(">"))).toEqual(["A", "A>B", "C"]);
    expect(text.slice(st.tables[0].start, st.tables[0].end).split("\n")).toHaveLength(3);
    expect(sectionPathAt(st.sections, text.indexOf("| 1"))).toEqual(["A", "B"]);
  });
});

describe("chunk overlap", () => {
  it("repeats the tail of the previous chunk, keeps exact offsets and section paths", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} states a fact about item ${i}. It continues for a while to fill the chunk.`);
    const text = `# Head\n\n${paras.join("\n\n")}`;
    const st = markdownStructure(text);
    const chunks = chunkText(text, [], 600, { overlap: 0.2, sections: st.sections });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text).toBe(text.slice(c.start, c.end));
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeLessThan(chunks[i - 1].end);
      expect(chunks[i].overlap).toBe(chunks[i - 1].end - chunks[i].start > 0 ? chunks[i].overlap : undefined);
      expect(/^\S/.test(chunks[i].text)).toBe(true);
    }
    expect(chunks[2].sectionPath).toEqual(["Head"]);
  });
});

describe("pitfall scanner", () => {
  it("finds the OOPS! and LLM-specific pitfalls", () => {
    const bad = parseTBox(`
@prefix : <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Pump a owl:Class . :Pumps a owl:Class . :Valve a owl:Class ; rdfs:subClassOf :Device . :Sensor a owl:Class ; rdfs:subClassOf :Device . :Device a owl:Class .
:Manufacturer a owl:Class . :AcmeGmbH a owl:Class ; rdfs:label "Acme GmbH" . :Lonely a owl:Class .
:hasManufacturer a owl:DatatypeProperty ; rdfs:domain :Device ; rdfs:range xsd:string .
:feeds a owl:ObjectProperty .
:A a owl:Class ; rdfs:subClassOf :B . :B a owl:Class ; rdfs:subClassOf :A .
:p a owl:ObjectProperty ; rdfs:domain :Pump ; rdfs:domain :Valve ; rdfs:range :Device .
`);
    const found = scanPitfalls(bad, { modules: [{ turtle: `@prefix : <${NS}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . :p rdfs:domain :Pump ; rdfs:domain :Valve .` }] });
    const codes = new Set(found.map((p) => p.code));
    for (const c of ["P06", "P19", "P11", "P02", "P10", "OL-INST", "OL-ATTR", "P04", "P08"]) expect(codes.has(c), c).toBe(true);
    expect(found[0].severity).toBe("critical");
    expect(pitfallCounts(found).critical).toBeGreaterThan(0);
    expect(repairInstruction(found)).toMatch(/Fix:/);
  });

  it("finds nothing serious in a clean T-Box", () => {
    const counts = pitfallCounts(scanPitfalls(tbox, { modules: [{ turtle: TBOX }] }));
    expect(counts.critical).toBe(0);
  });
});

describe("code-style schema rendering", () => {
  it("renders classes with bases, docstrings and their properties", () => {
    const code = describeTBoxCode(tbox);
    expect(code).toContain("class Supplier(Organisation):");
    expect(code).toMatch(/isPartyTo: list\["Agreement"\]/);
    expect(code.indexOf("class Organisation(")).toBeLessThan(code.indexOf("class Supplier("));
    expect(code).toContain("Never also a Organisation");
  });
});

describe("schema retrieval", () => {
  it("keeps chosen properties' domain/range classes and every ancestor", () => {
    const sub = subTBox(tbox, new Set([`${NS}Supplier`]), new Set());
    expect(sub.classes.map((c) => c.uri)).toEqual([`${NS}Supplier`]);
    expect(sub.subClassOf[`${NS}Supplier`]).toEqual([]);
  });

  it("retrieves the relevant part of the ontology for a chunk", async () => {
    const r = await retrieveSchema(tbox, "The supplier signed the agreement; its value is 10,000 EUR.", hashEmbedder, "t1", { force: true, k: 2 });
    expect(r.full).toBe(false);
    const uris = new Set(r.tbox.classes.map((c) => c.uri));
    expect(uris.has(`${NS}Supplier`)).toBe(true);
    expect(uris.has(`${NS}Organisation`)).toBe(true); // ancestor closure
    for (const p of r.tbox.objectProps) for (const d of p.domain) expect(uris.has(d)).toBe(true);
  });
});

describe("embeddings and entailment fallbacks", () => {
  it("hash embeddings put related names closer than unrelated ones", () => {
    expect(cosine(hashEmbed("has component"), hashEmbed("hasComponent"))).toBeGreaterThan(cosine(hashEmbed("has component"), hashEmbed("payment term")));
  });

  it("lexical entailment requires the numbers of the claim", () => {
    expect(lexicalEntailment("Payment is due within 30 days of invoice.", "Payment is due within 30 days.")).toBeGreaterThan(0.6);
    expect(lexicalEntailment("Payment is due within 30 days of invoice.", "Payment is due within 60 days.")).toBeLessThan(0.3);
  });
});

describe("entity resolution", () => {
  it("normalises legal suffixes and recognises shortened names and acronyms", () => {
    expect(normalizeEntityName("Acme Robotics GmbH")).toBe("acme robotics");
    expect(nameSimilarity("Acme Robotics GmbH", "Acme Robotics")).toBe(1);
    expect(nameSimilarity("International Business Machines", "IBM")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Pump P-101", "Pump P-102")).toBeLessThan(0.85);
  });

  it("only compares individuals of compatible, non-disjoint classes", () => {
    expect(classesCompatible(tbox, `${NS}Supplier`, `${NS}Organisation`)).toBe(true);
    expect(classesCompatible(tbox, `${NS}Supplier`, `${NS}Customer`)).toBe(false);
    expect(classesCompatible(tbox, `${NS}Person`, `${NS}Organisation`)).toBe(false);
  });

  const abox: ABoxResult = {
    individuals: [
      { id: "acme", classUri: `${NS}Supplier`, label: "Acme Robotics GmbH", objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] },
      { id: "acme-2", classUri: `${NS}Supplier`, label: "Acme Robotics", sameAs: ["http://www.wikidata.org/entity/Q1"] },
      { id: "acme-3", classUri: `${NS}Organisation`, label: "ACME robotics", sameAs: ["http://www.wikidata.org/entity/Q1"] },
      { id: "beta", classUri: `${NS}Customer`, label: "Beta Foods", objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] },
      { id: "sa", classUri: `${NS}Agreement`, label: "Supply agreement" },
    ],
  };

  it("finds candidates without a model and recommends the certain ones", async () => {
    const { candidates, llmCalls } = await findMergeCandidates(abox, tbox, { embedder: hashEmbedder });
    expect(llmCalls).toBe(0);
    const merge = candidates.filter((c) => c.decision === "merge");
    expect(merge.length).toBe(1);
    expect(new Set(merge[0].ids)).toEqual(new Set(["acme", "acme-2", "acme-3"]));
    expect(candidates.some((c) => c.ids.includes("beta"))).toBe(false);
  });

  it("applies a merge: claims move, links retarget, nothing dangles", () => {
    const withLink: ABoxResult = { individuals: [...abox.individuals, { id: "x", classUri: `${NS}Agreement`, objectProperties: [] }] };
    withLink.individuals[4] = { ...withLink.individuals[4] };
    const { abox: merged } = applyMerge(
      { individuals: [...withLink.individuals.slice(0, 4), { id: "sa", classUri: `${NS}Agreement`, label: "SA" }, { id: "ref", classUri: `${NS}Organisation`, objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] }] },
      ["acme", "acme-2"],
    );
    const acme = merged.individuals.find((i) => i.id === "acme")!;
    expect(acme.mergedFrom).toEqual(["acme-2"]);
    expect(acme.sameAs).toEqual(["http://www.wikidata.org/entity/Q1"]);
    expect(merged.individuals.some((i) => i.id === "acme-2")).toBe(false);
    const decided = applyMergeDecisions(abox, [{ id: "m", ids: ["acme", "acme-2", "acme-3"], label: "", score: 1, method: "label", decision: "merge", explanation: "" }]);
    expect(decided.individuals.map((i) => i.id)).toEqual(["acme", "beta", "sa"]);
  });

  it("exports grounding as owl:sameAs and reads it back", () => {
    const { turtle } = serializeABox({ individuals: [abox.individuals[1]] }, tbox);
    expect(turtle).toContain("wikidata.org/entity/Q1");
    expect(parseABoxTurtle(turtle).individuals[0].sameAs).toEqual(["http://www.wikidata.org/entity/Q1"]);
  });
});

describe("evidence gate", () => {
  it("scores each quoted claim and flags the unsupported ones", async () => {
    const a: ABoxResult = {
      individuals: [
        {
          id: "sa",
          classUri: `${NS}Agreement`,
          label: "Supply agreement",
          dataProperties: [
            { propUri: `${NS}value`, value: "10000", evidence: [{ quote: "The supply agreement has a value of 10000 EUR.", status: "verified" }] },
            { propUri: `${NS}value`, value: "99", evidence: [{ quote: "The supply agreement has a value of 10000 EUR.", status: "verified" }] },
          ],
        },
      ],
    };
    expect(verbaliseData(a.individuals[0], a.individuals[0].dataProperties![0], tbox)).toBe("Supply agreement has value 10000.");
    const res = await verifyAbox(a, tbox, lexicalScorer);
    expect(res.scored).toBe(2);
    const [ok, bad] = res.abox.individuals[0].dataProperties!.map((d) => d.evidence![0]);
    expect(ok.review).toBeUndefined();
    expect(bad.review).toBe(true);
    expect(bad.claim).toContain("99");
  });
});

describe("schema migration", () => {
  it("renames individuals' terms and flags removed ones", () => {
    const after = parseTBox(TBOX.replace(/:Supplier/g, ":Vendor").replace('rdfs:label "Supplier"', 'rdfs:label "Supplier"').replace(/:value a owl:DatatypeProperty[^\n]*\n/, ""));
    expect(detectRenames(tbox, after).get(`${NS}Supplier`)).toBe(`${NS}Vendor`);
    const { abox, report } = migrateAbox(tbox, after, {
      individuals: [
        { id: "a", classUri: `${NS}Supplier` },
        { id: "b", classUri: `${NS}Agreement`, dataProperties: [{ propUri: `${NS}value`, value: "1" }] },
      ],
    });
    expect(abox.individuals[0].classUri).toBe(`${NS}Vendor`);
    expect(report.renamed).toEqual([{ from: `${NS}Supplier`, to: `${NS}Vendor`, individuals: 1 }]);
    expect(report.flagged).toEqual([{ id: "b", term: `${NS}value` }]);
  });

  it("versions the T-Box and the A-Box separately", () => {
    const rev = (id: string, n: number, t: string, a: string, parent: string | null): OntologyRevision => ({
      id,
      projectId: "p",
      parentId: parent,
      number: n,
      status: "committed",
      source: "manual",
      summary: "",
      contentHash: id,
      stats: { modules: 1, classes: 1, individuals: a ? 1 : 0, assertions: 0, tboxHash: t, aboxHash: a },
      createdBy: "u",
      createdAt: "",
      updatedAt: "",
    });
    const v = withVersions([rev("r1", 1, "T1", "", null), rev("r2", 2, "T1", "A1", "r1"), rev("r3", 3, "T2", "A1", "r2"), rev("r4", 4, "T2", "A2", "r3")]);
    expect(v.map((r) => [r.tboxVersion, r.aboxVersion, r.scope])).toEqual([
      [1, null, "tbox"],
      [1, 1, "abox"],
      [2, 1, "tbox"],
      [2, 2, "abox"],
    ]);
  });
});

describe("improvement loop", () => {
  it("keeps unknown terms from the conformance pass and the model's proposals", () => {
    const { unmatched } = conformAbox([{ id: "w", classUri: `${NS}Warehouse`, sourceEvidence: "the Leeds warehouse" }], tbox);
    expect(unmatched).toEqual([{ kind: "class", name: "Warehouse", definition: "", quote: "the Leeds warehouse" }]);
    expect(readProposedTerms([{ kind: "class", name: "Warehouse", definition: "A storage site.", parent: "Organisation" }, { kind: "bogus", name: "x" }])).toHaveLength(1);
  });

  it("groups proposals by meaning and turns accepted ones into linked T-Box additions", async () => {
    const proposals = await groupProposals(
      [
        { kind: "class", name: "Warehouse", definition: "A building where goods are stored.", parent: "Organisation", quote: "q1" },
        { kind: "class", name: "Warehouses", definition: "Storage buildings.", quote: "q2" },
        { kind: "class", name: "Supplier", definition: "already exists" },
        { kind: "objectProperty", name: "storedAt", definition: "Where goods are stored.", domain: "Agreement", range: "Warehouse" },
      ],
      tbox,
      hashEmbedder,
    );
    expect(proposals.map((p) => [p.name, p.count])).toEqual([
      ["Warehouse", 2],
      ["storedAt", 1],
    ]);
    const base = { modules: [{ id: "m1", name: "core.ttl", turtle: TBOX }], abox: null, baseIri: "" };
    const { content } = proposalsToContent(base, tbox, proposals);
    const ext = content.modules.find((m) => m.name === "extensions.ttl")!;
    const merged = parseTBox(TBOX + "\n" + ext.turtle);
    expect(merged.subClassOf[`${NS}Warehouse`]).toEqual([`${NS}Organisation`]);
    expect(merged.objectProps.find((p) => p.uri === `${NS}storedAt`)?.range).toEqual([`${NS}Warehouse`]);
  });
});

describe("pricing", () => {
  it("prices by model family and leaves unknown models unpriced", () => {
    expect(priceOf("claude", "claude-sonnet-4-6")).toEqual({ input: 3, output: 15 });
    expect(priceOf("mock", "mock-1")).toEqual({ input: 0, output: 0 });
    expect(priceOf("acme", "unknown-model")).toBeNull();
    expect(costUsd("claude", "claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4.5);
  });
});

describe("routed retrieval", () => {
  const g: ABoxResult = {
    individuals: [
      { id: "acme", classUri: `${NS}Supplier`, label: "Acme", objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] },
      { id: "sa", classUri: `${NS}Agreement`, label: "Supply agreement" },
      { id: "beta", classUri: `${NS}Customer`, label: "Beta Foods", objectProperties: [{ propUri: `${NS}isPartyTo`, targetId: "sa" }] },
      { id: "far", classUri: `${NS}Agreement`, label: "Unrelated deal" },
    ],
  };

  it("routes by wording and named entities", () => {
    expect(routeQuestion("How many agreements are there?", g)).toBe("aggregate");
    expect(routeQuestion("Who is party to the agreement with Acme and Beta Foods?", g)).toBe("multi");
    expect(routeQuestion("What does clause 4 say about delivery?", g)).toBe("single");
  });

  it("Personalized PageRank ranks the seed's neighbourhood above unconnected nodes", () => {
    const ranked = personalizedPageRank(g, ["acme"]).map((r) => r.id);
    expect(ranked.slice(0, 3)).toEqual(expect.arrayContaining(["acme", "sa", "beta"]));
    expect(ranked).not.toContain("far");
  });

  it("fuses rankings with RRF", () => {
    expect(rrf([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("repairs a failing query from the error message", async () => {
    let calls = 0;
    const res = await text2sparql("How many?", tbox, "http://ex.org/abox#", async () => {
      calls++;
      if (calls === 1) throw new Error("Unknown prefix");
      return { columns: ["n"], rows: [{ n: "3" }] };
    }, { provider: "mock", model: "mock-1" });
    expect(res.attempts).toBe(2);
    expect(res.rows).toEqual([{ n: "3" }]);
  });
});

describe("SPARQL worker", () => {
  it("answers from a cached store and stops a runaway query", async () => {
    const ttl = Array.from({ length: 400 }, (_, i) => `<http://e/s${i}> <http://e/p> <http://e/o${i % 7}> .`).join("\n");
    const ok = await querySparql("t1", () => ttl, "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }");
    expect(ok.rows[0].n).toBe("400");
    await expect(querySparql("t1", () => ttl, "SELECT * WHERE { ?a ?p ?b . ?c ?q ?d . ?e ?r ?f . ?g ?t ?h }", { timeoutMs: 300 })).rejects.toThrow(/stopped/);
    // the worker restarts and reloads the graph on demand
    const again = await querySparql("t1", () => ttl, "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }");
    expect(again.rows[0].n).toBe("400");
    await expect(querySparql("t1", () => ttl, "DELETE WHERE { ?s ?p ?o }")).rejects.toThrow();
  }, 20_000);
});

describe("grounding", () => {
  it("picks a registry from the class and links only an unambiguous exact match", async () => {
    expect(sourceForClass(tbox, `${NS}Supplier`, ["wikidata"])).toBe("wikidata");
    const fake = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await lookup("wikidata", "Acme Robotics", fake({ search: [{ id: "Q1", label: "Acme Robotics" }, { id: "Q2", label: "Acme Robotics Inc" }] }))).toBeNull();
    expect(await lookup("wikidata", "Acme Robotics", fake({ search: [{ id: "Q1", label: "Acme Robotics" }, { id: "Q9", label: "Acme Toys" }] }))).toBe("http://www.wikidata.org/entity/Q1");
  });
});

describe("standard imports", () => {
  it("converts RDF/XML and JSON-LD to Turtle that the T-Box parser reads", async () => {
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"><owl:Class rdf:about="http://ex.org/fibo#Contract"><rdfs:label>Contract</rdfs:label></owl:Class></rdf:RDF>`;
    expect(detectRdfFormat("fibo.owl", xml)).toBe("rdfxml");
    const t = await toTurtle("fibo.owl", xml);
    expect(parseTBox(t.turtle).classes.map((c) => c.label)).toEqual(["Contract"]);
    const j = await toTurtle("s.jsonld", JSON.stringify({ "@id": "http://ex.org/s#Thing", "@type": "http://www.w3.org/2002/07/owl#Class" }));
    expect(parseTBox(j.turtle).classes).toHaveLength(1);
  });

  it("does not turn an external equivalence target into a local class", () => {
    const m = parseTBox(`${TBOX}\n<${NS}Agreement> <http://www.w3.org/2002/07/owl#equivalentClass> <https://schema.org/Contract> .`);
    expect(m.classes.some((c) => c.uri === "https://schema.org/Contract")).toBe(false);
  });
});

describe("induction clustering", () => {
  it("groups chunks into topic clusters by embedding", async () => {
    const mk = (i: number, text: string): DocumentChunk => ({ id: `c${i}`, documentId: "d", projectId: "p", ordinal: i, text: text.repeat(500), start: 0, end: 0 });
    const chunks = [mk(0, "payment invoice price currency "), mk(1, "invoice payment due price "), mk(2, "patient diagnosis medication dose "), mk(3, "medication patient dose allergy ")];
    const groups = await clusterChunks(chunks, await hashEmbedder.embed(chunks.map((c) => c.text.slice(0, 200))));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const together = (a: string, b: string) => groups.some((g) => g.some((c) => c.id === a) && g.some((c) => c.id === b));
    expect(together("c0", "c1")).toBe(true);
    expect(together("c2", "c3")).toBe(true);
  });
});
