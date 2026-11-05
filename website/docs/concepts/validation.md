---
title: "Understand validation"
description: "Read structural, SHACL, logical and competency-query results separately."
---

Validation supplies several different checks. A green result means the implemented checks passed for the selected content; it does not establish real-world correctness or completeness.

## Structural validation

The hand validator checks identifiers, known classes/properties, relationship targets and supported datatype/domain/range constraints. It can find duplicate identifiers, dangling targets and conflicting class membership.

## SHACL

OntoLab generates shapes from supported ontology constructs and validates the data graph. Expand SHACL details to inspect the shapes, validated graph and raw results. Ancestor types are materialized for the supported subclass behavior.

An empty data graph, a failed execution and a conforming populated graph are different outcomes. Check which one the report describes.

## Logical consistency

The built-in reasoner implements an OWL 2 RL subset. Unsupported constructs are reported. The optional DL sidecar uses HermiT/ELK for additional reasoning capabilities. An unavailable sidecar is not a clean logical-consistency result.

## Competency questions

Stored SPARQL queries check whether the graph can answer approved questions. A positive answer rate is not a precision/recall score. It can conceal missing or incorrect real-world facts.

## Act on findings

1. Confirm that the report belongs to the selected revision and is not stale.
2. Inspect blocking errors and their affected terms or individuals.
3. Review introduced warnings before confirming a commit.
4. Inspect the source evidence for domain correctness, even when structural checks pass.

See [validation messages](../reference/validation-messages.md) for common findings and [manual editing](../guides/manual-editing.md) for correcting a draft.
