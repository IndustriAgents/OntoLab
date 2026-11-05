---
title: "Glossary"
description: "A plain-language reference to OntoLab terminology."
---

| Term | Meaning in OntoLab |
| --- | --- |
| Ontology / T-Box | Classes, properties and supported logical rules describing a domain |
| A-Box | Named individuals and assertions about them |
| Individual | A particular thing, such as a specific sensor or contract |
| Class | A category, such as Sensor or Contract |
| Object property | A relationship between individuals, such as partOf |
| Data property | A value attached to an individual, such as a part number |
| IRI | The identifier of a class, property or individual in RDF |
| Turtle | A readable syntax for RDF graphs, usually saved as `.ttl` |
| Competency question | A question the graph should be able to answer |
| Chunk | A bounded portion of parsed text processed during a run |
| Evidence | A quotation, source location and associated review information supporting a claim |
| Grounding | A proposed link between an entity and an external identifier |
| Entity resolution | Finding and reviewing individuals that may refer to the same thing |
| Draft | Editable proposed revision content |
| Commit | Make a validated draft an immutable numbered revision |
| Revision | A saved state of the ontology and graph content |
| Run | A checkpointed induction or extraction operation |
| SHACL | A constraint language used to check the data graph |
| SPARQL | A query language used to ask questions of RDF data |
| Reasoner | A component that derives consequences or detects supported logical inconsistencies |
| Alignment | Reviewed correspondences between terms in ontology modules |

## Start with an example

A T-Box can say **Sensor is a kind of Component** and **partOf relates a Component to a Station**. An A-Box can say **sensor-17 is a Sensor** and **sensor-17 partOf station-2**. The source quotation explains why someone believes the latter assertion.

The first two statements describe the vocabulary; the latter two describe particular things. Read [knowledge graphs and ontologies](../concepts/knowledge-graphs.md) for a worked example.
