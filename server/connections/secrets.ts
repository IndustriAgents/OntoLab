import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DATA_DIR } from "../config.ts";
import { localConnectionInstall } from "./policy.ts";
import { HttpError } from "../http.ts";
import type { ConnectionAuth } from "../../src/types/connections.ts";

async function key(): Promise<Buffer> {
  const configured = process.env.GRAPH_CONNECTIONS_KEY;
  if (configured) {
    const bytes = Buffer.from(configured, "base64");
    if (bytes.length !== 32) throw new HttpError(503, "GRAPH_CONNECTIONS_KEY must be a base64-encoded 32-byte key.");
    return bytes;
  }
  if (!localConnectionInstall() && process.env.NODE_ENV !== "test")
    throw new HttpError(503, "Configure GRAPH_CONNECTIONS_KEY on this server before storing connection credentials.");
  const dir = resolve(DATA_DIR);
  const path = join(dir, ".graph-connections-key");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const bytes = await readFile(path);
  if (bytes.length !== 32) throw new HttpError(503, "Connection encryption key is invalid.");
  return bytes;
}
export async function encryptAuth(auth: ConnectionAuth, owner: string, id: string): Promise<string | undefined> {
  if (auth.type === "none") return undefined;
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", await key(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(auth)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export async function decryptAuth(value: string | undefined, owner: string, id: string): Promise<ConnectionAuth> {
  if (!value) return { type: "none" };
  try {
    const bytes = Buffer.from(value, "base64"),
      decipher = createDecipheriv("aes-256-gcm", await key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  } catch {
    throw new HttpError(503, "Connection credentials cannot be decrypted. Restore the server key or rotate the credentials.");
  }
}
