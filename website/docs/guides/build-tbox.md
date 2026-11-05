---
title: "Build T-Box"
description: "Build and review an ontology from documents and approved questions."
---

Use **Build T-Box** when your documents contain domain knowledge but you do not have a suitable ontology. The result is a proposed schema, not extracted instances.

## Before you start

Create a project, set its purpose and scope, and [review its competency questions](../concepts/requirements.md). Upload readable documents. An enabled model is required for generation; review the estimate before starting.

Choose the working ontology in the sidebar’s **Selected ontology** picker. It lists saved versions and drafts, remembers your choice, and carries it through the ontology tools. In **Build & sources**, use **Continue selected ontology** to resume a draft, edit a saved version as a new draft, or improve it with documents. To begin separately, use one of the three **Start a new ontology** options. Switching the selected ontology does not change an existing knowledge graph’s pinned version.

## Follow the workflow

1. **Requirements:** edit and approve the project’s stories and questions. Saving changes creates a version; use **Version history** to compare or restore earlier requirements. New builds keep the saved requirements version, purpose and scope they start with, including after interruption or retry.
2. **Documents:** select the documents that represent the domain. Avoid selecting both an original and a chunking variant unless you intend to compare them.
3. **Parsed text:** check the extracted reading order, sections and tables. Fix or replace a source whose text is missing.
4. **Chunks:** inspect boundaries and overlap. A chunk should preserve enough context to explain its terms.
5. **Generate:** choose the model and review generation parameters. Start the induction run.
6. **Inspect results:** examine classes, consolidation, relations, optional axioms, reuse suggestions and pitfall findings. Expand **Method, parameters & research details** to inspect recorded evidence.
7. **Validate & commit:** review the draft schema, resolve blocking issues and commit it.

When preparing from a completed build, unchanged recorded inputs and generation settings disable the build button with **No configuration changes**. Choose **Inspect existing results** to reuse that build. Changing the sources, chunk settings, model, reasoning effort, research parameters or guiding requirements allows another build. Selecting the previous result as the starting ontology is also a change: it starts a further improvement pass. Older builds without recorded inputs remain buildable.

## Review the proposed vocabulary

Ask whether each class has a useful domain meaning, each property has the correct direction and datatype, and the schema can express the approved questions. Reused terms and generated axioms need human review. Similar labels alone do not establish equivalence.

Use **Ontology → Terms & relations** for specialist editing. A model may suggest terms outside your scope; remove or refine these before committing.

## Expected result

A numbered committed revision contains ontology modules. Continue with [Extract A-Box](./extract-abox.md) to populate it with individuals.

## If the result is weak

Check the purpose and selected source passages before increasing the document count. Inspect whether topic groups and sampled passages cover the domain. A completed run can still produce an unsuitable ontology. Use [experiment inspection](../research/experiments.md) to understand what the run actually used.

## Follow the evidence graph

In **Inspect results**, open the evidence explorer's **Graph** view. Select a class or property to highlight its recorded topic, chunks and source quotes. Use the selected path for focused inspection or the overview for context. Passages included in a generation call are distinguished from model-cited quotes. Missing recorded links remain visible as missing evidence.

After saving the ontology, open **Knowledge graphs** and choose **New knowledge graph** to create a workspace pinned to a saved ontology version. The ontology-building sources are not automatically added to that corpus.
