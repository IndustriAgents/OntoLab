---
title: "Meet OntoLab"
description: "Understand the workspace and choose a path from documents to a reviewed knowledge graph."
---

OntoLab turns documents into a knowledge graph whose assertions can be inspected against their sources. Use it to define a domain, extract individuals and relationships, review evidence, and publish a committed revision.

## What you will work with

A **project** contains the purpose, requirements, ontology modules, documents, runs, revisions and conversations. Your **T-Box** describes the classes and properties. Your **A-Box** contains the particular individuals and their assertions. You can inspect both without writing Turtle by hand.

The application offers three workflows:

| Workflow | Start with | Result |
| --- | --- | --- |
| Build T-Box | Documents and questions | A draft ontology to review and commit |
| Extract A-Box | Parsed documents and a committed ontology | Individuals with evidence, assembled into a draft |
| Align & merge | Ontology modules or standards | Reviewed mappings and a merged draft |

All three end with validation and a deliberate commit. A completed AI run does not automatically make its output trusted knowledge.

The sidebar remembers whether **Ontology** and **Knowledge graphs** are expanded or collapsed independently for each project in your browser. Your choices stay in place when switching pages, opening a graph workspace or refreshing.

## Project settings

Open **Overview** in the project sidebar and find **Project settings**:

- **General:** change the project name, purpose and scope.
- **Requirements:** inspect the summary and open the editor in **Ontology → Build & sources** to describe user stories and approve questions.
- **Quality:** set retrieval and evidence preferences, external references and fact review policy.
- **Connections:** configure publishing to GraphDB when the installation supports it.

Editable sections have their own save actions. Switching sections keeps unfinished edits, and a dot marks sections with unsaved changes. Use **Discard changes** to return to the saved values. Model preferences are copied when a new knowledge graph is created; existing graphs have their own **Graph settings**.

## Choose your starting point

- **Explore first:** follow [Your first knowledge graph](./quickstart.md) using the bundled technical-manual sample.
- **Use your own files:** [create your first project](./first-project.md), describe its purpose, and choose a workflow.
- **Bring a schema:** import an ontology through **Ontology → Build & sources**, or [align and merge](../guides/align-merge.md) multiple modules.

## Hosted app and local installations

Run OntoLab as a desktop app or in a local browser workspace. AI actions use the providers you configure in the app or local server.

Optional services depend on the installation. Check [feature availability](../reference/availability.md) before following an integration guide. For a local installation, start with [local setup](../developers/local-setup.md).

## What review means

A quotation can be located in a source without proving that the model interpreted it correctly. Validation can find structural problems without proving that the graph is complete. Review the evidence and the domain meaning before relying on a result. See [validation](../concepts/validation.md) for the boundaries of each check.
