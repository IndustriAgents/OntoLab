import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ProviderInfo } from "../providers.ts";
import { HttpError } from "../http.ts";

export const CLI_IDS = ["claude-cli", "codex-cli", "agy-cli"] as const;
export type CliProviderId = (typeof CLI_IDS)[number];
export const isCliProvider = (id: string): id is CliProviderId => CLI_IDS.includes(id as CliProviderId);

/** Use the normal catalog window, with its usable-context percentage; never the experimental maximum. */
export function codexContextLimit(model: string): number | undefined {
  return codexContextLimits()[model];
}

export function codexContextLimits(): Record<string, number> {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      models?: { slug?: string; context_window?: number; effective_context_window_percent?: number }[];
    };
    return Object.fromEntries(
      (data.models ?? []).flatMap((entry) => {
        const context = entry.context_window;
        const percent = entry.effective_context_window_percent ?? 100;
        if (
          typeof entry.slug !== "string" ||
          !/^[a-zA-Z0-9._-]{1,160}$/.test(entry.slug) ||
          !Number.isSafeInteger(context) ||
          context! < 256 ||
          context! > 2_000_000 ||
          !Number.isFinite(percent) ||
          percent <= 0 ||
          percent > 100
        )
          return [];
        const effective = Math.floor((context! * percent) / 100);
        return effective >= 256 ? [[entry.slug, effective]] : [];
      }),
    );
  } catch {
    return {};
  }
}
export const CLI_DEFINITIONS = {
  "claude-cli": { binary: "claude", label: "Claude Code (local CLI)", models: ["sonnet", "opus", "haiku"] },
  "codex-cli": { binary: "codex", label: "Codex (local CLI)", models: ["default"] },
  "agy-cli": { binary: "agy", label: "Antigravity (local CLI)", models: ["default"] },
} satisfies Record<CliProviderId, { binary: string; label: string; models: string[] }>;

/** Read the installed CLI's model catalog without starting a session or making an inference request. */
export function codexModelCatalog(): Record<string, string[]> {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      models?: { slug?: string; visibility?: string; supported_reasoning_levels?: { effort?: string }[] }[];
    };
    const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    return Object.fromEntries(
      (data.models ?? [])
        .filter((model) => model.visibility === "list" && typeof model.slug === "string" && /^[a-zA-Z0-9._-]{1,160}$/.test(model.slug))
        .map((model) => [
          model.slug!,
          (model.supported_reasoning_levels ?? []).flatMap((level) => (efforts.has(level.effort ?? "") ? [level.effort!] : [])),
        ]),
    );
  } catch {
    return {};
  }
}

export function validateCliReasoning(provider: string, model: string, effort?: string): void {
  if (!effort) return;
  if (provider !== "codex-cli" || !codexModelCatalog()[model]?.includes(effort))
    throw new HttpError(
      400,
      `Reasoning effort "${effort}" is not supported for ${provider} / ${model}. Select an available model and effort.`,
    );
}

/** Local CLI execution is on in development and opt-in in production builds. */
export function localCliEnabled(): boolean {
  return (
    process.env.LOCAL_CLI_ENABLED === "1" ||
    (process.env.LOCAL_CLI_ENABLED !== "0" && process.env.NODE_ENV !== "production")
  );
}
export function cliBinary(id: CliProviderId): string | undefined {
  const binary = CLI_DEFINITIONS[id].binary;
  const override = process.env[`ONTOLAB_${binary.toUpperCase()}_BIN`];
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => isAbsolute(dir) && !dir.includes("node_modules"))
        .map((dir) => join(dir, process.platform === "win32" ? `${binary}.exe` : binary));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* next absolute PATH entry */
    }
  }
}
export function cliModels(id: CliProviderId): string[] {
  const value = process.env[`ONTOLAB_${CLI_DEFINITIONS[id].binary.toUpperCase()}_MODELS`];
  return (
    value
      ?.split(",")
      .map((model) => model.trim())
      .filter(Boolean) ?? (id === "codex-cli" ? ["default", ...Object.keys(codexModelCatalog())] : CLI_DEFINITIONS[id].models)
  );
}
const agyVersions = new Map<string, { at: number; reason?: string }>();
export const agyVersionSupported = (version: string): boolean => ["1.4.4", "1.4.5", "1.4.6", "1.4.7"].includes(version.trim());
function agyCompatibility(binary: string): string | undefined {
  const cached = agyVersions.get(binary);
  if (cached && Date.now() - cached.at < 60_000) return cached.reason;
  let reason: string | undefined;
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!agyVersionSupported(version)) reason = "Installed Antigravity version needs an updated isolation profile (supported: 1.4.4–1.4.7)";
  } catch {
    reason = "Could not verify the installed Antigravity version";
  }
  agyVersions.set(binary, { at: Date.now(), reason });
  return reason;
}
export function cliProviders(): ProviderInfo[] {
  return CLI_IDS.map((id) => {
    const binary = cliBinary(id);
    const installed = !!binary;
    const supported = id !== "agy-cli" || process.platform === "darwin";
    const disabledReason = !localCliEnabled()
      ? "Local CLI execution is disabled on this server"
      : !installed
        ? `${CLI_DEFINITIONS[id].binary} is not installed on the server`
        : !supported
          ? "Isolated Antigravity execution currently requires macOS"
          : id === "agy-cli" && binary
            ? agyCompatibility(binary)
            : undefined;
    return {
      id,
      label: CLI_DEFINITIONS[id].label,
      models: cliModels(id),
      enabled: !disabledReason,
      kind: "cli",
      disabledReason,
      authStatus: "unknown",
      outputLimitControl: "provider-managed",
      ...(id === "codex-cli" ? { reasoningEfforts: codexModelCatalog(), contextWindows: codexContextLimits() } : {}),
    };
  });
}
