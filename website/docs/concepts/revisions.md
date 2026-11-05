---
title: "Drafts, revisions and commits"
description: "Understand what is editable and how reviewed history is preserved."
---

Changes follow **draft → validate → commit**. This applies to generated output, imported ontologies and manual edits.

## Drafts are editable

A run or editing action creates proposed content. Inspect the selected revision before modifying or exporting it. Selecting an older revision is an inspection choice; it does not automatically make it current.

## Commits are immutable

A commit gives a draft a revision number and makes it the project’s current revision. Committed content cannot be changed in place. The next edit starts a new draft. T-Box and A-Box version counters distinguish which part changed.

## Validation belongs to content

Reports are tied to a revision content hash. A draft edit can make a previous report stale. Run validation again before relying on a changed revision.

Introduced errors block a manual change. Introduced warnings require confirmation. Review-policy omissions can require an additional acknowledgement. Confirmation is not a claim that the result is correct.

## Concurrent changes

Two drafts can share the same parent. If one is committed first, committing the other returns a stale-parent conflict. Inspect the new current revision and reconcile your draft; do not repeatedly click commit expecting the conflict to disappear.

Rebasing a draft changes its parent to the current revision while retaining the draft’s content. Review what would be lost or replaced before doing so. Restoring historical content creates a new revision rather than erasing the committed history.

Export [project archives](../guides/export.md) for portable backups, and keep research records separately when historical runs matter.
