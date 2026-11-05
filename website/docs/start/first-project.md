---
title: "Create your first project"
description: "Choose a starting point, define the intended questions and build a focused first graph."
---

Start with a small, readable document set and a concrete question. A graph for finding contract renewal obligations needs a different ontology from a graph for describing machine components.

## 1. Choose a starting point

On **Projects**, select **New project**, enter a name and optional purpose, and choose **Create project**. In **Ontology → Build & sources**, choose how to start the ontology:

| Choice | Best when | What to do next |
| --- | --- | --- |
| From documents | You do not have a schema | Add sources and build an ontology |
| From a template | A starter domain fits | Choose a template, inspect its ontology and questions, then upload documents |
| Import an ontology | You have a schema or standard | Import the ontology and validate it before extracting |

Templates include contracts, clinical notes, financial filings, HR, research papers and technical manuals. A template is a starting point; review its suitability for your domain.

## 2. Set purpose and requirements

Under **Overview → Project settings**, state what is in scope and what is outside it. Open **Ontology → Build & sources** to add user stories and competency questions. For a contract project, useful questions might include “Which agreement expires next quarter?” and “Who must give notice before renewal?”

Review generated questions before approving them. These questions guide the schema and give you something concrete to check later. [Learn about requirements](../concepts/requirements.md).

## 3. Add and inspect documents

Upload ontology sources in **Ontology → Build & sources**. Add extraction sources separately in a knowledge graph’s **Documents** page. Check the parser result and chunk text. Begin with one or two documents that have useful examples of the concepts you need.

## 4. Build and populate

If you need a schema, follow [Build T-Box](../guides/build-tbox.md). Review and commit the ontology before following [Extract A-Box](../guides/extract-abox.md).

If the schema already exists, inspect its classes, relationships and datatypes before extraction. Align imported standards only when you have reviewed their intended meanings.

## 5. Keep a usable result

Review evidence and duplicates, validate the draft, commit it and export a backup. Expand the document set after you can answer a few representative questions correctly. A large graph is not automatically a useful or accurate graph.
