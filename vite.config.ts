import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Production is served by the Node server (server/index.ts) under BASE_PATH —
 * "/ontolab" behind the industriagents-gateway Worker, or "/" when served at the
 * root. The SAME value drives Vite's `base` and the server's prefix stripping,
 * and it is read from .env here (loadEnv) exactly as the server reads it via
 * dotenv, so a build and its server can never disagree about the mount point.
 *
 * Dev serves at "/" and proxies /api to the API server. The API port comes from
 * API_PORT, falling back to PORT — matching server/config.ts, so the proxy and
 * the API always agree even when the surrounding tooling injects a PORT of its
 * own for the web server.
 */
export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const apiPort = env.API_PORT || env.PORT || "3000";
  const basePath = (env.BASE_PATH ?? "").replace(/\/+$/, "");

  return {
    base: command === "build" ? `${basePath}/` : "/",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        // The local server validates the original browser Host and Origin.
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
        "/docs": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      },
    },
    // pdf.js ships as ESM; keep it out of the optimize-deps worker rewrite trouble.
    // The SHACL stack (rdf-validate-shacl + RDFJS) is pre-bundled so its CJS/ESM
    // interop is resolved once at dev-server start rather than per-request.
    optimizeDeps: { include: ["pdfjs-dist", "rdf-validate-shacl", "@rdfjs/dataset", "@rdfjs/data-model"] },
    build: {
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          // Split the heavy, independently-loaded libraries out of the entry
          // chunk so the first paint does not download the graph engine, the
          // SHACL stack and the PDF parser before the upload screen appears.
          manualChunks: {
            cytoscape: ["cytoscape", "cytoscape-fcose", "cytoscape-dagre", "dagre"],
            rdf: ["n3", "rdf-validate-shacl", "@rdfjs/dataset", "@rdfjs/data-model"],
            react: ["react", "react-dom"],
          },
        },
      },
    },
  };
});
