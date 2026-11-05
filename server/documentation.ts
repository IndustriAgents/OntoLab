import type http from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { send } from "./http.ts";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".ttl": "text/turtle; charset=utf-8",
  ".xml": "application/xml",
};

/** Documentation is a separate static site; missing articles never return the app shell. */
export async function serveDocumentation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  path: string,
  base: string,
  search: string,
): Promise<void> {
  if (path === "/docs") {
    res.writeHead(308, { location: `${base}/docs/${search}` });
    res.end();
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(path.slice("/docs/".length));
  } catch {
    send(res, 400, "Invalid documentation path", "text/plain");
    return;
  }
  if (relative.includes("\\") || relative.includes("\0") || relative.split("/").some((p) => p === ".." || p.startsWith("."))) {
    send(res, 403, "Forbidden", "text/plain");
    return;
  }
  const directory = resolve(root),
    requested = resolve(directory, relative);
  if (requested !== directory && !requested.startsWith(directory + sep)) {
    send(res, 403, "Forbidden", "text/plain");
    return;
  }
  try {
    let file = requested;
    if ((await stat(file)).isDirectory()) {
      if (!path.endsWith("/")) {
        res.writeHead(308, { location: `${base}${path}/${search}` });
        res.end();
        return;
      }
      file = join(file, "index.html");
    }
    const [actualRoot, actualFile] = await Promise.all([realpath(directory), realpath(file)]);
    if (!actualFile.startsWith(actualRoot + sep)) {
      send(res, 403, "Forbidden", "text/plain");
      return;
    }
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    const data = req.method === "HEAD" ? Buffer.alloc(0) : await readFile(file);
    send(res, 200, data, types[extname(file)] ?? "application/octet-stream", { "cache-control": "no-cache" });
  } catch {
    try {
      send(res, 404, req.method === "HEAD" ? "" : await readFile(join(directory, "404.html")), "text/html; charset=utf-8", {
        "cache-control": "no-cache",
      });
    } catch {
      send(res, 404, "Bundled documentation is unavailable. Build it with npm run docs:bundle.", "text/plain; charset=utf-8");
    }
  }
}
