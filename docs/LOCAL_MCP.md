# Local MCP and OntoLab AI

OntoLab desktop exposes the same application actions to its AI panel and local
MCP clients. One backend owns each local workspace. MCP starts a small stdio
bridge, which discovers the running backend and forwards authenticated actions;
it never opens workspace files or starts another worker.

## Connect an assistant

1. Open **Settings → AI connections** in OntoLab desktop.
2. Name the connection and choose all projects or one project and its graphs.
3. Optionally grant folders for importing local files.
4. Enable reviewing facts and saving versions only if you want to delegate those
   actions. Otherwise the assistant can read, prepare sources, create separate
   drafts, and start activities; save reviewed versions in OntoLab.
5. Create the connection, copy the Claude Code or Codex command, and run it.
6. Check the client's MCP status, then ask it to list your OntoLab projects.

Keep OntoLab running. The generated command uses the installed app and requires
no separate Node installation. A bridge reconnects after an app restart because
it reads the current loopback address on every request. Revoke connections from
this settings screen. Each credential is stored in a private file in the local
profile's `mcp/` directory; generated client configuration references the file
rather than embedding the credential. Browser cookies and provider keys are
never shared with the bridge.

For development, run `npm run desktop:dev`. `npm run mcp -- --connection
/absolute/path/to/connection.json` is also available for an explicitly created
connection. Hosted deployments do not expose desktop connection management.
Local storage and execution do not imply offline inference: your selected
assistant or OntoLab provider can send model inputs to its provider.

## Two generation paths

**External authoring:** the connected conversation reads sources and submits
ontology modules or batches of proposed facts. This requires no additional
OntoLab generation provider. OntoLab parses and validates drafts, checks quote
locations, preserves source membership and human decisions, and provides review.
Quoted text being found is not proof of semantic support: external facts start
as candidates, including facts whose quotations were located successfully.

**OntoLab pipelines:** inspect a build, graph update, or alignment plan, then start
it. Existing workers, checkpoints, model configuration, budget checks, pause,
retry, and clarification rounds remain authoritative. Disconnecting MCP leaves
started workers running while OntoLab remains open. Quitting stops processing;
saved checkpoints remain available after restart.

## Example external-authoring workflow

- Call `workspace_status`, `list_projects`, and `get_project_context`.
- Create a project if needed; save requirements with their expected version.
- Import documents as text/base64, or use `import_local_file` for a granted folder.
  Inspect parsing status, then call `prepare_documents`.
- Read bounded source chunks and submit ontology modules with
  `submit_ontology_draft`. Existing modules are preserved unless explicitly
  replaced by module ID/name; proposals create separate drafts.
- Compare and validate the draft. Save it in the UI or use an explicitly permitted
  `save_version` call with the exact reviewed content hash.
- Create a knowledge graph pinned to that saved ontology, and import its sources
  using the returned graph's project ID.
- Call `prepare_fact_submission`, then `read_work_package` until all chunks are
  read. Submit each chunk once using `submit_fact_batch`, including an empty
  individuals array for a chunk without facts.
- Finalize the work package. Inspect `list_facts`, review candidates, validate,
  save a version, query the graph, and create a Turtle export.

Each mutation requires a stable `requestId` for retries. A reused request ID with
different arguments is refused. Fact batches also have durable batch IDs. Plans
and work packages detect changed source, ontology and graph inputs. Incomplete
coverage is refused rather than silently presented as complete extraction.
Use `replaceHash` to correct a submitted batch after reading its current hash.
Unfinished work packages are discoverable in project context and in the AI panel.
Interrupted non-recoverable mutations require inspecting current state before
submitting a new request. Model usage outside OntoLab is not reported as free or
counted as an OntoLab model call.

## OntoLab AI

The **OntoLab AI** button opens a contextual panel throughout a project. It uses
the same actions with the selected model, preserves its conversation within the
project as versions change, and returns application-owned result cards. Each turn
uses the currently selected version and refreshes its context. The panel can
inspect sources, propose changes, plan/start pipelines, and answer questions.
Review and immutable version saving remain explicit UI actions. The existing
full assistant page remains available for graph questions and detailed evidence.

Running activities and their clarification questions can be continued in the
panel, independently of which interface started them. External changes trigger
resource refreshes. Unsaved editor buffers are preserved, and conditional draft
writes refuse stale content. Conversations are not imported from Claude/Codex;
handoff consists of shared artifacts, saved activities, source references, and
review decisions.

## Developer boundaries

- `server/actions/`: typed definitions, validation, execution, capability views,
  persistent retry records, external work packages, and shared version saving.
- `server/mcp/`: desktop grants, discovery, stdio transport and profile ownership.
- `src/features/agent/`: contextual panel, result cards and connection setup.
- `server/services/` and existing workers: domain behavior and pipeline execution.

The local and Postgres adapters support atomic revision preconditions. Local MCP runs in the desktop app.

## Verification

`npx vitest run tests/localMcp.test.ts` launches real stdio clients against a
private desktop backend with a temporary workspace. It checks the full external
ontology/graph workflow, evidence handling, scope enforcement, retry identity,
conditional writes, restart discovery, and revocation.

After `npm run desktop:build`, run `npx tsx scripts/local-mcp-smoke.ts` for native
UI and MCP verification. Set `ONTOLAB_DESKTOP_EXECUTABLE` to an installed app's
executable to exercise the packaged application. It uses a disposable profile
and the offline mock provider; screenshots and a report go to
`output/local-mcp-smoke/`. No provider quota is consumed.
