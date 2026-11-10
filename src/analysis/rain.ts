/**
 * Rain since September 1 at Sooke Lake (the CRD's gauge, as quoted in every Water Watch report)
 * and in the city (ECCC, Victoria Gonzales), each against its own normal.
 *
 * The CRD quotes the season total ("Sep 1 – date") and the normal for the same days at each
 * report; both reset on September 1. Seasons are indexed by day since September 1 (0 = Sep 1).
 */
import { dayNum, isoOf, quantile, round, waterYearOf, waterYearStart } from "./dates.ts";

export type LakeRainReport = {
  report_date: string;
  rain_season_mm: number | null;
  rain_season_normal_mm: number | null;
};

export type DailyRain = { date: string; precip: number | null };

type Point = { idx: number; mm: number; normal: number };

const SEASON_DAYS = 365;
const idxOf = (iso: string) => dayNum(iso) - dayNum(waterYearStart(waterYearOf(iso)));

/** Linear interpolation of points onto every day from 0 to the last point (Sep 1 counts as 0 mm). */
function daily(points: { idx: number; v: number }[]): number[] {
  const pts = [{ idx: -1, v: 0 }, ...points];
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { idx: number; v: number };
    const b = pts[i] as { idx: number; v: number };
    for (let d = Math.max(0, a.idx + 1); d <= b.idx; d++) out[d] = a.v + ((b.v - a.v) * (d - a.idx)) / (b.idx - a.idx);
  }
  return out;
}

/** Sooke Lake: this season, last season, the CRD's normal and the range of seasons since 2009. */
export function lakeRain(reports: LakeRainReport[], latestDate: string) {
  const seasons = new Map<number, Point[]>();
  for (const r of reports) {
    if (r.rain_season_mm === null || r.rain_season_normal_mm === null) continue;
    const wy = waterYearOf(r.report_date);
    seasons.set(wy, [
      ...(seasons.get(wy) ?? []),
      { idx: idxOf(r.report_date), mm: r.rain_season_mm, normal: r.rain_season_normal_mm },
    ]);
  }
  const wy = waterYearOf(latestDate);
  const current = seasons.get(wy);
  const latest = current?.at(-1);
  if (!current || !latest || latest.idx !== idxOf(latestDate)) return null;

  const curve = (pts: Point[] | undefined, f: (p: Point) => number) =>
    pts ? daily(pts.map((p) => ({ idx: p.idx, v: f(p) }))).map((v) => round(v, 0)) : [];
  // A complete past season has reports to within two weeks of its end (Aug 31).
  const past = [...seasons.entries()]
    .filter(([w, pts]) => w < wy && (pts[0]?.idx ?? 99) <= 14 && (pts.at(-1)?.idx ?? 0) >= SEASON_DAYS - 15)
    .map(([w, pts]) => ({ wy: w, mm: curve(pts, (p) => p.mm) }));
  // The CRD's normal-to-date: this season's as far as it goes, then last season's.
  const normal = curve(current, (p) => p.normal);
  const lastNormal = curve(seasons.get(wy - 1), (p) => p.normal);
  for (let i = normal.length; i < lastNormal.length; i++) normal[i] = lastNormal[i] as number;

  const p10: number[] = [];
  const p90: number[] = [];
  for (let i = 0; i < SEASON_DAYS; i++) {
    const vals = past
      .map((s) => s.mm[i])
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    if (vals.length < 5) break;
    p10.push(round(quantile(vals, 0.1), 0));
    p90.push(round(quantile(vals, 0.9), 0));
  }

  return {
    start: waterYearStart(wy),
    asOf: latestDate,
    mm: latest.mm,
    normalMm: latest.normal,
    current: curve(current, (p) => p.mm),
    lastYear: curve(seasons.get(wy - 1), (p) => p.mm),
    normal,
    p10,
    p90,
    firstSeason: past[0] ? past[0].wy : wy,
    seasons: past.length,
  };
}

/**
 * Lake rain from the first report on or after `from` to the report on `to`, and the CRD's normal
 * for the same days, chained across
 * September resets. TRAP: across a reset, the days between the season's last report and Aug 31
 * are in neither total — left out of the rain and the normal alike, so the ratio stays fair.
 */
export function lakeRainBetween(reports: LakeRainReport[], from: string, to: string) {
  const rows = reports.filter(
    (r) =>
      r.report_date >= from && r.report_date <= to && r.rain_season_mm !== null && r.rain_season_normal_mm !== null,
  );
  if (rows.length < 2 || rows.at(-1)?.report_date !== to) return null;
  let mm = 0;
  let normalMm = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1] as LakeRainReport;
    const b = rows[i] as LakeRainReport;
    const reset = waterYearOf(b.report_date) !== waterYearOf(a.report_date);
    mm += (b.rain_season_mm as number) - (reset ? 0 : (a.rain_season_mm as number));
    normalMm += (b.rain_season_normal_mm as number) - (reset ? 0 : (a.rain_season_normal_mm as number));
  }
  return { mm: round(mm, 0), normalMm: round(normalMm, 0) };
}

/**
 * The city: rain from September 1 to `seasonOf` (the lake's latest report) and the normal for each day since September 1 (the mean
 * rain on that calendar day over the normal years, so a missing day doesn't drag a year down).
 * RULE: missing days are counted and shown, never filled.
 */
export function cityRain(rows: DailyRain[], seasonOf: string, normals: { from: number; to: number }) {
  const wy = waterYearOf(seasonOf);
  const start = waterYearStart(wy);
  const byDate = new Map(rows.map((r) => [r.date, r.precip]));
  // RULE: the same days as the lake (Sep 1 → the latest report), so the two compare fairly.
  const last = rows.filter((r) => r.precip !== null && r.date >= start && r.date <= seasonOf).at(-1)?.date;
  if (!last) return null;

  const current: number[] = [];
  let missing = 0;
  let sum = 0;
  for (let d = dayNum(start); d <= dayNum(last); d++) {
    const v = byDate.get(isoOf(d));
    if (v === null || v === undefined) missing++;
    else sum += v;
    current.push(round(sum, 0));
  }

  // Seasons (by the year they start) that have any data in the normal period.
  const normalYears = new Set<number>();
  const normal: number[] = [];
  let acc = 0;
  for (let i = 0; i < SEASON_DAYS; i++) {
    const vals: number[] = [];
    for (let y = normals.from; y <= normals.to; y++) {
      const v = byDate.get(isoOf(dayNum(`${y}-09-01`) + i));
      if (v === null || v === undefined) continue;
      vals.push(v);
      normalYears.add(y);
    }
    if (vals.length) acc += vals.reduce((s, v) => s + v, 0) / vals.length;
    normal.push(round(acc, 0));
  }
  const years = [...normalYears].sort((a, b) => a - b);
  return {
    asOf: last,
    mm: round(sum, 0),
    normalMm: normal[current.length - 1] ?? 0,
    missingDays: missing,
    current,
    normal,
    normalFrom: years[0] ?? normals.from,
    normalTo: years.at(-1) ?? normals.to,
  };
}
