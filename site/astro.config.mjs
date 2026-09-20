// @ts-check
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import { existsSync, readFileSync } from "node:fs";

// Same arrangement as the app's `vite.config.ts` one level up: a real,
// publicly-trusted cert for the tailnet MagicDNS name, minted with
// `tailscale cert --cert-file ../.certs/dev.crt --key-file ../.certs/dev.key
// dev.taild544b4.ts.net` and kept out of git. Absent, the dev server falls
// back to plain HTTP so a fresh checkout still runs.
const certFile = "../.certs/dev.crt";
const keyFile = "../.certs/dev.key";
const httpsOptions =
  existsSync(certFile) && existsSync(keyFile)
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

export default defineConfig({
  site: "https://factory.frebreco.de",

  // No `redirects` entry for `/docs`. On static hosting Astro can only compile
  // one into a meta-refresh stub, and an unstyled stub paints white before it
  // bounces. `pages/docs/[...slug].astro` renders the entry page at `/docs`
  // instead — same destination, no flash.

  // Expressive Code's own options live in `ec.config.mjs` — see the note there.
  integrations: [expressiveCode()],

  // Bound to the tailnet, not just loopback, so the dev server is shareable.
  server: { host: "0.0.0.0", port: Number(process.env.PORT) || 4321 },

  vite: {
    plugins: [tailwind()],
    server: {
      // Vite rejects host headers that aren't localhost or an IP by default
      // (CVE-2025-30208 hardening); the MagicDNS name needs an explicit allow.
      allowedHosts: ["dev.taild544b4.ts.net"],
      https: httpsOptions,
    },
  },
});
