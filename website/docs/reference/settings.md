---
title: "Models, budgets and quality settings"
description: "Understand project-level choices and the defaults controlled by the server."
---

Open **Overview → Project settings** to inspect project purpose, scope, requirements and available cost/quality options. Provider keys are server configuration, not values to enter in documents or prompts.

## Model and budget

Select an enabled provider/model. Estimates are approximate and depend on configured pricing and the actual calls made. Configured per-run and total spending limits are enforced; if a run reaches a limit, its recovery panel can adjust those limits before continuing. Inspect run records for recorded token counts and timing; they are not a complete provider invoice.

## Review policy

| Policy value | Effect |
| --- | --- |
| `all` | Broad inclusion; review findings remain visible |
| `exclude-rejected` | Exclude rejected facts from the usable graph |
| `accepted-only` | Include accepted facts; waiting candidates are omitted |

Rejected facts are never included in the RDF export. Accepted-only commits may ask you to acknowledge facts that will be left out.

## Retrieval and evidence

Embedding choices include local, provider, deterministic lexical/hash and off. NLI/entailment choices include local, provider, lexical and off. Defaults come from the server; project overrides and run parameters affect individual operations.

Use the recorded backend and scores when comparing runs. A cosine similarity or entailment score is not a calibrated probability of correctness.

## Research parameters

Run setup can expose prompt rendering, schema retrieval/top-k, competency guidance, axiom induction, repair and strict grounding. Chunk experiments have their own strategy, size and overlap. Change one parameter at a time for an interpretable comparison.

Changing settings does not rewrite historical measurements. Read [experiment inspection](../research/experiments.md) before comparing a new run with an old one.

### Extraction execution

Under **Settings → AI providers**, save execution limits without restarting:

- **Parallel CLI workers:** 1–16 simultaneous CLI requests. Independent extraction chunks use the selected model; dependent stages remain sequential. The limit is shared across CLI providers in the server process.
- **Request timeout:** 1–3,600 seconds per model request, including time waiting for a CLI worker. Applies to API and CLI models.
- **Maximum step attempts:** 1–20 attempts for retryable extraction failures, including the initial attempt. Non-retryable failures still stop immediately.

Settings are saved in the workspace data directory and loaded at startup. Environment variables `LLM_TIMEOUT_MS` and `MAX_STEP_ATTEMPTS` supply defaults until settings are saved. Changes apply to subsequent extraction steps and requests; an active step retains its original timeout and retry settings. More workers consume more account capacity, and provider or proxy limits still apply.
