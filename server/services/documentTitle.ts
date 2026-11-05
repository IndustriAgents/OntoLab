import type { ABoxResult, ExtractDoc } from "../../src/types/abox.ts";
import type { DocumentChunk, DocumentText, SectionSpan } from "../../src/types/project.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { localName, XSD } from "../../src/lib/ontology/iri.ts";
import { ancestorsOf } from "../../src/lib/ontology/hierarchy.ts";
import { locateQuote } from "../../src/lib/sourceQuote.ts";

const titleKey = (value: string) =>
  value
    .replace(/\s*[*∗†‡]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const headingKey = (value: string) => titleKey(value).replace(/^(?:\d+(?:\.\d+)*[.)]?|[ivxlcdm]+[.)])\s+/, "");

/** A located section heading does not rename the publication that contains it.
 * Require a grounded root title on this same identity/document, and heading-only
 * evidence for the new candidate. Keep section entities, alternate-title evidence,
 * and every existing review decision. Never infer a publication identity by class. */
export function omitSectionHeadingTitles(
  input: ABoxResult,
  prior: ABoxResult,
  documentId: string,
  document: Pick<DocumentText, "text" | "sections">,
) {
  const notes: string[] = [];
  const root = document.sections?.find((s) => s.start === 0 && s.level === 1);
  const rootHit = root && locateQuote(root.title, document.text);
  if (!root || !rootHit || rootHit.start !== 0) return { abox: input, notes };
  const rootQuote = document.text.slice(rootHit.start, rootHit.end);
  const headings = (document.sections ?? [])
    .filter((s) => s.start > 0 && s.level > root.level)
    .flatMap((s) => {
      const hit = locateQuote(s.title, document.text.slice(s.start, s.end));
      return hit?.start === 0 ? [{ ...s, quote: document.text.slice(s.start, s.start + hit.end) }] : [];
    });
  const abox = structuredClone(input);
  for (const subject of abox.individuals) {
    const previous = prior.individuals.find((i) => i.id === subject.id && i.classUri === subject.classUri);
    const existing = previous?.dataProperties ?? [];
    subject.dataProperties = subject.dataProperties?.filter((candidate) => {
      if (localName(candidate.propUri).toLowerCase() !== "title" || candidate.review) return true;
      const sameProperty = (p: typeof candidate) =>
        p.propUri === candidate.propUri &&
        (p.datatype ?? XSD + "string") === (candidate.datatype ?? XSD + "string") &&
        p.lang === candidate.lang;
      if (existing.some((p) => p.review && sameProperty(p) && titleKey(p.value) === titleKey(candidate.value))) return true;
      const canonical = [...existing, ...(subject.dataProperties ?? [])].find(
        (p) =>
          sameProperty(p) &&
          titleKey(p.value) === titleKey(root.title) &&
          p.evidence?.some(
            (e) =>
              (!e.documentId || e.documentId === documentId) &&
              !!locateQuote(e.quote, rootQuote) &&
              titleKey(e.quote) === titleKey(rootQuote) &&
              (!existing.includes(p) || (e.documentId === documentId && e.status === "verified")),
          ),
      );
      if (!canonical || titleKey(candidate.value) === titleKey(root.title)) return true;
      const section = headings.find(
        (s) =>
          headingKey(candidate.value) === headingKey(s.title) &&
          candidate.evidence?.length &&
          candidate.evidence.every(
            (e) =>
              (!e.documentId || e.documentId === documentId) &&
              headingKey(e.quote) === headingKey(s.title) &&
              !!locateQuote(e.quote, s.quote),
          ),
      );
      if (!section) return true;
      notes.push(
        `Omitted section heading proposed as publication title for ${subject.id}: ${JSON.stringify({ documentId, omitted: candidate, retained: canonical, section: { title: section.title, start: section.start, end: section.start + section.quote.length } })}. Candidate only; existing review decisions unchanged.`,
      );
      return false;
    });
  }
  return { abox, notes };
}

/** A later chunk must not turn an already located title into an unlocated copy.
 * Only same-document prior identities supplied by the caller are eligible.
 * Footnote markers are not a distinct publication title; other punctuation is. */
export function omitUnlocatedTitleDuplicates(input: ABoxResult, prior: ABoxResult, documents: ExtractDoc[]) {
  const notes: string[] = [];
  const abox = structuredClone(input);
  for (const subject of abox.individuals) {
    const previous = prior.individuals.find((i) => i.id === subject.id && i.classUri === subject.classUri);
    if (!previous || !subject.dataProperties) continue;
    subject.dataProperties = subject.dataProperties.filter((p) => {
      if (
        localName(p.propUri).toLowerCase() !== "title" ||
        p.review ||
        p.evidence?.some((e) => documents.some((d) => locateQuote(e.quote, d.text ?? "")))
      )
        return true;
      const original = previous.dataProperties?.find(
        (old) =>
          old.propUri === p.propUri &&
          (old.datatype ?? XSD + "string") === (p.datatype ?? XSD + "string") &&
          old.lang === p.lang &&
          titleKey(old.value) === titleKey(p.value) &&
          old.evidence?.some((e) => e.status === "verified" && e.documentId),
      );
      if (!original) return true;
      notes.push(
        `Omitted unlocated duplicate title for ${subject.id}; retained earlier same-document assertion: ${JSON.stringify({ omitted: p, retained: original })}. Earlier review decisions unchanged.`,
      );
      return false;
    });
  }
  return { abox, notes };
}

/** Preserve a source heading only when the model already identifies its subject
 * through that exact title and the ontology offers an unambiguous title mapping.
 * This creates a candidate assertion, never a review decision or an entity merge. */
export function preserveDocumentTitle(
  abox: ABoxResult,
  tbox: TBoxModel,
  chunk: Pick<DocumentChunk, "start" | "text">,
  sections: SectionSpan[],
): { abox: ABoxResult; notes: string[] } {
  const unchanged = { abox, notes: [] as string[] };
  if (chunk.start !== 0) return unchanged;
  const heading = sections.find((s) => s.start === 0 && s.level === 1);
  if (!heading) return unchanged;
  const hit = locateQuote(heading.title, chunk.text);
  if (!hit || hit.start !== 0) return unchanged;
  const quote = chunk.text.slice(hit.start, hit.end);
  const properties = tbox.dataProps.filter((p) => localName(p.uri).toLowerCase() === "title" && p.range.includes(XSD + "string"));
  if (properties.length !== 1) return unchanged;
  const prop = properties[0];
  const subjects = abox.individuals.filter((i) => {
    const types = new Set([i.classUri, ...(i.additionalTypes ?? []), ...ancestorsOf(tbox, i.classUri)]);
    if (prop.domain.length && !prop.domain.some((d) => types.has(d))) return false;
    const refs = i.evidence?.map((e) => e.quote) ?? (i.sourceEvidence ? [i.sourceEvidence] : []);
    return refs.some((q) => !!locateQuote(quote, q));
  });
  if (subjects.length !== 1 || subjects[0].dataProperties?.some((p) => p.propUri === prop.uri)) return unchanged;
  const subject = subjects[0];
  return {
    abox: {
      individuals: abox.individuals.map((i) =>
        i !== subject
          ? i
          : {
              ...i,
              dataProperties: [
                ...(i.dataProperties ?? []),
                {
                  propUri: prop.uri,
                  value: quote.replace(/\s+/g, " ").trim(),
                  datatype: XSD + "string",
                  evidence: [{ quote, status: "unverified" as const }],
                },
              ],
            },
      ),
    },
    notes: [
      `Preserved complete source title for ${subject.id} in ${prop.uri}: one eligible entity explicitly quoted the document heading. Candidate assertion; not human acceptance.`,
    ],
  };
}
