import { describe, it, expect } from "vitest";
import { existingPropertyFor, foldProposedFacts } from "./proposedFacts.ts";
import { conformAbox } from "./validation.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";

const NS = "http://ex/music#";
const tbox = parseTBox(`
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Album a owl:Class . :Band a owl:Class . :RecordLabel a owl:Class .
:artist a owl:ObjectProperty ; rdfs:domain :Album ; rdfs:range :Band .
:recordLabel a owl:ObjectProperty ; rdfs:domain :Album ; rdfs:range :RecordLabel .
:releaseDate a owl:DatatypeProperty ; rdfs:domain :Album ; rdfs:range xsd:date .
:genre a owl:DatatypeProperty ; rdfs:domain :Album .
:mood a owl:DatatypeProperty .
`);
const TEXT = "The sludge metal album Nord was produced by the artist Year of No Light. It was released on the label Crucial Blast on 2006-09-06.";

describe("existingPropertyFor", () => {
  it("maps equal names and compounds ending in an existing name", () => {
    expect(existingPropertyFor("artist", tbox.objectProps)?.uri).toBe(`${NS}artist`);
    expect(existingPropertyFor("hasArtist", tbox.objectProps)?.uri).toBe(`${NS}artist`);
    expect(existingPropertyFor("albumArtist", tbox.objectProps)?.uri).toBe(`${NS}artist`);
    expect(existingPropertyFor("albumRecordLabel", tbox.objectProps)?.uri).toBe(`${NS}recordLabel`);
    expect(existingPropertyFor("album_release_date", tbox.dataProps)?.uri).toBe(`${NS}releaseDate`);
  });
  it("leaves genuinely new ideas alone", () => {
    expect(existingPropertyFor("producer", tbox.objectProps)).toBeNull();
    expect(existingPropertyFor("runtime", tbox.dataProps)).toBeNull();
    // a name that merely starts with an existing one is a different idea
    expect(existingPropertyFor("genreCount", tbox.dataProps)).toBeNull();
  });
});

describe("foldProposedFacts", () => {
  // what Claude Haiku returned for a Text2KGBench musical-work sentence set: no individuals, every fact proposed
  const proposed = [
    { kind: "objectProperty", name: "albumArtist", definition: "d", domain: "Album", range: "Band", subject: "nord-album", subjectLabel: "Nord", object: "year-of-no-light", quote: "The sludge metal album Nord was produced by the artist Year of No Light." },
    { kind: "objectProperty", name: "albumRecordLabel", definition: "d", domain: "Album", range: "RecordLabel", subject: "nord-album", subjectLabel: "Nord", object: "crucial-blast", quote: "It was released on the label Crucial Blast" },
    { kind: "dataProperty", name: "albumReleaseDate", definition: "d", domain: "Album", range: "date", subject: "nord-album", subjectLabel: "Nord", value: "2006-09-06", quote: "on 2006-09-06" },
    { kind: "objectProperty", name: "producer", definition: "a new idea", subject: "nord-album", object: "someone" },
    { kind: "class", name: "SludgeMetalAlbum", definition: "a new idea" },
  ];

  it("turns existing-property proposals into assertions that survive conformance", () => {
    const r = foldProposedFacts([], proposed, tbox, [TEXT]);
    expect(r.proposedTerms.map((t) => (t as { name: string }).name)).toEqual(["producer", "SludgeMetalAlbum"]);
    expect(r.notes[0]).toMatch(/3 proposed fact\(s\).*albumArtist → artist/);
    const { abox } = conformAbox(r.individuals, tbox);
    const album = abox.individuals.find((i) => i.id === "nord-album")!;
    expect(album.classUri).toBe(`${NS}Album`);
    expect(album.label).toBe("Nord");
    expect(album.objectProperties?.map((o) => [o.propUri, o.targetId])).toEqual([
      [`${NS}artist`, "year-of-no-light"],
      [`${NS}recordLabel`, "crucial-blast"],
    ]);
    expect(album.dataProperties?.[0]).toMatchObject({ propUri: `${NS}releaseDate`, value: "2006-09-06" });
    expect(album.objectProperties?.[0].evidence?.[0].quote).toMatch(/Year of No Light/);
    // created targets take the text's spelling of their name and the property's range class
    const band = abox.individuals.find((i) => i.id === "year-of-no-light")!;
    expect(band).toMatchObject({ classUri: `${NS}Band`, label: "Year of No Light" });
  });

  it("adds to an individual the model did emit, and keeps known targets from earlier chunks", () => {
    const r = foldProposedFacts(
      [{ id: "nord-album", classUri: `${NS}Album`, label: "Nord" }],
      [{ kind: "objectProperty", name: "albumArtist", definition: "d", subject: "nord-album", object: "yonl" }],
      tbox,
      [TEXT],
      new Set(["yonl"]),
    );
    expect(r.individuals).toHaveLength(1);
    expect((r.individuals[0] as { objectProperties: unknown[] }).objectProperties).toEqual([{ propUri: `${NS}artist`, targetId: "yonl" }]);
  });

  it("keeps a proposal it cannot place (no subject, no value, or no class for a new individual)", () => {
    const keep = [
      { kind: "dataProperty", name: "albumReleaseDate", definition: "d", value: "2006" },
      { kind: "dataProperty", name: "albumReleaseDate", definition: "d", subject: "x" },
      { kind: "dataProperty", name: "albumMood", definition: "d", subject: "x", value: "dark" }, // mood has no domain and x is new: no class for x
    ];
    const r = foldProposedFacts([], keep, tbox, [TEXT]);
    expect(r.proposedTerms).toHaveLength(3);
    expect(r.individuals).toHaveLength(0);
    expect(r.notes).toEqual([]);
  });

  it("does nothing without proposals", () => {
    const inds = [{ id: "a", classUri: `${NS}Album` }];
    expect(foldProposedFacts(inds, undefined, tbox)).toEqual({ individuals: inds, proposedTerms: [], notes: [] });
  });
});
