/**
 * `bun run update [--force]` — the scheduled job: once this week's report is in, nothing to do;
 * otherwise run every ingest job and, if a new report arrived, rebuild the static site.
 *
 * Each Water Watch report covers the week to a Sunday; the CRD posts it Monday–Wednesday
 * (Monday midday most weeks) and skips the odd week. Schedule this a few times a day: runs before
 * the report is posted, and runs after it is in, change nothing. `--force` ingests and rebuilds
 * regardless (after code changes).
 *
 * The site is built into `dist-next/` and swapped into `dist/` only when the build succeeds,
 * so a failed source or build never replaces a good site. Exit code 1 if anything failed.
 * After a rebuild with a new report, posts to `ALERT_URL` if set (a failed post is logged only).
 * RULE: one update at a time — schedule it under `flock` (see README).
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { ALERT_URL, SITE_URL } from "./config.ts";
import { db } from "./db.ts";
import { addDays, isoToday } from "./ingest/http.ts";
import { JOBS, type JobName, runJobs } from "./ingest/run.ts";

const force = process.argv.includes("--force");
const today = isoToday();
/** The Sunday that ends the week whose report is due (today, if today is Sunday). */
const due = addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay());
const latestReport = () =>
  db().query<{ d: string | null }, []>("SELECT max(report_date) AS d FROM reservoir_reports").get()?.d ?? "";

// TRAP: compare as "on or after" — a holiday week's report can be dated the Monday.
if (!force && latestReport() >= due) {
  console.log(`[update] the report for ${due} is already in; nothing to do`);
  process.exit(0);
}

const before = latestReport();
const results = await runJobs(db(), Object.keys(JOBS) as JobName[]);
for (const r of results) console.log(`[update] ${r.job}: ${r.ok ? "ok" : "FAILED"} ${JSON.stringify(r.detail)}`);
const ok = results.every((r) => r.ok);
// RULE: rebuild on any new report, not only the one due — a late report must not wait a week.
const after = latestReport();
const totalPct = db()
  .query<{ p: number | null }, [string]>("SELECT total_pct AS p FROM reservoir_reports WHERE report_date = ?")
  .get(after)?.p;
db().close();
if (!force && after === before) {
  console.log(`[update] the report for ${due} isn't posted yet; the site is unchanged`);
  process.exit(ok ? 0 : 1);
}

// TRAP: Astro must run under Bun (`--bun`), not Node — the build reads the database with bun:sqlite.
const build = Bun.spawnSync(["bun", "--bun", "astro", "build", "--outDir", "dist-next"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error("[update] build failed; the current site is unchanged");
  rmSync("dist-next", { recursive: true, force: true });
  process.exit(1);
}
rmSync("dist-prev", { recursive: true, force: true });
if (existsSync("dist")) renameSync("dist", "dist-prev");
renameSync("dist-next", "dist");
rmSync("dist-prev", { recursive: true, force: true });
console.log("[update] site rebuilt");
if (after !== before)
  await alert(
    `New report for the week to ${after}${totalPct == null ? "" : `: ${totalPct}% full`}. Site rebuilt: ${SITE_URL}`,
  );
process.exit(ok ? 0 : 1);

/** Posts one alert in Alertmanager's webhook shape (Alertmanager or any relay that accepts it). */
async function alert(summary: string) {
  if (!ALERT_URL) return;
  const body = { alerts: [{ status: "firing", labels: { alertname: "Victoria Water" }, annotations: { summary } }] };
  try {
    const res = await fetch(ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    console.log(`[update] alert: ${res.status}`);
  } catch (e) {
    console.error(`[update] alert failed: ${e}`);
  }
}
