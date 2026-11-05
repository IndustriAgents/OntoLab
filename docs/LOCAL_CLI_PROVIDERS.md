# Local CLI providers

OntoLab can use installed Claude Code, Codex and Antigravity CLIs for ontology generation, extraction, structured model tasks and graph answers. API providers remain available. CLIs execute on the **backend server's computer**, not in a visitor's browser. Cloud-model CLI execution still requires an internet connection and the CLI account's quota.

## Enable and sign in

Install and sign in with the official CLI on the same machine/account that runs OntoLab. OntoLab never extracts or copies login tokens. Its provider list reports **Installed · login unchecked**; a help probe is not evidence of a working login. Authentication and quota errors are surfaced when a request runs. Provider discovery performs no inference.

Local CLIs are available in development. Set `LOCAL_CLI_ENABLED=0` to disable them or `LOCAL_CLI_ENABLED=1` to enable them when running a production build locally.

Choose a local CLI provider in the existing model picker, including the model selection used to prepare chunks. Changing providers after chunk preparation requires reconfiguring those inputs; saved runs retain their recorded settings.

Provider pickers and AI provider settings separate **APIs** from **Local CLIs**. The CLI group is shown only on a loopback host (localhost, a `.localhost` name, `127.x.x.x`, or `::1`) when local CLI execution is enabled. Provider discovery also checks that the backend's peer is local; public/hosted requests receive API providers only. Forwarded host headers do not grant local visibility.

## Models and executables

Claude Code offers `sonnet`, `opus` and `haiku`. Codex and Antigravity offer `Provider default`, which uses the CLI's native model default in the isolated invocation. OntoLab never retries a failure with another provider or model. To advertise explicit models for the installed CLI/account, set a comma-separated server variable:

```dotenv
# Explicit opt-in for a server outside local development:
LOCAL_CLI_ENABLED=1
# Optional model allowlists (only list models your CLI/account supports):
ONTOLAB_CLAUDE_MODELS=sonnet,opus,haiku
# ONTOLAB_CODEX_MODELS=your-model-id
# ONTOLAB_AGY_MODELS=your-model-id
# Optional absolute executable paths; otherwise use absolute PATH entries:
# ONTOLAB_CLAUDE_BIN=/absolute/path/to/claude
# ONTOLAB_CODEX_BIN=/absolute/path/to/codex
# ONTOLAB_AGY_BIN=/absolute/path/to/agy
```

Executable/model variables are server configuration, never accepted from a browser request. Restart the backend after changing them.

## Execution contract

- Prompts go through stdin without a shell. Each call gets a private temporary directory and a fresh context. OntoLab supplies conversation history explicitly; unrelated native conversations are never resumed.
- Native terminal, browser, MCP and delegation tools are disabled. Graph answers use a structured action bridge: OntoLab validates requested tool names and arguments, executes only the existing project-scoped tools, and records queries, passages and evidence as usual. The CLI cannot query arbitrary projects through this bridge.
- Results must complete successfully and match the requested JSON Schema before entering the existing extraction/conformance, evidence-review and revision pipelines. An exit without a completed result, malformed JSON or a mismatched schema is a failure, not a smaller successful extraction.
- One CLI request runs at a time, with a bounded queue, the existing provider timeout, cancellation of the process group, and an output-size limit. Authentication/quota failures are not automatically retried as fresh inference requests.
- Database credentials, API keys and the application's API token are not forwarded to CLI children. Login remains owned by the official CLI.
- Claude Code requires its restricted/tool-control flags. Codex requires its ephemeral, ignore-user-config and structured-output controls. Unsupported installations fail closed rather than dropping controls.
- Antigravity currently requires macOS and the Code Flow isolation profile verified for versions **1.4.4–1.4.7**. It uses a fresh protected home, a finish-only agent and an OS sandbox, with native Keychain authentication. Other versions/platforms require a reviewed profile update. There is no permissive fallback.
- CLI providers currently consume parsed document text. PDF image/vision inputs require a vision-capable API provider.

## Tokens and costs

New CLI token configurations start with a 131,072-token request budget, 2,000-token chunks and a 4,096-token output reserve. Existing saved input configurations are unchanged.

CLI request checks use a conservative local estimate plus an 8,192-token allowance for native context. No Gemini/Claude token-counting API is called for CLI providers. The CLI may add context, compact it, or choose its own output limit; the reserve is a planning allowance, not a native hard limit. These settings cannot guarantee that the account/model accepts every request.

Usage is taken from the CLI when reported. API-family dollar prices are not applied to CLI runs, and unknown cost is not reported as free. Account quotas and subscription/provider charges remain separate from OntoLab's estimated USD budgets. An operator can supply explicit `PRICING_JSON` overrides if they want accounting estimates for their own setup.

## Validation

`npx vitest run tests/cliProviders.test.ts` exercises real fixture subprocesses for schema enforcement, stdin, isolated arguments/environment, cancellation, failures, token checks and the graph tool bridge. These fixtures do not call a provider or consume inference quota. A live account smoke test is a separate check.

To test the real Codex login and graph assistant end to end:

```bash
LOCAL_CLI_ENABLED=1 npx tsx scripts/codex-graph-smoke.ts --live
```

This opt-in check uses the installed Codex CLI and its account quota. It creates an isolated temporary app and synthetic graph, checks SPARQL answers, query citations, evidence, conversation follow-ups, document search and source citations, and verifies the committed graph remains unchanged. It cleans up the temporary data when finished. Add `--report /absolute/path/report.json` to save the results. For browser checks, build the app first with `npm run build` and add `--serve`; the script prints its local Assistant URL and waits until Ctrl+C before cleaning up.
