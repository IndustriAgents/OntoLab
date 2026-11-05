import { expect, it } from "vitest";
import { preserveDocumentTitle, omitUnlocatedTitleDuplicates, omitSectionHeadingTitles } from "../server/services/documentTitle.ts";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import type { ABoxResult } from "../src/types/abox.ts";
const tbox = parseTBox(
  "@prefix :<https://test.example/#>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. @prefix xsd:<http://www.w3.org/2001/XMLSchema#>. :Study a owl:Class. :Tool a owl:Class. :title a owl:DatatypeProperty; rdfs:domain :Study; rdfs:range xsd:string.",
);
const text = "Complete Publication\nTitle\nAuthor\nAbstract content.";
const heading = [{ start: 0, end: text.length, title: "Complete Publication Title", level: 1, path: ["Complete Publication Title"] }];
const study = { id: "study", classUri: "https://test.example/#Study", sourceEvidence: "Complete Publication\nTitle" };
it("preserves a full wrapped title with exact evidence only for the eligible source-grounded subject", () => {
  const input: ABoxResult = { individuals: [study, { ...study, id: "tool", classUri: "https://test.example/#Tool" }] };
  const result = preserveDocumentTitle(input, tbox, { start: 0, text }, heading);
  expect(result.abox.individuals[0].dataProperties?.[0]).toMatchObject({
    value: "Complete Publication Title",
    evidence: [{ quote: "Complete Publication\nTitle", status: "unverified" }],
  });
  expect(result.abox.individuals[1].dataProperties).toBeUndefined();
  expect(input.individuals[0].dataProperties).toBeUndefined();
});

it("drops only an unreviewed unlocated duplicate of a same-document located title", () => {
  const prop = {
    propUri: "https://test.example/#title",
    value: "Complete Publication Title",
    evidence: [{ quote: "Complete Publication Title", status: "unverified" as const }],
  };
  const input = { individuals: [{ ...study, dataProperties: [prop] }] };
  const prior = {
    individuals: [
      {
        ...study,
        dataProperties: [
          {
            ...prop,
            value: "Complete Publication Title ∗",
            evidence: [{ quote: "Complete Publication\nTitle ∗", status: "verified" as const, documentId: "doc" }],
          },
        ],
      },
    ],
  };
  const result = omitUnlocatedTitleDuplicates(input, prior, [{ name: "Abstract", text: "Abstract content." }]);
  expect(result.abox.individuals[0].dataProperties).toEqual([]);
  expect(result.notes[0]).toContain("retained earlier same-document assertion");
  expect(input.individuals[0].dataProperties).toHaveLength(1);
  expect(prior.individuals[0].dataProperties).toHaveLength(1);
  expect(omitUnlocatedTitleDuplicates(input, prior, [{ name: "Title", text }]).abox).toEqual(input);
  for (const changed of [{ value: "A different title" }, { review: { by: "user" as const, status: "accepted" as const } }]) {
    const candidate = { individuals: [{ ...study, dataProperties: [{ ...prop, ...changed }] }] };
    expect(omitUnlocatedTitleDuplicates(candidate, prior, []).abox).toEqual(candidate);
  }
  expect(omitUnlocatedTitleDuplicates(input, { individuals: [{ ...prior.individuals[0], id: "another-study" }] }, []).abox).toEqual(input);
  expect(omitUnlocatedTitleDuplicates(input, { individuals: [] }, []).abox).toEqual(input);
});
it("does not guess between identities, infer from a section, or overwrite an existing title", () => {
  const duplicate = { individuals: [study, { ...study, id: "other" }] };
  expect(preserveDocumentTitle(duplicate, tbox, { start: 0, text }, heading).abox).toBe(duplicate);
  const existing = {
    individuals: [{ ...study, dataProperties: [{ propUri: "https://test.example/#title", value: "Existing reviewed title" }] }],
  };
  expect(preserveDocumentTitle(existing, tbox, { start: 0, text }, heading).abox).toBe(existing);
  const input = { individuals: [study] };
  expect(preserveDocumentTitle(input, tbox, { start: 10, text }, heading).abox).toBe(input);
  expect(
    preserveDocumentTitle({ individuals: [{ ...study, sourceEvidence: "Abstract content." }] }, tbox, { start: 0, text }, heading).notes,
  ).toEqual([]);
});

const sectionText = "Complete Publication\nTitle ∗\nAuthor\n3 Plant modelling\nThe approach is described here.";
const sectionStart = sectionText.indexOf("3 Plant");
const document = {
  text: sectionText,
  sections: [
    { start: 0, end: sectionText.length, title: "Complete Publication Title ∗", level: 1, path: ["Complete Publication Title ∗"] },
    {
      start: sectionStart,
      end: sectionText.length,
      title: "3 Plant modelling",
      level: 2,
      path: ["Complete Publication Title ∗", "3 Plant modelling"],
    },
  ],
};
const canonical = {
  propUri: "https://test.example/#title",
  value: "Complete Publication Title",
  evidence: [{ quote: "Complete Publication\nTitle", documentId: "doc", status: "verified" as const }],
};
const sectionTitle = {
  propUri: canonical.propUri,
  value: "Plant modelling",
  evidence: [{ quote: "Plant modelling", status: "unverified" as const }],
};
const previous = { individuals: [{ ...study, dataProperties: [canonical] }] };
const sectionInput = { individuals: [{ ...study, dataProperties: [sectionTitle] }] };

it("omits a grounded section-heading title only from the already titled publication and logs its evidence", () => {
  const out = omitSectionHeadingTitles(sectionInput, previous, "doc", document);
  expect(out.abox.individuals[0].dataProperties).toEqual([]);
  expect(out.notes[0]).toContain("Omitted section heading proposed as publication title");
  expect(out.notes[0]).toContain('"start":' + sectionStart);
  expect(out.notes[0]).toContain(canonical.value);
  expect(previous.individuals[0].dataProperties).toEqual([canonical]);
  expect(sectionInput.individuals[0].dataProperties).toEqual([sectionTitle]);
});

it("also protects a publication introduced with its root title in the current chunk", () => {
  const input = { individuals: [{ ...study, dataProperties: [canonical, sectionTitle] }] };
  expect(omitSectionHeadingTitles(input, { individuals: [] }, "doc", document).abox.individuals[0].dataProperties).toEqual([canonical]);
});

it("preserves a separate section entity and any title not matching a parsed heading", () => {
  const input = {
    individuals: [
      { ...study, id: "section", dataProperties: [sectionTitle] },
      { ...study, dataProperties: [{ ...sectionTitle, value: "An alternate publication title" }] },
    ],
  };
  expect(omitSectionHeadingTitles(input, previous, "doc", document).abox).toEqual(input);
});

it("requires the root title and section heading to be grounded in the same document", () => {
  expect(omitSectionHeadingTitles(sectionInput, previous, "another-doc", document).abox).toEqual(sectionInput);
  expect(omitSectionHeadingTitles(sectionInput, { individuals: [] }, "doc", document).abox).toEqual(sectionInput);
  expect(omitSectionHeadingTitles(sectionInput, previous, "doc", { text: sectionText }).abox).toEqual(sectionInput);
  const misplaced = { ...document, sections: document.sections.map((s) => ({ ...s, start: s.start + 1 })) };
  expect(omitSectionHeadingTitles(sectionInput, previous, "doc", misplaced).abox).toEqual(sectionInput);
  const unverified = {
    individuals: [
      {
        ...study,
        dataProperties: [{ ...canonical, evidence: [{ quote: canonical.value, documentId: "doc", status: "unverified" as const }] }],
      },
    ],
  };
  expect(omitSectionHeadingTitles(sectionInput, unverified, "doc", document).abox).toEqual(sectionInput);
});

it.each(["accepted", "rejected", "candidate"] as const)(
  "preserves existing %s review decisions, even on the heading candidate",
  (status) => {
    const reviewed = { ...sectionTitle, review: { status, by: "user" as const } };
    const input = { individuals: [{ ...study, dataProperties: [reviewed] }] };
    expect(omitSectionHeadingTitles(input, previous, "doc", document).abox).toEqual(input);
    const reviewedPrior = { individuals: [{ ...study, dataProperties: [canonical, reviewed] }] };
    expect(omitSectionHeadingTitles(sectionInput, reviewedPrior, "doc", document).abox).toEqual(sectionInput);
  },
);

it("retains a title supported by more than a heading, and leaves descriptions unchanged", () => {
  const alternate = { ...sectionTitle, evidence: [{ quote: "The paper is also titled Plant modelling.", status: "unverified" as const }] };
  const description = { ...sectionTitle, propUri: "https://test.example/#description" };
  const input = { individuals: [{ ...study, dataProperties: [alternate, description] }] };
  expect(omitSectionHeadingTitles(input, previous, "doc", document).abox).toEqual(input);
});
