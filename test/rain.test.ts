import { describe, expect, test } from "bun:test";
import { cityRain, lakeRain, lakeRainBetween } from "../src/analysis/rain.ts";

// Real values from the 2025 and 2026 Water Watch reports (season = Sep 1 → report date).
const reports = [
  { report_date: "2026-05-17", rain_season_mm: 1602.0, rain_season_normal_mm: 1525.7 },
  { report_date: "2026-08-30", rain_season_mm: 1659.8, rain_season_normal_mm: 1630.4 },
  { report_date: "2026-09-06", rain_season_mm: 5.7, rain_season_normal_mm: 8.6 },
  { report_date: "2026-10-25", rain_season_mm: 85.5, rain_season_normal_mm: 193.3 },
  { report_date: "2026-11-01", rain_season_mm: 103.0, rain_season_normal_mm: 244.3 },
];

describe("rain", () => {
  test("lake: the season to date is the CRD's own figure", () => {
    const lake = lakeRain(reports, "2026-11-01");
    expect(lake?.start).toBe("2026-09-01");
    expect(lake?.mm).toBe(103);
    expect(lake?.normalMm).toBe(244.3);
    // Sep 1 → Nov 1 inclusive, interpolated between reports, from 0 on Sep 1.
    expect(lake?.current.length).toBe(62);
    expect(lake?.current[61]).toBe(103);
    expect(lakeRain(reports, "2026-11-08")).toBeNull();
  });

  test("lake: a window across the September reset chains the two seasons", () => {
    // (1659.8 − 1602.0) + 103.0 and (1630.4 − 1525.7) + 244.3.
    expect(lakeRainBetween(reports, "2026-05-17", "2026-11-01")).toEqual({ mm: 161, normalMm: 349 });
    // Starts at the first report on or after the date.
    expect(lakeRainBetween(reports, "2026-09-01", "2026-11-01")).toEqual({ mm: 97, normalMm: 236 });
  });

  test("city: same days as the lake; missing days counted, not filled", () => {
    const rows = [];
    for (let y = 1991; y <= 2026; y++)
      for (const d of ["09-01", "09-02", "09-03"]) rows.push({ date: `${y}-${d}`, precip: y === 2026 ? 4 : 2 });
    rows.push({ date: "2026-09-04", precip: null }, { date: "2026-09-05", precip: 10 });
    const city = cityRain(rows, "2026-09-04", { from: 1991, to: 2020 });
    expect(city?.asOf).toBe("2026-09-03");
    expect(city?.mm).toBe(12);
    expect(city?.normalMm).toBe(6);
    expect(city?.normalFrom).toBe(1991);
    expect(city?.normalTo).toBe(2020);
    const withGap = cityRain(rows, "2026-09-05", { from: 1991, to: 2020 });
    expect(withGap?.mm).toBe(22);
    expect(withGap?.missingDays).toBe(1);
  });
});
