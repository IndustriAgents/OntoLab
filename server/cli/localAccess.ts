import { isLocalHostname } from "../../src/lib/providerGroups.ts";

/** Check the actual peer and Host header; forwarded headers do not make a hosted page local. */
export function isLocalCliConnection(host: string | undefined, remoteAddress: string | undefined): boolean {
  if (!host || !remoteAddress || !isLocalHostname(remoteAddress)) return false;
  try {
    return isLocalHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}
