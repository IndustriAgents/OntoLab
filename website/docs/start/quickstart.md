---
title: "Your first knowledge graph"
description: "Explore the bundled sample, extract individuals, review their evidence and export a revision."
---

Use the bundled distributing-station manual to learn the full workflow. The sample starts with an ontology committed as revision 1 and a parsed text document. **It does not start with extracted individuals.**

## Before you begin

Open the desktop app or follow [local setup](../developers/local-setup.md) to start OntoLab in your browser. You need an enabled model for extraction and graph chat. Inspecting the ontology and source text does not make an extraction call.

:::tip Prefer an offline walkthrough?
A developer can run the same sample locally with the mock model. Follow [local setup](../developers/local-setup.md). Mock results demonstrate the workflow, not model accuracy.
:::

## 1. Open the sample

On **Projects**, choose **Open the sample project**. If you already have projects, use the same sample action in the page header. The new project is named **Sample — Technical manual (distributing station)**.

Open **Ontology → Terms & relations** to inspect the classes and properties. Open **Ontology → Build & sources** to inspect `distributing-manual.txt`. The source describes components, sensors, actuators and operation sequences.

You can also download the [synthetic sample source text](pathname:///distributing-manual.txt) and [sample T-Box](pathname:///mechatronic-tbox.ttl). Both files are in `samples/` in the repository.

The sample starts with one document, seven committed classes and no extracted individuals.

## 2. Inspect the inputs

Open **Knowledge graphs** in the project sidebar and choose **New knowledge graph**. Enter a graph name, choose the saved sample ontology and an enabled extraction model under **Processing settings**, then choose **Create knowledge graph**. Upload the [sample source text](pathname:///distributing-manual.txt) to the corpus; ontology-building sources are not included automatically.

Parsing and chunk preparation start automatically. In **Documents**, inspect the original, parsed text and chunks before extraction. Read a passage and check the chunk boundaries. Overlap means that neighboring chunks may repeat part of the text.

## 3. Run extraction

On **Documents**, check the ready-document summary and cost estimate, then choose **Create knowledge graph**. Model and token-budget settings are available under **Graph settings** in the sidebar. Keep the project open while the hosted app advances it. **View update progress** shows the current stage and lets you resume unfinished work.

Wait for **ready for review**. If it fails, keep the existing run and use [run troubleshooting](../help/troubleshooting.md) rather than repeatedly creating new runs.

## 4. Review the draft

Open **Review changes**. The list shows changes grouped by entity. Select a fact and inspect its source quotations, then accept or reject it. Confirm whether the quotation supports the meaning of the claim, not only its words. Supported changes can be accepted together; review conflicts and duplicate candidates individually. Only accepted facts enter graph answers and exports.

The number and names of extracted individuals depend on the model and settings; there is no required count for this tutorial.

## 5. Validate and commit

Inspect **Validation and schema findings**, then choose **Save knowledge graph**. Review structural issues, SHACL findings and logical checks, and correct blocking errors. If OntoLab asks you to confirm introduced warnings, inspect them before saving. Use **Knowledge graph** to explore the accepted result. See [review and validation](../concepts/validation.md).

After saving, a new numbered version becomes the corpus’s current graph. The saved content is immutable.

To add knowledge later, return to **Documents** and upload more files, or choose **Replace document** on an existing source. **Update knowledge graph** processes the changed sources. Review the differences and **Save graph update**; existing entities, review decisions and earlier graph versions remain available.

## 6. Ask and export

Open **Knowledge graphs → Explore**, choose **Ask**, and ask **“Which sensors does the distributing station have?”** Choose the saved graph version. Inspect any cited query and source passage; an incomplete extraction can produce an incomplete answer.

From **Explore**, choose **Export graph**, select **Ontology + individuals** and download Turtle. Use **Download archive** on the export page for a portable graph workspace backup.

## You have finished when

You can identify the source document, inspect one assertion’s evidence, distinguish the draft from a committed revision, and export the selected graph. Continue with [your own project](./first-project.md) or [manual editing](../guides/manual-editing.md).
