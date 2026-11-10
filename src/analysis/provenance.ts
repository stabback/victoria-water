/**
 * "How we know": coverage, freshness and validation of every source, computed from the database
 * so the page (live or statically built) can show its own evidence without calling an API.
 */
import type { Database } from "bun:sqlite";
import { CAPACITY_ML } from "../config.ts";
import { validateReport, type WaterWatchReport } from "../ingest/water-watch-parse.ts";
import manifest from "../ingest/wayback-manifest.json" with { type: "json" };
import { dayNum, isoOf } from "./dates.ts";

type Row = {
  report_date: string;
  sooke_ml: number;
  sooke_pct: number | null;
  goldstream_ml: number | null;
  total_ml: number | null;
  demand_week_mld: number | null;
  demand_month_mld: number | null;
  source_url: string;
};

const isArchive = (url: string) => url.includes("web.archive.org");

/** Week-by-week coverage of the weekly reports: which Sundays have a report (±3 days). */
function coverage(rows: Row[], latest: string) {
  const days = new Set(rows.map((r) => dayNum(r.report_date)));
  const has = (d: number) => [0, -1, 1, -2, 2, -3, 3].some((k) => days.has(d + k));
  const first = Number((rows[0] as Row).report_date.slice(0, 4));
  const last = Number(latest.slice(0, 4));
  const years: { year: number; weeks: number; reports: number; missing: number[]; missingDates: string[] }[] = [];
  for (let y = first; y <= last; y++) {
    // First Sunday of the year (1970-01-04 was a Sunday, day 3).
    let d = dayNum(`${y}-01-01`);
    while ((((d - 3) % 7) + 7) % 7 !== 0) d++;
    const missing: number[] = [];
    const missingDates: string[] = [];
    let weeks = 0;
    for (; isoOf(d).startsWith(String(y)) && d <= dayNum(latest); d += 7) {
      if (!has(d)) {
        missing.push(weeks);
        missingDates.push(isoOf(d));
      }
      weeks++;
    }
    years.push({ year: y, weeks, reports: weeks - missing.length, missing, missingDates });
  }
  return years;
}

/** Maps every archived URL (and its alternates) to the report date it was meant to hold. */
const archiveDates = new Map<string, string>();
for (const e of (manifest as { entries: { date: string; url: string; alternates: string[] }[] }).entries) {
  archiveDates.set(e.url, e.date);
  for (const a of e.alternates) archiveDates.set(a, e.date);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Report date for a failed file: the manifest, the stored title ("Water Watch 2011-11-07"), or a dated file name ("Nov72011.pdf"). */
function dateOfFile(url: string, title: string | null): string | null {
  const known = archiveDates.get(url);
  if (known) return known;
  const t = title?.match(/(\d{4}-\d{2}-\d{2})/);
  if (t) return t[1] as string;
  const f = url.match(/([A-Z][a-z]{2})(\d{1,2})(\d{4})\.pdf/);
  const m = f ? MON.indexOf(f[1] as string) : -1;
  return f && m >= 0 ? `${f[3]}-${String(m + 1).padStart(2, "0")}-${String(f[2]).padStart(2, "0")}` : null;
}

export function buildProvenance(db: Database, today: string) {
  const rows = db
    .query(
      `SELECT report_date, sooke_ml, sooke_pct, goldstream_ml, total_ml, demand_week_mld, demand_month_mld, source_url
       FROM reservoir_reports ORDER BY report_date`,
    )
    .all() as Row[];
  const latest = rows.at(-1);
  if (!latest) return null;

  // ── Validation: re-run the ingest checks on every stored report ───────────────────────────
  let pctChecked = 0;
  let sumChecked = 0;
  let passed = 0;
  for (const r of rows) {
    if (r.sooke_pct !== null) pctChecked++;
    if (r.goldstream_ml !== null && r.total_ml !== null) sumChecked++;
    const problems = validateReport(
      {
        sookeMl: r.sooke_ml,
        sookePct: r.sooke_pct,
        goldstreamMl: r.goldstream_ml,
        totalMl: r.total_ml,
        demandWeekMld: r.demand_week_mld,
        demandMonthMld: r.demand_month_mld,
      } as WaterWatchReport,
      CAPACITY_ML,
    );
    if (!problems.length) passed++;
  }

  // ── Files that were fetched but could not be used ────────────────────────────────────────
  const files = db.query("SELECT url, title, error, rejected, reports_found FROM source_files").all() as {
    url: string;
    title: string | null;
    reports_found: number;
    error: string | null;
    rejected: string | null;
  }[];
  const unreadable = new Map<string, number>();
  const gone: (string | null)[] = [];
  let otherErrors = 0;
  for (const f of files) {
    if (!f.error) continue;
    const date = dateOfFile(f.url, f.title);
    if (/no Water Watch summary/i.test(f.error))
      unreadable.set(date ?? "unknown", (unreadable.get(date ?? "unknown") ?? 0) + 1);
    else if (/HTTP 4\d\d/.test(f.error)) gone.push(date);
    else otherErrors++;
  }
  const covered = new Set(rows.map((r) => r.report_date));
  const rejected = files.filter((f) => f.rejected && f.rejected !== "[]").length;

  // ── Weather series ───────────────────────────────────────────────────────────────────────
  const weather = (source: string) => {
    const w = db
      .query("SELECT min(date) AS first, max(date) AS last, count(*) AS days FROM weather_daily WHERE source = ?")
      .get(source) as { first: string | null; last: string | null; days: number };
    if (!w.first || !w.last) return null;
    const span = dayNum(w.last) - dayNum(w.first) + 1;
    return { first: w.first, last: w.last, days: w.days, missingDays: span - w.days };
  };

  // ── Freshness ────────────────────────────────────────────────────────────────────────────
  const lastCheck = db.query("SELECT max(finished_at) AS at FROM job_runs WHERE ok = 1").get() as {
    at: string | null;
  };
  // Each report is dated a Sunday and posted one to three days later.
  const nextDate = isoOf(dayNum(latest.report_date) + 7);
  const window = { from: isoOf(dayNum(nextDate) + 1), to: isoOf(dayNum(nextDate) + 3) };
  const nextStatus = today < window.from ? "expected" : today <= window.to ? "due" : "late";

  const years = coverage(rows, latest.report_date);
  return {
    reports: {
      count: rows.length,
      first: (rows[0] as Row).report_date,
      latest: latest.report_date,
      fromCrd: rows.filter((r) => !isArchive(r.source_url)).length,
      fromArchive: rows.filter((r) => isArchive(r.source_url)).length,
      archiveYears: (() => {
        const a = rows.filter((r) => isArchive(r.source_url)).map((r) => Number(r.report_date.slice(0, 4)));
        return a.length ? [Math.min(...a), Math.max(...a)] : null;
      })(),
      weeks: years.reduce((a, y) => a + y.weeks, 0),
      missingWeeks: years.reduce((a, y) => a + y.missing.length, 0),
      years,
    },
    validation: {
      reports: rows.length,
      passed,
      pctChecked,
      sumChecked,
      files: files.length,
      archiveFiles: files.filter((f) => isArchive(f.url)).length,
      crdFiles: files.filter((f) => !isArchive(f.url)).length,
      maxReportsPerFile: Math.max(0, ...files.map((f) => f.reports_found)),
      rejectedFiles: rejected,
      /** Reports whose PDF had no readable summary page, by report date (copies tried). */
      unreadable: [...unreadable].map(([date, copies]) => ({ date, copies, recovered: covered.has(date) })),
      /** Archived files that no longer load, by report date, and whether another copy filled the week. */
      gone: gone.length,
      otherErrors,
    },
    weather: { watershed: weather("watershed"), city: weather("city") },
    freshness: {
      lastChecked: lastCheck.at,
      nextReport: { date: nextDate, postedFrom: window.from, postedTo: window.to, status: nextStatus },
    },
  };
}

export type Provenance = NonNullable<ReturnType<typeof buildProvenance>>;
