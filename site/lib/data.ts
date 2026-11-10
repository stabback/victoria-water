import { buildDashboard, type Dashboard } from "../../src/analysis/dashboard.ts";
import { db } from "../../src/db.ts";

let cached: Dashboard | undefined;

/**
 * The dashboard payload, built once per site build and shared by every page and data file.
 * RULE: no data, no site — the build fails rather than publish an empty page.
 */
export function dashboard(): Dashboard {
  if (cached) return cached;
  const d = buildDashboard(db());
  if (!d) throw new Error("The database has no reservoir reports yet. Run `bun run ingest` first.");
  cached = d;
  return d;
}

export { db };
