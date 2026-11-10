import { describe, expect, test } from "bun:test";
import { CAPACITY_ML } from "../src/config.ts";
import { listWaterWatchPdfs } from "../src/ingest/water-watch.ts";
import { parseWaterWatchPage, validateReport } from "../src/ingest/water-watch-parse.ts";
import pages from "./fixtures/water-watch-pages.json";

describe("parseWaterWatchPage", () => {
  test("2026 ML-only layout", () => {
    const r = parseWaterWatchPage(pages["2026-11-01"]);
    expect(r).toMatchObject({
      reportDate: "2026-11-01",
      sookeMl: 53_272,
      goldstreamMl: 6_375,
      totalMl: 59_647,
      sookePct: 57.5,
      totalPct: 58.1,
      monthEnd: "2026-11-30",
      sooke5yrMl: 70_693,
      sookeLastYearMl: 61_216,
      demandMonthMld: 112.3,
      demandWeekMld: 114,
      demandMaxDayMld: 112.3,
      demand5yrMld: 105.7,
      rainMonthNormalMm: 261,
      rainMonthMm: 0,
      rainSeasonNormalMm: 244.3,
      rainSeasonMm: 103,
    });
  });

  test("ML + MIG layout (2017–early 2026) uses the ML columns", () => {
    const r = parseWaterWatchPage(pages["2026-01-04"]);
    expect(r).toMatchObject({ reportDate: "2026-01-04", sookeMl: 84_888, sooke5yrMl: 90_043, sookeLastYearMl: 87_340 });
    const old = parseWaterWatchPage(pages["2017-08-06"]);
    expect(old).toMatchObject({ reportDate: "2017-08-06", sookeMl: 76_895, goldstreamMl: 7_346, demandWeekMld: 215.7 });
  });

  test("2009 wording (ML instead of MLD, 10-year average, no 'mm')", () => {
    const r = parseWaterWatchPage(pages["2009-07-05"]);
    expect(r).toMatchObject({
      reportDate: "2009-07-05",
      sookeMl: 70_302,
      sookePct: 76,
      demandWeekMld: 237.7,
      rainSeasonMm: 990.5,
      rainSeasonNormalMm: 1596.2,
    });
  });

  test('abbreviated month in the 2011 title ("Aug 07, 2011")', () => {
    expect(parseWaterWatchPage(pages["2011-08-07"])).toMatchObject({ reportDate: "2011-08-07", sookeMl: 78_993 });
  });

  test('dotted abbreviations ("Sept. 26, 2010") and "Issued:" titles', () => {
    expect(parseWaterWatchPage(pages["2010-09-26"])).toMatchObject({ reportDate: "2010-09-26", sookeMl: 69_153 });
    expect(parseWaterWatchPage(pages["2013-02-04"])).toMatchObject({ reportDate: "2013-02-04", sookeMl: 92_727 });
    const squeezed = pages["2010-09-26"].map((l) => l.replace("Sept. 26, 2010", "Sept.26, 2010"));
    expect(parseWaterWatchPage(squeezed)?.reportDate).toBe("2010-09-26");
  });

  test("ignores non-summary pages", () => {
    expect(parseWaterWatchPage(pages.chartPage)).toBeNull();
    expect(parseWaterWatchPage(["nothing to see"])).toBeNull();
  });

  test("every fixture passes validation", () => {
    for (const key of ["2009-07-05", "2011-08-07", "2017-08-06", "2026-01-04", "2026-11-01"] as const) {
      const r = parseWaterWatchPage(pages[key]);
      expect(r).not.toBeNull();
      expect(validateReport(r as NonNullable<typeof r>, CAPACITY_ML)).toEqual([]);
    }
  });

  test("validation catches inconsistent numbers", () => {
    const r = parseWaterWatchPage(pages["2026-11-01"]);
    if (!r) throw new Error("fixture did not parse");
    expect(validateReport({ ...r, sookePct: 80 }, CAPACITY_ML)).toHaveLength(1);
    expect(validateReport({ ...r, totalMl: 1 }, CAPACITY_ML)).toHaveLength(1);
  });
});

describe("listWaterWatchPdfs", () => {
  test("discovers weekly reports and annual compilations from the CRD page", async () => {
    const html = await Bun.file(`${import.meta.dir}/fixtures/water-watch-index.html`).text();
    const links = await listWaterWatchPdfs(html);
    expect(links.length).toBeGreaterThan(40);
    expect(links[0]).toEqual({
      url: "https://www.crd.ca/media/file/water-watch-report-november-1-2026pdf",
      title: "Water Watch Report - November 1 2026.pdf",
      label: "November 1 [PDF/1.9MB]",
    });
    expect(links.some((l) => l.url.endsWith("crd-2023-weekly-water-watches"))).toBe(true);
    expect(new Set(links.map((l) => l.url)).size).toBe(links.length);
  });
});
