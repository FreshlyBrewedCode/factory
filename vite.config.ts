import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// `tailscale cert --cert-file .certs/dev.crt --key-file .certs/dev.key
// dev.taild544b4.ts.net` — a real, publicly-trusted cert for the tailnet
// MagicDNS name, kept out of git (per-machine, renewable any time). Absent,
// Vite falls back to plain HTTP so a fresh checkout still runs.
const certFile = "./.certs/dev.crt";
const keyFile = "./.certs/dev.key";
const httpsOptions =
  existsSync(certFile) && existsSync(keyFile)
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

/**
 * UI-only dev server: same `src/web` source `factory serve`'s Bun.serve
 * bundles in production, but here Vite owns the bundling and proxies `/api/*`
 * (including the SSE run-events stream — Vite's proxy streams by default) to
 * a separately running daemon rather than mounting the API in-process. Point
 * `FACTORY_BACKEND_URL` at a prod `factory serve` instance to iterate on the
 * UI against real data.
 *
 * `envPrefix` adds `FACTORY_` alongside Vite's default `VITE_` so
 * `FACTORY_AGENTATION=1` (read via `import.meta.env.FACTORY_AGENTATION` in
 * `src/web/main.tsx`) keeps the same name it had under the Bun-based version
 * of this script.
 */
export default defineConfig({
  root: "src/web",
  envPrefix: ["VITE_", "FACTORY_"],
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@/web": new URL("./src/web", import.meta.url).pathname },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4005,
    // Vite's host-header check (CVE-2025-30208 hardening) rejects anything
    // that isn't localhost/an IP by default — the Tailscale MagicDNS name
    // this is shared over needs an explicit allow.
    allowedHosts: ["dev.taild544b4.ts.net"],
    https: httpsOptions,
    fs: {
      // `root` is `src/web`, but `api.ts`/`hooks.ts`/etc. reach up to shared
      // types under `src/` (`../events`, `../lib/sse-client`, ...) — without
      // this, Vite's dev server can't tell those files apart from a workspace
      // it shouldn't serve, and 403s them, which the browser reports as the
      // wrong MIME type rather than the real cause.
      allow: [import.meta.dirname],
    },
    proxy: {
      // Trailing slash matters: a bare "/api" prefix also matches source
      // files like `/api.ts` (`src/web/api.ts`), forwarding them to the
      // backend, whose own SPA fallback answers with `index.html` — the
      // browser then rejects it as a module script with the wrong MIME type.
      "/api/": {
        target: process.env.FACTORY_BACKEND_URL ?? "http://localhost:3005",
        changeOrigin: true,
      },
    },
  },
});
