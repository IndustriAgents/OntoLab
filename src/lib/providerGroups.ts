import type { ProviderInfo } from "./api";

/** Literal loopback hosts only; a remote hostname containing "localhost" is not local. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const address = host.replace(/^::ffff:/, "");
  return /^127(?:\.\d{1,3}){3}$/.test(address) && address.split(".").every((part) => Number(part) <= 255);
}

export function providerGroups(providers: ProviderInfo[], hostname: string) {
  const groups = [{ id: "api", label: "APIs", providers: providers.filter((provider) => provider.kind !== "cli") }];
  const cli = providers.filter((provider) => provider.kind === "cli");
  if (isLocalHostname(hostname) && cli.length) groups.push({ id: "cli", label: "Local CLIs", providers: cli });
  return groups.filter((group) => group.providers.length);
}
