import { existsSync } from "node:fs";
import { staticPlugin } from "@elysia/static";
import { Elysia } from "elysia";
import { HOST, PORT } from "./config.ts";

/**
 * Serves the built site in `dist/` — nothing else. Any static host would do; this one is here
 * so the server needs nothing beyond Bun.
 * TRAP: the static plugin keeps every file it serves in memory (and with `alwaysStatic: false`
 * it caches file handles for hours, so a rebuilt page is served cut off at its old length).
 * Restart it after each `bun run update`.
 */
if (!existsSync("dist/index.html")) {
  console.error("No site in dist/ yet. Run `bun run update` (or `bun run build` on an existing database).");
  process.exit(1);
}

// Short max-age on everything: the page changes weekly; Astro's hashed assets revalidate cheaply by ETag.
new Elysia()
  .use(await staticPlugin({ assets: "dist", prefix: "/", maxAge: 300 }))
  .listen({ hostname: HOST, port: PORT });
console.log(`Victoria Water → http://${HOST}:${PORT}`);
