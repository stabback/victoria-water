import { describe, expect, test } from "bun:test";
import { buildDashboard } from "../src/analysis/dashboard.ts";
import { openDb } from "../src/db.ts";
import { reservoirRows, robotsTxt, sitemapXml, toCsv, weatherRows } from "../src/export.ts";
import { addDays } from "../src/ingest/http.ts";

/** A small synthetic database: two years of weekly reports and five years of weather. */
function seed() {
  const db = openDb(":memory:");
  const insertReport = db.query(
    `INSERT INTO reservoir_reports (report_date, source_url, source_page, sooke_ml, sooke_pct, goldstream_ml, total_ml,
       total_pct, demand_week_mld, raw_text, ingested_at)
     VALUES (?, 'https://example.test/r.pdf', 1, ?, ?, 9000, ?, ?, ?, '', '')`,
  );
  let date = "2024-01-07";
  for (let i = 0; i < 100; i++) {
    const phase = Math.sin((i / 52) * 2 * Math.PI);
    const sooke = Math.round(78_000 + 14_000 * phase);
    insertReport.run(
      date,
      sooke,
      (sooke / 92_727) * 100,
      sooke + 9000,
      ((sooke + 9000) / 102_634) * 100,
      130 - 40 * phase,
    );
    date = addDays(date, 7);
  }
  const insertWx = db.query(
    "INSERT INTO weather_daily (source, date, precip, tmax, tmin, tmean) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let d = "2019-01-01"; d <= "2025-12-31"; d = addDays(d, 1)) {
    const m = Number(d.slice(5, 7));
    const wet = m <= 3 || m >= 10;
    insertWx.run(
      "watershed",
      d,
      wet && Number(d.slice(8)) % 3 === 0 ? 20 : 0,
      wet ? 8 : 22,
      wet ? 2 : 11,
      wet ? 5 : 16,
    );
    insertWx.run("city", d, wet && Number(d.slice(8)) % 3 === 0 ? 10 : 0, wet ? 9 : 21, wet ? 3 : 12, wet ? 6 : 16);
  }
  return db;
}

/** What the static build publishes: the page payload and the files under /data. */
describe("site data", () => {
  const db = seed();

  test("dashboard summarises the latest report", () => {
    // Through JSON, exactly as the page and /data/dashboard.json receive it.
    // biome-ignore lint/suspicious/noExplicitAny: a parsed payload, checked field by field
    const d = JSON.parse(JSON.stringify(buildDashboard(db))) as any;
    expect(d.latest.date).toBe(addDays("2024-01-07", 99 * 7));
    expect(["good", "watch", "record"]).toContain(d.health.level);
    expect(d.supply.daysNoRain).toBeGreaterThan(0);
    expect(d.outlook.p50.length).toBe(d.outlook.p10.length);
    expect(d.outlook.p50.length).toBeGreaterThan(100);
    // The headline is the whole system (Sooke + Goldstream).
    expect(d.latest.totalPct).toBeCloseTo((d.latest.totalMl / d.capacity.total) * 100, 1);
    expect(d.history.total.length).toBe(d.history.dates.length);
    // Every section has a one-line takeaway, computed server-side.
    for (const key of ["year", "outlook", "rain", "use", "history"]) {
      expect(typeof d.story[key]).toBe("string");
      expect(d.story[key].length).toBeGreaterThan(10);
    }
    expect(d.story.verdict.word).toMatch(/\.$/);
    expect(d.demand.years.at(-1).useMl).toBeGreaterThan(0);
    expect(d.sources.some((s: { url: string }) => s.url.includes("water-cons-plan"))).toBe(true);
    // "How we know" is computed server-side too: coverage, the model and every method.
    expect(d.proof.provenance.reports.count).toBe(100);
    expect(d.proof.provenance.validation.passed).toBe(100);
    expect(d.proof.methods.length).toBeGreaterThan(5);
    expect(d.proof.downloads.every((x: { path: string }) => x.path.startsWith("/"))).toBe(true);
  });

  test("reservoir and weather tables as CSV", () => {
    const lines = toCsv(reservoirRows(db)).trimEnd().split("\n");
    expect(lines[0]?.startsWith("report_date,sooke_ml")).toBe(true);
    expect(lines.length).toBe(101);
    expect(weatherRows(db, "city").length).toBe(weatherRows(db, "watershed").length);
    expect(toCsv([{ a: 'say "hi", twice', b: null }])).toBe('a,b\n"say ""hi"", twice",\n');
  });

  test("download links point at files the build writes", () => {
    const d = buildDashboard(db);
    expect(d?.proof.downloads.every((x) => x.path.startsWith("/data/"))).toBe(true);
  });

  test("SEO files", () => {
    expect(robotsTxt("https://example.test")).toContain("Sitemap: https://example.test/sitemap.xml");
    expect(sitemapXml(db, "https://example.test")).toContain(`<lastmod>${addDays("2024-01-07", 99 * 7)}</lastmod>`);
  });
});
