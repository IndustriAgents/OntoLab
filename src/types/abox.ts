// The structured A-Box the LLM emits (validated against the tool schema) and the
// shapes the client serializes to Turtle.

/* ───────────────────────── evidence ───────────────────────── */

/**
 * verified    — the quote was found in the cited chunk's text
 * unverified  — the model gave a quote that could not be located
 * vision      — produced from a PDF read as images; there is no text to check against
 * legacy      — carried over from free-text `sourceEvidence` without a location
 */
export type EvidenceStatus = "verified" | "unverified" | "vision" | "legacy";

export interface EvidenceRef {
  /** Immutable extraction snapshot which contains this evidence. */
  runId?: string;
  /** Recorded producing stage, when available. */
  stepKey?: string;
  documentId?: string;
  chunkId?: string;
  page?: number;
  /** offsets into the document text, only when the quote was located */
  start?: number;
  end?: number;
  quote: string;
  status: EvidenceStatus;
  /** entailment score of the claim given this quote, in [0, 1] (the NLI gate) */
  confidence?: number;
  /** the claim as the gate verbalised it, so a reviewer sees what was judged */
  claim?: string;
  /** below the review threshold, or quote not located: a person should look */
  review?: boolean;
  /** Recorded support-check inputs. Historical evidence can lack this artifact. */
  check?: { premise: string; hypothesis: string; backend: string; threshold: number };
}

/* ───────────────────────── per-fact review ───────────────────────── */

/**
 * candidate — extracted, not yet trusted (a person should look)
 * accepted  — trusted: verified evidence above the threshold, or a person said so
 * rejected  — wrong; kept for the record, left out of export, queries and reasoning
 */
export type FactStatus = "candidate" | "accepted" | "rejected";

/** The review state of one assertion. A fact without one counts as accepted (data from before review existed). */
export interface FactReview {
  status: FactStatus;
  by: "auto" | "user";
  at?: string;
  reason?: string;
  /** the confidence the decision was based on */
  confidence?: number;
  /** the run that produced the fact */
  runId?: string;
  /** who entered or last changed the fact by hand (email, name or user id) */
  editedBy?: string;
}

/** One manual change to the A-Box, kept on the draft as an audit trail. */
export interface ManualEdit {
  at: string;
  /** who made it (email, name or user id) */
  by: string;
  /** what the editor called the action ("Edit individual", "Add link") */
  label?: string;
  kind: "add" | "change" | "remove";
  /** factKey of the assertion, or `<id>#label` for a relabel */
  target: string;
  /** readable summary, e.g. "pump-1 hasPart → valve-2" */
  summary: string;
}

/**
 * A fact the extraction found but the ontology cannot express (it uses a term
 * the T-Box lacks). Kept with its quote so it can be replayed once the term is
 * added, instead of being lost.
 */
export interface PendingFact {
  id: string;
  documentId?: string;
  chunkId?: string;
  subjectId: string;
  subjectLabel?: string;
  subjectClass?: string;
  kind: "class" | "objectProperty" | "dataProperty";
  /** the missing term as the model named it */
  term: string;
  value?: string;
  targetId?: string;
  quote?: string;
}

/** Source membership is separate from quote verification or human acceptance. */
export interface FactOrigin {
  kind: "document" | "manual";
  documentId?: string;
  chunkId?: string;
  types?: string[];
}
export interface ABoxDataProp {
  origins?: FactOrigin[];
  propUri: string;
  value: string;
  /** xsd datatype URI; defaults to the property's declared range (or xsd:string) when omitted */
  datatype?: string;
  /** BCP-47 language tag for plain-text values (e.g. "de"); implies rdf:langString */
  lang?: string;
  /** where this value was read from (claim-level evidence) */
  evidence?: EvidenceRef[];
  review?: FactReview;
}

export interface ABoxObjectProp {
  origins?: FactOrigin[];
  propUri: string;
  /** the `id` of another individual in the same result */
  targetId: string;
  evidence?: EvidenceRef[];
  review?: FactReview;
}

export interface ABoxIndividual {
  origins?: FactOrigin[];
  id: string;
  classUri: string;
  label?: string;
  /**
   * Explicit IRI (set when the individual was parsed from Turtle or links to an
   * external resource). When absent the IRI is minted from baseIri + id.
   */
  iri?: string;
  /** additional rdf:types beyond classUri (multi-typing) */
  additionalTypes?: string[];
  /** external identifiers this individual was grounded to (Wikidata, GeoNames, UMLS …) as owl:sameAs */
  sameAs?: string[];
  /** ids of individuals merged into this one by entity resolution */
  mergedFrom?: string[];
  /** ids of individuals a reviewer said are distinct from this one (owl:differentFrom) */
  differentFrom?: string[];
  dataProperties?: ABoxDataProp[];
  objectProperties?: ABoxObjectProp[];
  /** short quote / location from the source documents supporting this individual */
  sourceEvidence?: string;
  /** structured, located evidence; `sourceEvidence` is kept for compatibility */
  evidence?: EvidenceRef[];
  /** review of the individual's existence and type (its classUri assertion) */
  review?: FactReview;
}

export interface UnresolvedRelationship extends ABoxObjectProp {
  id: string;
  subjectId: string;
  status: "open" | "dismissed";
}
export interface ABoxResult {
  unresolved?: UnresolvedRelationship[];
  individuals: ABoxIndividual[];
}

/** One uploaded document, as sent to the extraction endpoint. */
export interface ExtractDoc {
  name: string;
  /** extracted plain text (always present, may be empty for vision-only PDFs) */
  text: string;
  /** when true, send the raw PDF to Claude as a vision document block */
  asVision?: boolean;
  /** base64-encoded PDF bytes, required when asVision is true */
  pdfBase64?: string;
}

export type ValidationCode =
  | "duplicate-id"
  | "iri-collision"
  | "tbox-collision"
  | "unknown-class"
  | "unknown-property"
  | "dangling-target"
  | "domain"
  | "range"
  | "datatype"
  | "lexical"
  | "functional"
  | "disjoint"
  | "restriction"
  | "shacl"
  | "inconsistent"
  | "unsat-class";

/** A validation finding surfaced in the review screen (flag-and-keep). */
export interface ValidationIssue {
  severity: "error" | "warn";
  message: string;
  where: string;
  /** id of the individual the finding is about (when known) */
  id?: string;
  /** stable machine-readable code */
  code?: ValidationCode;
  /** the asserted axioms behind a reasoner finding, as readable lines */
  explanation?: string[];
  /** the property assertion the finding is about (absent = the individual or its type) */
  prop?: string;
}

/** A clarifying question the model asks during interactive (Q&A) extraction. */
export interface ClarifyQuestion {
  id: string;
  text: string;
  /** optional suggested answers */
  options?: string[];
}

/** An answered question, fed back into the next refine round. */
export interface Clarification {
  question: string;
  answer: string;
}
