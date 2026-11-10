import type { Database } from "bun:sqlite";
import { CAPACITY_ML, CRD } from "../config.ts";
import { politeFetch } from "./http.ts";
import { pdfPageLines } from "./pdf-text.ts";
import { parseWaterWatchPage, validateReport, type WaterWatchReport } from "./water-watch-parse.ts";

export type WaterWatchLink = { url: string; title: string; label: string };

/**
 * Every Water Watch PDF linked from the CRD page: this year's weekly reports and the
 * "Previous Years" annual compilations (one weekly report per page).
 *
 * TRAP: the file slugs change every week with no pattern, so links must be discovered from
 * the page — never constructed.
 */
export async function listWaterWatchPdfs(html?: string): Promise<WaterWatchLink[]> {
  const page = html ?? (await (await politeFetch(CRD.waterWatchPage)).text());
  const links: WaterWatchLink[] = [];
  let current: WaterWatchLink | null = null;
  await new HTMLRewriter()
    .on('a[href^="/media/file/"]', {
      element(el) {
        const href = el.getAttribute("href") as string;
        current = { url: new URL(href, CRD.origin).href, title: el.getAttribute("title") ?? "", label: "" };
        links.push(current);
      },
      text(chunk) {
        if (current) current.label += chunk.text;
      },
    })
    .transform(new Response(page))
    .text();
  const seen = new Set<string>();
  return links
    .map((l) => ({ ...l, label: l.label.replace(/\s+/g, " ").trim() }))
    .filter((l) => /water[\s_-]*watch/i.test(`${l.url} ${l.title} ${l.label}`))
    .filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
}

export async function parseWaterWatchPdf(data: Uint8Array) {
  const pages = await pdfPageLines(data);
  const reports: { report: WaterWatchReport; page: number; text: string }[] = [];
  const rejected: { page: number; date: string; problems: string[] }[] = [];
  pages.forEach((lines, i) => {
    const report = parseWaterWatchPage(lines);
    if (!report) return;
    const problems = validateReport(report, CAPACITY_ML);
    if (problems.length) rejected.push({ page: i + 1, date: report.reportDate, problems });
    else reports.push({ report, page: i + 1, text: lines.join("\n") });
  });
  return { pageCount: pages.length, reports, rejected };
}

export function upsertReport(db: Database, r: WaterWatchReport, sourceUrl: string, page: number, text: string) {
  db.query(
    `INSERT INTO reservoir_reports (
      report_date, source_url, source_page, sooke_ml, goldstream_ml, total_ml, sooke_pct, goldstream_pct, total_pct,
      month_end, sooke_5yr_ml, goldstream_5yr_ml, total_5yr_ml, sooke_last_year_ml, goldstream_last_year_ml,
      total_last_year_ml, demand_month_mld, demand_week_mld, demand_max_day_mld, demand_5yr_mld,
      rain_month_normal_mm, rain_month_mm, rain_season_normal_mm, rain_season_mm, raw_text, ingested_at
    ) VALUES (
      $reportDate, $sourceUrl, $page, $sookeMl, $goldstreamMl, $totalMl, $sookePct, $goldstreamPct, $totalPct,
      $monthEnd, $sooke5yrMl, $goldstream5yrMl, $total5yrMl, $sookeLastYearMl, $goldstreamLastYearMl,
      $totalLastYearMl, $demandMonthMld, $demandWeekMld, $demandMaxDayMld, $demand5yrMld,
      $rainMonthNormalMm, $rainMonthMm, $rainSeasonNormalMm, $rainSeasonMm, $text, $now
    )
    ON CONFLICT (report_date) DO UPDATE SET
      source_url = excluded.source_url, source_page = excluded.source_page, sooke_ml = excluded.sooke_ml,
      goldstream_ml = excluded.goldstream_ml, total_ml = excluded.total_ml, sooke_pct = excluded.sooke_pct,
      goldstream_pct = excluded.goldstream_pct, total_pct = excluded.total_pct, month_end = excluded.month_end,
      sooke_5yr_ml = excluded.sooke_5yr_ml, goldstream_5yr_ml = excluded.goldstream_5yr_ml,
      total_5yr_ml = excluded.total_5yr_ml, sooke_last_year_ml = excluded.sooke_last_year_ml,
      goldstream_last_year_ml = excluded.goldstream_last_year_ml, total_last_year_ml = excluded.total_last_year_ml,
      demand_month_mld = excluded.demand_month_mld, demand_week_mld = excluded.demand_week_mld,
      demand_max_day_mld = excluded.demand_max_day_mld, demand_5yr_mld = excluded.demand_5yr_mld,
      rain_month_normal_mm = excluded.rain_month_normal_mm, rain_month_mm = excluded.rain_month_mm,
      rain_season_normal_mm = excluded.rain_season_normal_mm, rain_season_mm = excluded.rain_season_mm,
      raw_text = excluded.raw_text, ingested_at = excluded.ingested_at`,
  ).run({ ...r, sourceUrl, page, text, now: new Date().toISOString() });
}

/**
 * Downloads and ingests every Water Watch PDF not seen before. The first run is the historical
 * backfill (annual compilations 2022+ and this year's weeklies); later runs pick up new weeks.
 */
export async function ingestWaterWatch(db: Database, log: (msg: string) => void = console.log) {
  const links = await listWaterWatchPdfs();
  const known = new Set(
    (db.query("SELECT url FROM source_files WHERE error IS NULL").all() as { url: string }[]).map((r) => r.url),
  );
  // Oldest first, so a weekly file (newer) wins over a compilation if both carry a date.
  const todo = links.filter((l) => !known.has(l.url)).reverse();
  let added = 0;
  const problems: string[] = [];
  for (const link of todo) {
    try {
      const data = new Uint8Array(await (await politeFetch(link.url)).arrayBuffer());
      // TRAP: pdf.js detaches the buffer it is given — measure and hash before parsing.
      const bytes = data.byteLength;
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
      const { reports, rejected } = await parseWaterWatchPdf(data);
      db.transaction(() => {
        for (const { report, page, text } of reports) upsertReport(db, report, link.url, page, text);
        db.query(
          `INSERT OR REPLACE INTO source_files (url, title, label, bytes, sha256, fetched_at, reports_found, rejected, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          link.url,
          link.title,
          link.label,
          bytes,
          sha256,
          new Date().toISOString(),
          reports.length,
          rejected.length ? JSON.stringify(rejected) : null,
          // A file with nothing parseable is an error, so it is retried and shows in /api/status.
          reports.length || rejected.length ? null : "no Water Watch summary found in PDF",
        );
      })();
      added += reports.length;
      if (!reports.length && !rejected.length) problems.push(`${link.url}: no Water Watch summary found`);
      for (const r of rejected) problems.push(`${link.url} p${r.page} ${r.date}: ${r.problems.join("; ")}`);
      log(`water-watch: ${link.title || link.url} → ${reports.length} report(s)`);
    } catch (error) {
      problems.push(`${link.url}: ${error instanceof Error ? error.message : String(error)}`);
      db.query(
        `INSERT OR REPLACE INTO source_files (url, title, label, fetched_at, reports_found, error) VALUES (?, ?, ?, ?, 0, ?)`,
      ).run(link.url, link.title, link.label, new Date().toISOString(), String(error));
    }
  }
  return { linksFound: links.length, filesProcessed: todo.length, reportsAdded: added, problems };
}
