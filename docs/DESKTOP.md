# OntoLab desktop

OntoLab desktop uses Electron to run the existing React interface and a separate
Node utility process on the laptop. Projects, uploads, run checkpoints and model
caches stay in the app's local workspace. End users do not need Node, Docker or
Postgres installed.

## Develop and package

Development requires Node 22.22+ and npm:

```bash
npm ci
npm --prefix website ci
npm run desktop:dev
```

`desktop:dev` builds the UI and desktop entry points, then opens the native app.
Run it again after source changes. `npm run desktop:build` only builds;
`npm run desktop:pack` produces an unpacked app in `release/`, and
`npm run desktop:dist` builds the current platform's installer. Build and verify
each target on its own operating system. Distribution signing, notarization and
automatic updates still need release credentials and configuration.

`npm run desktop:test` runs a native smoke test with a disposable local profile
and the offline mock provider. It verifies project persistence across a restart,
the CLI picker, renderer isolation and backend shutdown, and saves a screenshot
under `output/desktop-smoke/`. To test a packaged app, set
`ONTOLAB_DESKTOP_EXECUTABLE` to its executable path before running this command.

## Install the macOS preview

The desktop preview supports **Apple silicon (arm64), macOS 13 or later**.
Download the DMG and `SHA256SUMS.txt` from the GitHub release, then verify the
download from the directory containing both files:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Open the DMG, drag **OntoLab** into **Applications**, and eject the disk image.
The preview is ad-hoc signed, without an Apple Developer ID or notarization.
macOS may block its first launch. After attempting to open it, use
**System Settings → Privacy & Security → Open Anyway** if you trust this release,
following [Apple's instructions](https://support.apple.com/en-us/102445).

The repository is private, so release downloads require repository access.
Intel Mac, Windows and Linux installers are not included in this preview.

Maintainers can reproduce this preview after installing both root and website dependencies with `npm run desktop:dmg:preview`. This command builds the Apple silicon DMG with an
ad-hoc signature and never publishes automatically. Normal `desktop:dist`
packaging still discovers configured Developer ID credentials.

Run `npm run desktop:verify:dmg -- release/OntoLab-0.1.0-desktop.5-arm64.dmg`
to verify the image, copy its app into a temporary installation, validate the
signature and run the native smoke test against that installed copy. The image
is then unmounted and the temporary installation is removed.

## Local data and configuration

Development uses an **OntoLab Development** profile; the packaged app uses
**OntoLab**. On macOS these are under `~/Library/Application Support/`. Use
**File → Open local data folder** to find the profile on any platform.

The profile contains `workspace/` (persistent data and model cache), `desktop.log`,
and an optional `desktop.env` file for provider configuration. The desktop app
does not load the repository's `.env`, and it always selects local storage. Database URLs, API tokens and base paths do not override these desktop defaults. Developer environment variables still take
precedence over entries in `desktop.env`.

For isolated development or smoke tests, set `ONTOLAB_DESKTOP_PROFILE` to an
absolute directory path before starting the app.

## LLM generation

The existing provider picker supports three approaches:

- **Local CLIs:** Claude Code, Codex and supported Antigravity versions. Install
  and sign in to the CLI separately on the laptop. Desktop mode enables local
  CLI discovery and retains the existing compatibility, isolation, cancellation
  and output-validation rules. These CLIs can call cloud models; local execution
  does not imply offline inference. See [Local CLI providers](LOCAL_CLI_PROVIDERS.md).
- **Ollama:** run Ollama locally and configure `OLLAMA_BASE_URL` and
  `OLLAMA_MODELS` in `desktop.env`.
- **OpenAI-compatible endpoints:** add them in **Settings → AI providers → Add
  endpoint** (base URL, optional API key, models). Keys are encrypted in the
  profile's `workspace/` directory. `OPENAI_COMPAT_BASE_URL`,
  `OPENAI_COMPAT_API_KEY` and `OPENAI_COMPAT_MODELS` in `desktop.env` configure
  one endpoint without the UI.
- **API providers:** configure the existing provider keys in `desktop.env`.
  These calls send model inputs to the selected provider.

For example:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODELS=llama3.1,qwen2.5
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
```

Restart the app after configuration changes. Keep this file private; credentials
are consumed by the backend and never sent to the renderer. `LOCAL_CLI_ENABLED=0`
disables CLI execution. If a GUI launch cannot find a CLI installed outside the
usual PATH locations, set its existing `ONTOLAB_CODEX_BIN`, `ONTOLAB_CLAUDE_BIN` or
`ONTOLAB_AGY_BIN` override to the absolute executable path in `desktop.env`.

Embeddings and entailment keep the existing local defaults and download their
models on first use. The optional Docling and DL reasoner services remain
separately configured through `PARSER_URL` and `REASONER_URL`.

## Bundled help

Install documentation dependencies with `npm --prefix website ci` before building desktop releases. The build includes articles, images, sample downloads and search files from `website/` in the app package. Both the account menu and native Help menu open local help at `/docs/` inside the app; Back to workspace returns to the previous page. Reading and searching help works without an internet connection or another server.

## Runtime boundaries

The backend listens on a random IPv4 loopback port. An in-memory, HttpOnly session
cookie known only to the app protects both the UI and API; Host and Origin checks
reject cross-site requests. The renderer is sandboxed with Node integration
disabled and context isolation enabled. External web links open in the system
browser. The local background workers run while the app is open, and quit asks
the backend to shut down before exiting. Saved checkpoints survive restarts.
