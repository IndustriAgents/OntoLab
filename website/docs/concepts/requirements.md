---
title: "Requirements and competency questions"
description: "Define the questions your graph should be able to answer."
---

A graph is easier to review when its intended use is explicit. OntoLab stores purpose, scope, user stories and competency questions with the project.

## Write useful requirements

A purpose describes the outcome: “Find maintenance-relevant components and their part numbers.” Scope describes the boundary: “The distributing station in these manuals; not electrical wire-level schematics.”

A user story connects a person to a need. For example: “As a maintenance planner, I want the part number of each actuator so I can order a replacement.”

## Review competency questions

In **Ontology → Build & sources**, add or generate questions and review them before approval. **Overview → Project settings → Requirements** shows a summary. Good questions are specific enough to evaluate:

- Which actuators belong to each station?
- What is the manufacturer part number of each actuator?
- Which operation precedes the gripping step?

“Describe everything about the plant” is too broad to test whether the ontology meets a defined need.

## Use SPARQL checks

Approved questions can be translated to SPARQL. Review the generated query: a syntactically valid query can still ask the wrong question. Stored queries can be evaluated against revisions, making it easier to identify regressions.

A returned row or a passing query is evidence of answerability under that query. It is not proof that the answer is complete or correct against the original documents. [Evaluation](../research/evaluation.md) explains how accuracy differs from answerability.

## Revise deliberately

Requirements can evolve. A historical run retains its recorded requirements when available; changing today’s requirements does not retroactively change what a past run used.
