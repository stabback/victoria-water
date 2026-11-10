# Agent notes

- A static Astro site (`site/`, `srcDir`) built from SQLite under Bun (`bun --bun astro …`, for `bun:sqlite`); Bun scripts for ingestion and updates; `@elysia/static` only serves `dist/`. Prefer stock Astro/Bun/Elysia features over custom code; if something needs a workaround, stop and reconsider.
- No secrets, keys or logins anywhere — the project is open source and the data is public (`/data/*`).
- RULE: this is a public repo. Nothing specific to a deployment or private to its owner goes in it: no hostnames, tailnet or internal URLs, IPs, ports, home paths, unit names, alert endpoints or infrastructure details. Keep those in the untracked `CLAUDE.local.md`.
- The only novel code is ingestion (`src/ingest/`) and analysis (`src/analysis/`). If a source changes shape, fix the parser and add a fixture in `test/fixtures/` — never silently accept unvalidated numbers.
- Migrations in `src/db.ts` are append-only.
- Comment markers: `TRAP:` (non-obvious pitfall), `RULE:` (invariant to keep).
- Before finishing: `bun run lint`, `bun run check`, `bun test`.
- Front end: no explanatory filler text. Short headings, numbers, charts. Text and figures go in `index.astro` (build time); `site/scripts/app.ts` only draws charts.
