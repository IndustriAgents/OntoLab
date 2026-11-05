---
title: "Troubleshooting"
description: "Recover from common parsing, run, validation and access problems."
---

Start with the message shown in the app. Keep the project, run and selected revision identified when reporting a problem. Do not include provider keys or confidential source text in a public issue.

## I cannot see my projects

Check which workspace you opened. Desktop uses its own profile. The local browser app uses `.data` by default or the store you configured with `STORE_MODE` and `DATABASE_URL`. See [local setup](../developers/local-setup.md).

## The sample button is missing

On the Projects page, look for **Open the sample project** in the empty state or page header. If it is unavailable, check the deployed version or start a project with the downloadable sample files.

## A PDF has no useful parsed text

Check whether it contains selectable text. Scanned pages require OCR; the baseline hosted parser does not enable Docling. See [formats](../reference/formats.md). Changing the model does not repair empty parser output.

## A run appears stalled

Open **Activity** and inspect the status. Browser-driven runs need an open tab. Resume the existing run when offered. A call may still hold a lease after an interruption; let it complete or expire before retrying. Cancel an active run before starting another.

## No model is available

Only enabled providers appear as usable choices. In desktop mode, check **Account & workspace → Model connections** and your local provider configuration. On a hosted installation, ask the operator to configure a provider; local mock mode can demonstrate the workflow. The docs site itself does not provision keys.

## Output is missing facts or chunks

Inspect selected documents/variants, parser output, relevance-screen skips, schema retrieval and cache labels. Check that the necessary class/property exists. Review the run’s actual inputs rather than today’s edited documents.

## A commit asks for confirmation or fails

A **428** requests confirmation of introduced warnings. A **422** reports blocking changes; acknowledgement cannot bypass them. A **409** may indicate a stale parent or review-policy acknowledgement. See [validation messages](../reference/validation-messages.md).

## An answer or graph seems wrong

Confirm the selected revision and review policy. Inspect citations, queries and rows; a result can be correct for an incomplete graph. Correct the graph’s evidence or schema before relying on another answer.

## An export is incomplete

Check its scope, selected revision, review policy and provenance choice. Project archives do not contain run history; export the research record separately. See [export and backups](../guides/export.md).
