---
title: "Knowledge graphs and ontologies"
description: "Understand the schema, individuals and evidence in an OntoLab project."
---

A knowledge graph represents things and their relationships. An ontology supplies the vocabulary and supported rules for expressing them.

## Schema and instances

Consider a technical manual. The schema says that a **Sensor** is a kind of **Component**, and that **partOf** links a Component to a Station. The instance graph says that a particular sensor belongs to a particular station.

```turtle
@prefix ex: <https://example.org/plant/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

ex:Sensor a owl:Class ; rdfs:subClassOf ex:Component .
ex:Component a owl:Class .
ex:Station a owl:Class .
ex:partOf a owl:ObjectProperty ;
  rdfs:domain ex:Component ; rdfs:range ex:Station .
ex:sensor17 a ex:Sensor ; ex:partOf ex:station2 .
ex:station2 a ex:Station .
```

The class/property definitions are the **T-Box**. The sensor and station assertions are the **A-Box**. The IRIs identify terms independently of their displayed labels.

## Sources make assertions inspectable

A quotation such as “Sensor 17 is mounted on station 2” can support an assertion. OntoLab retains evidence locations and review state so you can inspect that interpretation. A source’s existence does not make every extracted statement correct.

## Questions give the graph a purpose

“Which sensors belong to station 2?” is a competency question. It helps determine whether the schema contains a useful relationship and whether extraction has populated it.

Start with a small, focused schema. Add terms when they help express the project’s purpose, rather than trying to model every noun in every document. Continue with [requirements](./requirements.md) or the [sample tutorial](../start/quickstart.md).
