---
title: "Export and back up a project"
description: "Download a selected graph, validation report or portable project archive."
---

Open **Ontology → Terms & relations** and choose **Export ontology**, or open a knowledge graph’s **Explore** page and choose **Export graph**, to move reviewed knowledge to other tools or keep a workspace backup. Check the selected revision before downloading.

## Export RDF

Choose **Ontology + individuals**, **Individuals only (A-Box)**, or **Ontology only (T-Box)**, then **Download .ttl**. The interface identifies a selected draft; choose the committed revision when you need a reviewed release.

For exports containing individuals, choose the provenance level:

| Choice | Included information |
| --- | --- |
| Source notes | Quoted source notes on individuals |
| Full provenance (PROV-O) | Claim statements with recorded evidence, offsets, run and review information |
| Facts only | Assertions without provenance annotations |

Rejected facts are excluded. Accepted-only policy also excludes facts still awaiting review. If OntoLab asks you to acknowledge validation or review findings before export, inspect them first.

## Export validation

Run validation for the selected revision, then download the report as Markdown or JSON. A report marked stale belongs to different content and should be rerun.

## Download a backup

In **Workspace archive**, choose **Download archive**. A project archive includes its documents, revisions, assistant conversations and separate graph workspaces; a graph workspace archive includes that graph and its ontology package. Import it from the Projects screen to restore a separate project. Keep the file somewhere appropriate for the sensitivity of its documents.

:::important Research records are separate
The ordinary project archive does **not** preserve run history. Use **Export research record** for recorded run snapshots and checkpoints. Keep both exports if you need project restoration and historical experiment inspection.
:::

Document variants retain their chunk settings and ancestry in archives; originals are reparsed on import. A project archive is not a promise of byte-for-byte reproduction of every model run.

## Use the graph elsewhere

Turtle can be opened in RDF tools such as Protégé or GraphDB. Treat external imports as a separate validation step: supported ontology constructs and inference behavior differ between tools.
