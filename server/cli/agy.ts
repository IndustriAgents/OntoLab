import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProviderError } from "../providerErrors.ts";
import { agyVersionSupported } from "./catalog.ts";

const exec = promisify(execFile);

/** The file-only Code Flow profile narrowed to a single structured finish tool. */
export async function prepareAgy(root: string, binary: string, schemaFile: string, model: string) {
  if (process.platform !== "darwin") throw new ProviderError("Isolated Antigravity execution requires macOS.", 503, false);
  const version = await exec(binary, ["--version"], { timeout: 5000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin" } });
  if (!agyVersionSupported(version.stdout))
    throw new ProviderError(
      "Antigravity CLI needs a verified 1.4.4–1.4.7 isolation profile. Use Claude Code or Codex until this version is supported.",
      503,
      false,
    );
  const home = join(root, "home"),
    scratch = join(root, "scratch");
  const keychains = await realpath(join(homedir(), "Library", "Keychains"));
  const cache = await exec("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], {
    timeout: 5000,
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin" },
  });
  const securityCache = await realpath(join(cache.stdout.trim(), "mds"));
  const cli = join(home, ".gemini", "antigravity-cli"),
    config = join(home, ".gemini", "config");
  for (const path of [cli, join(config, "agents"), join(config, "projects"), join(home, "Library"), scratch])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await symlink(keychains, join(home, "Library", "Keychains"));
  await writeFile(
    join(cli, "settings.json"),
    JSON.stringify({
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
      toolPermission: "request-review",
      permissions: {
        allow: [],
        ask: [],
        deny: ["unsandboxed(*)", "command(*)", "mcp(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)"],
      },
    }),
    { mode: 0o400 },
  );
  for (const path of [join(config, "mcp_config.json"), join(cli, "mcp_config.json")])
    await writeFile(path, '{"mcpServers":{}}', { mode: 0o400 });
  await writeFile(join(config, "hooks.json"), "{}", { mode: 0o400 });
  await writeFile(
    join(config, "projects", "default-cli-project.json"),
    JSON.stringify({
      id: "default-cli-project",
      name: "OntoLab request",
      projectResources: {},
    }),
    { mode: 0o400 },
  );
  await writeFile(
    join(config, "agents", "ontolab.md"),
    `---
name: ontolab
description: OntoLab structured inference
tools:
  - finish
mainAgent: true
subagent: false
commandExecutionPolicy: off
mcpServers: []
inheritCustomizations: false
skills: []
plugins: []
---
Return the requested structured result using only the supplied prompt. File, terminal, browser and delegation tools are unavailable.
`,
    { mode: 0o400 },
  );
  const q = JSON.stringify;
  const profile = join(root, "worker.sb");
  await writeFile(
    profile,
    `(version 1)
(deny default)
(allow process-fork signal sysctl-read mach-lookup file-read-metadata)
(allow process-exec (literal ${q(binary)}) (literal "/usr/bin/security"))
(allow file-read* file-map-executable
  (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
  (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/dev")
  (literal ${q(binary)}) (subpath ${q(root)}) (subpath ${q(keychains)})
  (subpath ${q(securityCache)}) (subpath "/private/var/db/mds"))
(allow file-write* (subpath ${q(home)}) (subpath ${q(scratch)}) (literal "/dev/null"))
(allow file-write-data (literal ${q(join(securityCache, "mds.lock"))}))
(deny file-write* (literal ${q(home)}) (literal ${q(join(home, ".gemini"))})
  (literal ${q(join(home, "Library"))}) (literal ${q(join(home, "Library", "Keychains"))})
  (literal ${q(cli)}) (literal ${q(join(cli, "settings.json"))}) (literal ${q(join(cli, "mcp_config.json"))})
  (subpath ${q(config)}))
(allow network*)
`,
    { mode: 0o400 },
  );
  return {
    binary: "/usr/bin/sandbox-exec",
    args: [
      "-f",
      profile,
      binary,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--sandbox",
      "--agent",
      "ontolab",
      "--disable-slash-commands",
      "--json-schema",
      schemaFile,
      "--log-file",
      join(scratch, "native.log"),
      ...(model !== "default" ? ["--model", model] : []),
    ],
    env: { HOME: home, TMPDIR: scratch, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  };
}
