# OntoLab gold evaluation set (SEED)

> **Status: SEED, synthetic, AI-drafted.** Every document, T-Box, A-Box label, competency
> question, assistant question and evidence label in this folder was drafted by an AI model.
> None of it has been reviewed yet. **A human must review and correct these labels before any
> metric computed against them is trusted or reported.**

All content is invented: the companies, people, patients (pseudonymous ids only), clinicians,
equipment and manufacturers do not exist. No real patient data is included.

## Layout

```
eval/gold/<domain>/          domain = contracts | clinical | manuals
  tbox.ttl                   gold OWL T-Box (Turtle), base https://w3id.org/ontolab/gold/<domain>#
  docs/d1.txt ... d4.txt     source documents (plain text, '# ' / '## ' headings, lists, tables)
  abox.gold.json             hand-labelled gold A-Box over ALL docs of the domain
  domain.json                name, description, purpose, scope, user stories, approved CQs + SPARQL
  questions.json             12 assistant questions (4 single, 4 multi, 4 aggregate)
  evidence.labels.json       15 quote/claim pairs labelled entailed true/false
```

### tbox.ttl
One `owl:Ontology`; only `owl:Class`, `owl:ObjectProperty`, `owl:DatatypeProperty`,
`rdfs:subClassOf`, `owl:disjointWith` and `owl:FunctionalProperty`. Every term has `rdfs:label`,
`rdfs:comment`; every property has `rdfs:domain` and `rdfs:range` (data properties use
`xsd:string`, `xsd:decimal`, `xsd:integer`, `xsd:date` or `xsd:boolean`). No restrictions, no blank nodes.

### abox.gold.json
```json
{ "individuals": [
  { "key": "unique-key", "class": "LocalClassName", "label": "Preferred label",
    "aliases": ["surface forms used in the docs"], "docs": ["d1", "d3"],
    "data":  [ { "prop": "localDatatypeProp", "value": "..." } ],
    "links": [ { "prop": "localObjectProp", "target": "other-key" } ] } ] }
```
- `class` / `prop` are local names from the domain's `tbox.ttl`; `target` is another `key`.
- `docs` lists every document that mentions the individual (used for per-document scoring).
- Values: `xsd:decimal`/`xsd:integer` as JSON numbers (plain magnitudes, no units),
  `xsd:date` as `YYYY-MM-DD`, `xsd:boolean` as JSON `true`/`false`, otherwise strings.
- `aliases` capture cross-document name variants (e.g. "Northgate Components Ltd" /
  "Northgate Components Limited" / "Northgate"; "PT-4821" / "PT 4821"; "FS-200" / "FS200") so
  entity resolution can be measured. Each domain also contains at least one fact that spans
  a paragraph boundary (pronoun or "It"/"He"/"She" referring back to the previous paragraph).

Annotation conventions to check during review:
- contracts: only clauses that impose an obligation or a termination right are labelled as
  `Clause` individuals (definitions, governing-law and miscellaneous sections are not). Signatories
  are `Person`s linked by `signedBy`/`worksFor`, not `isPartyTo`.
- clinical: one `Condition` individual per patient-condition; suspected/"most likely" diagnoses
  are not labelled. `Medication` is the drug concept; `MedicationOrder` carries the dose. Orders
  continued unchanged at a later encounter are not duplicated.
- manuals: parameters are only the numeric ratings/settings attached to a specific component;
  generic statements (e.g. sensor supply voltage, settling times) are not labelled.

### domain.json
`name`, `description`, `purpose`, `scope`, `stories` (user stories) and `cqs`: approved competency
questions, each with a SPARQL 1.1 `SELECT` that uses only gold T-Box terms, `rdf:type` and
`rdfs:label`, always with a `LIMIT`. Individuals are minted under a different namespace than the
T-Box, so queries match individuals by type, properties and labels, never by IRI.

### questions.json
`[{ "question", "type": "single" | "multi" | "aggregate", "answer": ["..."] }]` - an answer is
correct if it contains ANY of the strings (case-insensitive). Aggregate counts include the digit form.

### evidence.labels.json
`[{ "quote", "doc", "claim", "entailed" }]` - `quote` is copied verbatim from `docs/<doc>.txt`;
about 10 entailed and 5 not-entailed (plausible but unsupported or contradicted) claims per domain.

## Coverage and next steps

This seed has **4 documents per domain**. The evaluation plan targets **10-15 documents per
domain**, so more documents (with matching A-Box labels, questions and evidence labels) still
need to be added, ideally written or at least reviewed by domain experts, and labelled
independently by two annotators to measure agreement.
