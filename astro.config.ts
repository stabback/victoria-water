import { defineConfig } from "astro/config";
import { SITE_URL } from "./src/config.ts";

// A fully static site, built from the SQLite database at build time (`bun run build`).
export default defineConfig({
  site: SITE_URL,
  srcDir: "./site",
  // TRAP: bun:sqlite only exists under Bun; keep Vite from trying to bundle it.
  vite: { ssr: { external: ["bun:sqlite"] } },
});
