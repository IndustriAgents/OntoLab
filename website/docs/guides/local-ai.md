---
title: OntoLab AI and local assistants
description: Work in OntoLab AI or connect Claude Code and Codex to the same local projects.
---

Open **OntoLab AI** from the bottom of the project sidebar to work with your sources, ontology
and knowledge graphs. The panel shows its current project and selected version.
Ask it to inspect your sources, prepare an ontology draft, explain validation
findings or check an activity. Changes become separate drafts for your review.

The panel uses your selected AI provider. Use the model picker in the message box to change it. The
existing Ask workspace remains available for detailed graph questions and evidence.

## Connect Claude Code or Codex

Local MCP connections are available in the desktop app.

1. Open **Settings → AI connections**.
2. Name the connection and choose its project access.
3. Optionally grant folders for importing local files.
4. Choose whether the connection may review facts and save versions. Otherwise,
   assistants prepare drafts and you save reviewed versions inside OntoLab.
5. Select **Create connection**, copy the command for your client and run it.
6. Check the client's MCP status, then ask it to list your OntoLab projects.

Keep OntoLab running while connected. The installed app provides the local
bridge; you do not need Node or Docker. Connections recover after an app restart.
Use **Revoke** in settings to stop a connection's access.

For another MCP client, expand **Configuration for another MCP client** and use
the generated command and arguments. The configuration references a private
credential file; it does not embed your browser session or provider keys.

## Choose how work is generated

**Use your external assistant:** Claude or Codex reads selected sources and
submits proposed ontology modules or facts. You do not need a second generation
provider configured in OntoLab. Fact drafts retain source references; located
quotes are labelled separately from human acceptance.

**Run an OntoLab pipeline:** your assistant starts the existing build or
extraction process with OntoLab's configured provider. Inspect the plan first.
Workers preserve checkpoints, progress, budget limits and review drafts.

Local storage does not mean offline inference. Your chosen assistant or provider
can send selected document content to its model service.

## Continue a task

Work started externally appears in the same project. Open its draft or activity
in OntoLab to inspect sources, review changes or continue processing. Activities
waiting for clarification can be answered in the AI panel. Paused or failed
activities retain their completed work.

A handoff shares saved project state and artifacts. It does not copy a Claude or
Codex conversation into OntoLab. OntoLab AI keeps its conversation within each
project as you select drafts and saved versions. Each request uses the selected
version's current context. Choose **New conversation** whenever you want a fresh
start.

Draft saving preserves working content. **Save version** creates a reviewed,
immutable version. **Publish** sends a saved version to an external database.
