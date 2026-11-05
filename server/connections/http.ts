import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type TcpSocketConnectOpts } from "node:net";
import { localConnectionInstall } from "./policy.ts";
import { HttpError } from "../http.ts";
import type { ConnectionAuth } from "../../src/types/connections.ts";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const localAllowed = () => process.env.GRAPH_CONNECTIONS_ALLOW_PRIVATE === "1" || localConnectionInstall();

export function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) throw new HttpError(400, "Enter an HTTP(S) endpoint.");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a valid endpoint URL.");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || u.search)
    throw new HttpError(400, "Use an HTTP(S) endpoint without credentials, query parameters or fragments. Enter credentials separately.");
  return u.toString();
}
export function allowedAddress(address: string, allowPrivate = localAllowed()): boolean {
  // Normalize IPv4-mapped IPv6 before checking private/link-local ranges.
  let ip = address.toLowerCase();
  if (/^::ffff:/i.test(ip)) {
    const tail = ip.slice(7);
    if (isIP(tail) === 4) ip = tail;
    else {
      const parts = tail.split(":");
      if (parts.length === 2) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      }
    }
  }
  if (isIP(ip) === 4) {
    // Cloud metadata/link-local and multicast are never database endpoints.
    if (ip === "100.100.100.200" || ip.startsWith("169.254.") || Number(ip.split(".")[0]) >= 224 || ip.startsWith("0.")) return false;
    return allowPrivate || !blocked.check(ip, "ipv4");
  }
  if (isIP(ip) === 6) {
    if (ip === "fd00:ec2::254" || /^(fe[89ab]|ff)/i.test(ip) || ip === "::") return false;
    return allowPrivate || (global6.check(ip, "ipv6") && !blocked.check(ip, "ipv6"));
  }
  return false;
}

/** Resolve and pin the socket address on every request; never follow redirects. */
export async function remoteRequest(
  url: URL,
  auth: ConnectionAuth,
  options: { body: string; contentType: string; accept?: string; method?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.min(options.timeoutMs ?? 15000, 30000)),
    ...(options.signal ? [options.signal] : []),
  ]);
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new HttpError(504, "Connection timed out.")), { once: true }),
    ),
  ]).catch((e: unknown) => {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "Database hostname could not be resolved. Check the endpoint and network access.");
  });
  if (signal.aborted) throw new HttpError(504, "Connection timed out.");
  if (!addresses.length || addresses.some((a) => !allowedAddress(a.address)))
    throw new HttpError(
      400,
      "This endpoint is blocked by the server network policy. Private databases require a local workspace or GRAPH_CONNECTIONS_ALLOW_PRIVATE=1 on a trusted server.",
    );
  const headers: Record<string, string> = {
    "content-type": options.contentType,
    accept: options.accept ?? "application/json",
    "content-length": String(Buffer.byteLength(options.body)),
    "accept-encoding": "identity",
  };
  if (auth.type === "basic") headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
  if (auth.type === "bearer") headers.authorization = `Bearer ${auth.token}`;
  try {
    return await new Promise<string>((resolve, reject) => {
      const requestOptions: http.RequestOptions & Pick<TcpSocketConnectOpts, "autoSelectFamily"> = {
        method: options.method ?? "POST",
        headers,
        signal,
        agent: false,
        autoSelectFamily: true,
        lookup: (_host, opts, cb) => (opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family)),
      };
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        requestOptions,
        (res) => {
          const status = res.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            res.resume();
            reject(
              new HttpError(
                status === 401 || status === 403 ? 422 : 502,
                status >= 300 && status < 400
                  ? "Database redirects are refused. Enter the final endpoint URL."
                  : status === 401 || status === 403
                    ? "Database authentication or permission was refused. Check the connection credentials."
                    : `Database returned HTTP ${status}. Check the endpoint and database logs.`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) {
              reject(new HttpError(413, "Database response exceeded 2 MB. Narrow the query."));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      signal.aborted ? 504 : 502,
      signal.aborted
        ? "Database query timed out or was cancelled."
        : "Could not reach the database. Check the endpoint, TLS certificate and network access.",
    );
  }
}
