# OntoLab starter templates

Each subdirectory is a starter template for a new OntoLab project. A template gives a project a purpose, a scope, user stories, competency questions (CQs) and a compact T-Box to extract an A-Box against.

| id | Domain | T-Box |
|---|---|---|
| `contracts` | Agreements, parties, clauses, obligations, payment, term, termination, governing law | `contracts/tbox.ttl` |
| `clinical-notes` | Pseudonymised patients, encounters, conditions, medications, procedures, observations, allergies | `clinical-notes/tbox.ttl` |
| `financial-filings` | Companies, filings, periods, statements, line items, values, segments, auditors, risks | `financial-filings/tbox.ttl` |
| `hr` | Workers, positions, units, contracts, compensation, leave, reviews, skills, locations | `hr/tbox.ttl` |
| `research-papers` | Papers, authors, venues, datasets, methods, tasks, metrics, results, citations, funding | `research-papers/tbox.ttl` |
| `technical-manuals` | Stations, components, signals, operation sequences | `../mechatronic-tbox.ttl` (shared sample) |

## Layout

```
samples/templates/<id>/
  template.json   # metadata (required)
  tbox.ttl        # T-Box in Turtle (unless tboxFile points elsewhere)
```

### `template.json`

```json
{
  "id": "contracts",
  "name": "Contracts",
  "description": "One sentence shown on the template card.",
  "purpose": "What a project built from this template is for (1-2 sentences).",
  "scope": "What is in and out of scope (1-2 sentences).",
  "stories": ["As a <role> I want <capability> so that <benefit>."],
  "cqs": ["Which parties are bound by each agreement?"],
  "tboxFile": "tbox.ttl"
}
```

- `id` must match the directory name.
- `tboxFile` is resolved relative to the template directory.
- Write 2-3 user stories and 6-10 CQs, and make sure the T-Box can answer every CQ.

### `tbox.ttl` conventions

- Namespace `https://w3id.org/ontolab/templates/<id>#` bound to `:`, with an `owl:Ontology` header that has `rdfs:label` and `rdfs:comment`.
- Keep it compact: about 12-25 classes, 6-14 object properties and 6-14 datatype properties.
- Every class and property has an English `rdfs:label` and a one-sentence `rdfs:comment`. The comments are embedded for schema retrieval, so make each one specific enough to tell it apart from its siblings.
- Every property has `rdfs:domain` and `rdfs:range`. Datatype properties use `xsd:` ranges.
- Use `rdfs:subClassOf` for the hierarchy, `owl:disjointWith` for siblings that are clearly disjoint, and `owl:FunctionalProperty` for properties a subject has only one value for.
- Point to well-known standard terms (schema.org, FIBO, FHIR, FOAF, Dublin Core, BIBO and so on) with `rdfs:seeAlso`, but do not import them.
- Use only `owl:Class`, `owl:ObjectProperty`, `owl:DatatypeProperty`, `rdfs:subClassOf`, `owl:disjointWith`, `owl:FunctionalProperty`, `rdfs:label`, `rdfs:comment` and `rdfs:seeAlso`. Do not use restrictions or blank nodes.

## Adding a template

1. Create `samples/templates/<id>/` and add `template.json` and `tbox.ttl` following the conventions above.
2. Check that the Turtle parses:
   `node -e "const N3=require('n3');console.log(new N3.Parser().parse(require('fs').readFileSync('samples/templates/<id>/tbox.ttl','utf8')).length)"`
3. Check that every class or property used in a domain, range, `subClassOf` or `disjointWith` is declared in the same file, and that `tboxFile` resolves.
4. Add a row to the table above.
