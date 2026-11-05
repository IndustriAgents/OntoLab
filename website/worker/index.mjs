import { hub } from "./hub.mjs";
const prefix = "/ontolab";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    if (!["GET", "HEAD"].includes(request.method)) {
      response = new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    } else if (url.pathname === "/__docs/health") {
      response = Response.json({ ok: true, product: "ontolab", commit: env.SOURCE_COMMIT || "local" });
    } else if (url.pathname === "/") {
      response = new Response(hub, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } else if (url.pathname === "/robots.txt") {
      response = new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL("/ontolab/sitemap.xml", url)}\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } else if (url.pathname === prefix) {
      response = Response.redirect(new URL(`${prefix}/${url.search}`, url), 308);
    } else if (url.pathname.startsWith(`${prefix}/`)) {
      const assetUrl = new URL(url);
      assetUrl.pathname = url.pathname.slice(prefix.length);
      response = await env.ASSETS.fetch(new Request(assetUrl, request));
      const location = response.headers.get("Location");
      if (location) {
        const target = new URL(location, url);
        if (target.origin === url.origin && !target.pathname.startsWith(`${prefix}/`)) {
          target.pathname = prefix + target.pathname;
          const redirectHeaders = new Headers(response.headers);
          redirectHeaders.set("Location", target.href);
          response = new Response(null, { status: response.status, headers: redirectHeaders });
        }
      }
    } else {
      response = new Response("Documentation not found. Visit /ontolab/.", { status: 404 });
    }
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    // HTML and indexes must be revalidated so releases do not retain old navigation/search.
    if (!url.pathname.includes("/assets/") && !url.pathname.includes("/pagefind/"))
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  },
};
