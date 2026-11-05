---
title: "Review evidence and duplicates"
description: "Decide which assertions to keep and which individuals refer to the same thing."
---

Review is the step where model output becomes a domain decision. A graph can be syntactically valid and still contain incorrect assertions.

## Inspect a claim

Open **Knowledge graphs → Explore**. The graph canvas is the main view; **Review facts** and **Review duplicates** open their respective review panels. Select an individual to inspect its facts. For each important assertion, check:

1. Is the individual the right thing, with the right class?
2. Does the relationship point in the correct direction?
3. Does the value have the correct units, datatype and meaning?
4. Does the quoted passage support this exact assertion?
5. Is the source sufficiently reliable for your use?

Evidence labels distinguish quotations located in text from unverified, vision-derived or legacy evidence. An entailment score is a model or lexical signal, not a probability that the fact is true.

Choose **Inspect evidence** beside a fact or quotation. The shared inspector opens the highlighted source and keeps **Quote location**, **Claim support**, and **Review decision** separate. Switch supporting sources when a fact has several references. **Model input** shows recorded inputs or explains what was reconstructed, reused, or not recorded; **History** shows the retained source, run, and graph version.

Use **Accept in draft** or **Reject in draft** to update the working copy, and **Undo decision** to reverse the latest inspector decision. Existing editor changes are preserved. **Copy link** retains the selected graph version, source, and tab for another authorized reader. Closing returns to the same workspace position; **Expand reader** gives long passages more room.

## Accept or reject

Use the review controls to accept or reject claims. Project review policy determines what enters the usable graph: all supported policy choices are described in [settings](../reference/settings.md). Rejected facts are excluded from RDF export; accepted-only policy also excludes facts still awaiting review.

The published graph view shows accepted facts. If no accepted entities are available, **Explore proposals** lets you inspect the proposed graph and **Review facts** opens the review queue. Exploring proposals does not accept them or change a saved version.

If a commit would leave candidates out under accepted-only policy, OntoLab asks for explicit acknowledgement. Inspect the omitted material before continuing.

## Resolve duplicates

Review the duplicate/merge candidates in Explore. Similar names, embeddings or grounding identifiers identify candidates; they do not prove identity. Compare source context and properties before merging. Keep separate individuals when they refer to distinct things.

## Validate after editing

Changes to a draft can invalidate an earlier report. Run validation again before committing or exporting a relied-upon result. [Drafts and revisions](../concepts/revisions.md) explains how committed history is protected.
