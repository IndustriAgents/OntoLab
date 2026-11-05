---
title: "Edit an ontology or graph"
description: "Make a focused manual change, check its impact and commit a new revision."
---

Manual editing lets you correct knowledge without another extraction call. Changes belong to a draft; committed content is immutable.

## Edit the schema

Open **Ontology → Terms & relations**. Use the class/property editor or module editor to change the draft. Keep IRIs stable when the meaning is unchanged; changing an identifier can affect individuals and queries that refer to it.

When a schema change renames or removes terms, OntoLab attempts supported A-Box migration and flags affected individuals. Inspect the migration findings rather than assuming every usage has been repaired.

## Edit assertions

In **Knowledge graph**, inspect an individual and edit its facts through the available graph/table inspector controls. You can also import A-Box data. Check class membership, relationship targets, datatypes and identifiers.

Manual edits retain an edit log on the draft. Editing existing assertions does not create new documentary evidence for them.

## Check the change

Run the change check and validation. Introduced blocking errors cannot be bypassed by acknowledging warnings. Introduced warnings require confirmation. Pre-existing findings are distinguished from problems introduced by the current change.

Examples of blocking problems include a link to an individual you deleted or a disjoint-class contradiction detected by the supported reasoner.

## Commit

Commit after reviewing the change. If another draft was committed first, your draft may be stale. Inspect the current revision and reconcile the edits before rebasing or replacing its content.

A committed revision cannot be edited in place. Start a new draft for the next change. See [revisions](../concepts/revisions.md) and [validation messages](../reference/validation-messages.md).
