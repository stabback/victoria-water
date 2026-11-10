import type { Database } from "bun:sqlite";

/**
 * The raw tables as they are published under /data. Pure functions of the database so the
 * static build (`site/pages/data/`) and the tests share them.
 */

const RESERVOIR_COLUMNS = `report_date, sooke_ml, sooke_pct, goldstream_ml, goldstream_pct, total_ml, total_pct,
  month_end, sooke_5yr_ml, goldstream_5yr_ml, total_5yr_ml, sooke_last_year_ml, goldstream_last_year_ml,
  total_last_year_ml, demand_week_mld, demand_month_mld, demand_max_day_mld, demand_5yr_mld,
  rain_month_mm, rain_month_normal_mm, rain_season_mm, rain_season_normal_mm, source_url, source_page`;

export type Row = Record<string, unknown>;

export const WEATHER_SOURCES = ["watershed", "city", "forecast"] as const;
export type WeatherSource = (typeof WEATHER_SOURCES)[number];

export const reservoirRows = (db: Database) =>
  db.query(`SELECT ${RESERVOIR_COLUMNS} FROM reservoir_reports ORDER BY report_date`).all() as Row[];

export const weatherRows = (db: Database, source: WeatherSource) =>
  db
    .query("SELECT date, precip, rain, snow, tmax, tmin, tmean FROM weather_daily WHERE source = ? ORDER BY date")
    .all(source) as Row[];

export const populationRows = (db: Database) =>
  db.query("SELECT year, area, persons, vector, released FROM population ORDER BY year, area").all() as Row[];

/** Every file ingestion has looked at, with its checksum and what was rejected. */
export const sourceFiles = (db: Database) =>
  db
    .query(
      "SELECT url, title, label, bytes, sha256, fetched_at, reports_found, rejected, error FROM source_files ORDER BY fetched_at DESC",
    )
    .all() as Row[];

export function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0] as object);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n")}\n`;
}

export const robotsTxt = (siteUrl: string) => `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;

export function sitemapXml(db: Database, siteUrl: string) {
  const last = (db.query("SELECT max(report_date) AS d FROM reservoir_reports").get() as { d: string | null }).d;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc>${last ? `<lastmod>${last}</lastmod>` : ""}<changefreq>daily</changefreq><priority>1.0</priority></url>\n  <url><loc>${siteUrl}/sources/</loc>${last ? `<lastmod>${last}</lastmod>` : ""}<changefreq>weekly</changefreq><priority>0.6</priority></url>\n</urlset>\n`;
}
