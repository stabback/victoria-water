import type { Database } from "bun:sqlite";
import {
  CAPACITY_ML,
  CITY,
  CRD,
  DOWNLOADS,
  NORMALS,
  POPULATION,
  REPO_URL,
  SOOKE_WATERSHED,
  WATERSHED,
} from "../config.ts";
import { isoToday } from "../ingest/http.ts";
import { dayNum, doy, isoOf, quantile, round } from "./dates.ts";
import {
  type Calibration,
  calibrate,
  calibrationIntervals,
  monthlyBias,
  netInflows,
  type Params,
  pet,
  type State,
  simulateStorage,
  stepWatershed,
  type WeatherDay,
} from "./model.ts";
import { buildProvenance } from "./provenance.ts";
import { cityRain, lakeRain, lakeRainBetween } from "./rain.ts";
import { buildStory, STATUS } from "./story.ts";

export type ReportRow = {
  report_date: string;
  sooke_ml: number;
  sooke_pct: number | null;
  goldstream_ml: number | null;
  goldstream_pct: number | null;
  total_ml: number | null;
  total_pct: number | null;
  sooke_5yr_ml: number | null;
  month_end: string | null;
  demand_week_mld: number | null;
  demand_month_mld: number | null;
  demand_max_day_mld: number | null;
  demand_5yr_mld: number | null;
  rain_month_normal_mm: number | null;
  rain_month_mm: number | null;
  rain_season_normal_mm: number | null;
  rain_season_mm: number | null;
  source_url: string;
};

type WxRow = {
  date: string;
  precip: number | null;
  tmax: number | null;
  tmin: number | null;
  tmean: number | null;
};

const pct = (ml: number, cap: number = CAPACITY_ML.sooke) => round((ml / cap) * 100, 1);
/** Whole system (Sooke + Goldstream) percent full. */
const tpct = (ml: number) => pct(ml, CAPACITY_ML.total);
/** Whole-system volume of a report (the CRD's total, else Sooke + Goldstream when both exist). */
export const totalOf = (r: ReportRow): number | null =>
  r.total_ml ?? (r.goldstream_ml === null ? null : r.sooke_ml + r.goldstream_ml);

export function loadReports(db: Database): ReportRow[] {
  return db
    .query(
      `SELECT report_date, sooke_ml, sooke_pct, goldstream_ml, goldstream_pct, total_ml, total_pct, sooke_5yr_ml,
              month_end, demand_week_mld, demand_month_mld, demand_max_day_mld, demand_5yr_mld,
              rain_month_normal_mm, rain_month_mm, rain_season_normal_mm, rain_season_mm, source_url
       FROM reservoir_reports ORDER BY report_date`,
    )
    .all() as ReportRow[];
}

export function loadWeather(db: Database, source: string): WxRow[] {
  return db
    .query("SELECT date, precip, tmax, tmin, tmean FROM weather_daily WHERE source = ? ORDER BY date")
    .all(source) as WxRow[];
}

/** Gap-free model input: missing precipitation → 0, missing temperatures → previous day. */
function toModelWeather(rows: WxRow[]): WeatherDay[] {
  const out: WeatherDay[] = [];
  let prev = { tmax: 10, tmin: 5, tmean: 7.5 };
  for (const r of rows) {
    const tmax = r.tmax ?? prev.tmax;
    const tmin = r.tmin ?? prev.tmin;
    const tmean = r.tmean ?? (tmax + tmin) / 2;
    prev = { tmax, tmin, tmean };
    out.push({ date: r.date, precip: r.precip ?? 0, tmax, tmin, tmean });
  }
  return out;
}

/** Linear interpolation of a dated series onto every day between its first and last point. */
function dailyInterpolate(points: { date: string; v: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as (typeof points)[number];
    const b = points[i] as (typeof points)[number];
    const da = dayNum(a.date);
    const db = dayNum(b.date);
    if (db - da > 21) continue; // don't bridge long gaps
    for (let d = da; d <= db; d++) out.set(d, a.v + ((b.v - a.v) * (d - da)) / (db - da || 1));
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Number.NaN);

/** Typical daily demand (ML/day) by day of year, from the last three complete years. */
function demandProfile(reports: ReportRow[], currentYear: number): (iso: string) => number {
  const byDoy = new Map<number, number[]>();
  const years = [currentYear - 3, currentYear - 2, currentYear - 1];
  const pts = reports
    .filter((r) => r.demand_week_mld !== null && years.includes(Number(r.report_date.slice(0, 4))))
    .map((r) => ({ date: r.report_date, v: r.demand_week_mld as number }));
  for (const [d, v] of dailyInterpolate(pts)) {
    const k = doy(isoOf(d));
    byDoy.set(k, [...(byDoy.get(k) ?? []), v]);
  }
  const fallback = mean(pts.map((p) => p.v)) || 140;
  const smooth: number[] = [];
  for (let k = 1; k <= 365; k++) {
    const window: number[] = [];
    for (let j = -7; j <= 7; j++) window.push(...(byDoy.get(((k - 1 + j + 365) % 365) + 1) ?? []));
    smooth[k] = window.length ? mean(window) : fallback;
  }
  return (iso) => smooth[doy(iso)] as number;
}

export type Dashboard = NonNullable<ReturnType<typeof buildDashboard>>;

/** CRD 2026–2035 Water Conservation Plan: total metered consumption, Greater Victoria (ML/year). */
export const CRD_CONSUMPTION = { from: { year: 2013, ml: 46_469 }, to: { year: 2023, ml: 51_428 } } as const;
/** The CRD's own growth rate between those two years, for comparison with the measured trend. */
const CRD_GROWTH_PCT =
  ((CRD_CONSUMPTION.to.ml / CRD_CONSUMPTION.from.ml) ** (1 / (CRD_CONSUMPTION.to.year - CRD_CONSUMPTION.from.year)) -
    1) *
  100;
/** The dry-year scenario asks when the whole system would first dip below this level. */
const DRY_THRESHOLD_PCT = 50;
/** "Full": whole system at or above this percent, everywhere on the page (outlook and History).
 * TRAP: not 99% — Goldstream is operated and often peaks near 90% of its capacity in winter, so the
 * whole system can sit just under 99% with Sooke Lake spilling. */
const FULL_PCT = 95;
/** Forecast days trusted as known weather in the outlook. */
const FORECAST_TRUST_DAYS = 4;
/** …then blended with past years' weather, fading out over this many days. */
const FORECAST_FADE_DAYS = 6;
const DRY_SEARCH_YEARS = 50;
/** The dry-season window replayed by the dry-year test: May 1 → Dec 31. */
const DRY_DAYS = 245;

/** Mean weekly use (ML/day) in the given months of a year, from the reports. */
function useIn(reports: ReportRow[], year: number, months: string[]) {
  const v = reports
    .filter((r) => r.report_date.startsWith(`${year}-`) && months.includes(r.report_date.slice(5, 7)))
    .map((r) => r.demand_week_mld)
    .filter((d): d is number => d !== null);
  return v.length >= 2 * months.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
const SUMMER = ["06", "07", "08", "09"];
const WINTER = ["01", "02", "03", "11", "12"];

/** The record's first year against the next: summer and winter use, and the watershed's summer weather. */
function firstYearDrop(reports: ReportRow[], weather: WxRow[], year: number) {
  const next = year + 1;
  const s0 = useIn(reports, year, SUMMER);
  const s1 = useIn(reports, next, SUMMER);
  const w0 = useIn(reports, year, WINTER);
  const w1 = useIn(reports, next, WINTER);
  if (s0 === null || s1 === null || w0 === null || w1 === null) return null;
  const summerWx = (y: number) => {
    const days = weather.filter((d) => d.date.startsWith(`${y}-`) && SUMMER.includes(d.date.slice(5, 7)));
    const t = days.map((d) => d.tmax).filter((v): v is number => v !== null);
    const p = days.map((d) => d.precip).filter((v): v is number => v !== null);
    // RULE: only compare summers the station covers almost completely.
    if (t.length < 115 || p.length < 115) return null;
    return { tmax: t.reduce((a, b) => a + b, 0) / t.length, rain: p.reduce((a, b) => a + b, 0) };
  };
  const a = summerWx(year);
  const b = summerWx(next);
  return {
    year,
    next,
    summerPct: round(((s1 - s0) / s0) * 100, 1),
    winterPct: round(((w1 - w0) / w0) * 100, 1),
    tmaxDiff: a && b ? round(b.tmax - a.tmax, 1) : null,
    rainPct: a && b && a.rain > 0 ? round(((b.rain - a.rain) / a.rain) * 100) : null,
  };
}

/** What the record-low year looked like, from the reports alone (see historyNote in story.ts). */
function lowYearContext(reports: ReportRow[], year: number) {
  const inYear = (y: number) => reports.filter((r) => r.report_date.startsWith(`${y}-`));
  const spring = inYear(year).filter((r) => r.report_date.slice(5, 7) <= "06");
  // A spring peak needs the whole refill season in the record (from the previous November).
  const springPeakPct =
    reports[0] && reports[0].report_date <= `${year - 1}-11-01` && spring.length
      ? round(Math.max(...spring.map((r) => tpct(totalOf(r) as number))))
      : null;
  // RULE: the CRD's season runs September to August; the last August report closes it.
  const seasonRain = new Map<number, number>();
  for (const r of reports)
    if (r.report_date.slice(5, 7) === "08" && r.rain_season_mm !== null && r.rain_season_normal_mm)
      seasonRain.set(Number(r.report_date.slice(0, 4)), (r.rain_season_mm / r.rain_season_normal_mm) * 100);
  const rain = seasonRain.get(year) ?? null;
  // Mean June–September weekly use, for years whose summer is complete in the record.
  const summerUse = new Map<number, number>();
  for (const y of new Set(reports.map((r) => Number(r.report_date.slice(0, 4))))) {
    const v = inYear(y)
      .filter((r) => r.report_date.slice(5, 7) >= "06" && r.report_date.slice(5, 7) <= "09")
      .map((r) => r.demand_week_mld)
      .filter((d): d is number => d !== null);
    if (v.length >= 12) summerUse.set(y, v.reduce((a, b) => a + b, 0) / v.length);
  }
  const use = summerUse.get(year);
  return {
    springPeakPct,
    rainPctOfNormal: rain === null ? null : round(rain),
    driestRain: rain !== null && rain <= Math.min(...seasonRain.values()),
    highestSummerUse: use !== undefined && use >= Math.max(...summerUse.values()),
  };
}

export function buildDashboard(db: Database, today = isoToday()) {
  const allReports = loadReports(db);
  // RULE: the headline is the whole system (Sooke + Goldstream). Every validated report has a
  // total; one without could not be placed on the same scale, so it is left out of the charts.
  const reports = allReports.filter((r) => totalOf(r) !== null);
  const latest = reports.at(-1);
  if (!latest) return null;
  const prev = reports.at(-2) ?? latest;
  const watershedRows = loadWeather(db, "watershed");
  // The model needs the weather history; until the first weather ingest lands there is no dashboard.
  if (watershedRows.length < 730) return null;
  const watershed = toModelWeather(watershedRows);
  const forecast = loadWeather(db, "forecast");
  const city = loadWeather(db, "city");
  const currentYear = Number(latest.report_date.slice(0, 4));
  const latestDay = dayNum(latest.report_date);
  const latestTotal = totalOf(latest) as number;
  const latestPct = tpct(latestTotal);

  // ── Seasonal envelope: whole-system % by day of year across all complete past years ──────
  const byYear = new Map<number, { date: string; v: number }[]>();
  for (const r of reports) {
    const y = Number(r.report_date.slice(0, 4));
    byYear.set(y, [...(byYear.get(y) ?? []), { date: r.report_date, v: tpct(totalOf(r) as number) }]);
  }
  const daily = dailyInterpolate(reports.map((r) => ({ date: r.report_date, v: tpct(totalOf(r) as number) })));
  const envelopeValues: number[][] = Array.from({ length: 366 }, () => []);
  const pastYears = [...byYear.keys()].filter((y) => y < currentYear).sort();
  const latestDoy = doy(latest.report_date);
  const sameDateByYear = new Map<number, number>();
  for (const [d, v] of daily) {
    const iso = isoOf(d);
    const y = Number(iso.slice(0, 4));
    if (y >= currentYear) continue;
    const k = doy(iso);
    (envelopeValues[k] as number[]).push(v);
    if (k === latestDoy) sameDateByYear.set(y, round(v));
  }
  const envelope = {
    min: [] as number[],
    p25: [] as number[],
    median: [] as number[],
    p75: [] as number[],
    max: [] as number[],
  };
  for (let k = 1; k <= 365; k++) {
    const s = (envelopeValues[k] as number[]).slice().sort((a, b) => a - b);
    envelope.min.push(round(quantile(s, 0)));
    envelope.p25.push(round(quantile(s, 0.25)));
    envelope.median.push(round(quantile(s, 0.5)));
    envelope.p75.push(round(quantile(s, 0.75)));
    envelope.max.push(round(quantile(s, 1)));
  }
  // Gentle circular smoothing (±4 days) so years entering/leaving coverage don't leave steps.
  for (const key of Object.keys(envelope) as (keyof typeof envelope)[]) {
    const raw = envelope[key];
    envelope[key] = raw.map((_, i) => {
      const w: number[] = [];
      for (let j = -4; j <= 4; j++) {
        const v = raw[(i + j + 365) % 365] as number;
        if (Number.isFinite(v)) w.push(v);
      }
      return w.length ? round(mean(w)) : (raw[i] as number);
    });
  }
  const yearSeries: Record<string, [number, number][]> = {};
  for (const [y, pts] of byYear) yearSeries[y] = pts.map((p) => [doy(p.date), p.v]);

  const sameDate = [...sameDateByYear].map(([year, pct]) => ({ year, pct })).sort((a, b) => a.year - b.year);
  const sameDay = sameDate.map((s) => s.pct).sort((a, b) => a - b);
  // Mid-rank with a small tolerance: many past years sit at exactly 100%, and a full system must
  // never rank "below normal" against other full years.
  const below = sameDay.filter((v) => v < latestPct - 0.5).length;
  const equal = sameDay.filter((v) => Math.abs(v - latestPct) <= 0.5).length;
  const percentile = sameDay.length ? (below + 0.5 * equal) / sameDay.length : 0.5;
  const lastYearPct = daily.get(latestDay - 365) ?? null;
  const recordLow = sameDate.reduce<(typeof sameDate)[number] | null>((m, s) => (!m || s.pct < m.pct ? s : m), null);
  const recordHigh = sameDate.reduce<(typeof sameDate)[number] | null>((m, s) => (!m || s.pct > m.pct ? s : m), null);

  // ── Model calibration on every report pair with weather coverage (Sooke Lake) ────────────
  // RULE: the water-balance model describes Sooke Lake only; Goldstream is added to it from its
  // own typical seasonal path wherever a whole-system number is shown.
  const intervals = calibrationIntervals(allReports, CAPACITY_ML.sooke);
  const firstReport = allReports[0] as ReportRow;
  const calStart = isoOf(dayNum(firstReport.report_date) - 400);
  const calWeather = watershed.filter((d) => d.date >= calStart);
  const calibration: Calibration = calibrate(calWeather, intervals);
  const params: Params = calibration.params;
  const bias = monthlyBias(calWeather, intervals, params);
  /** One day of bias-corrected net inflow to Sooke Lake (ML). */
  const step = (state: State, day: WeatherDay) =>
    stepWatershed(state, day, params) + (bias[Number(day.date.slice(5, 7)) - 1] as number);

  // Watershed state on every day (to restart scenarios mid-stream).
  const states = new Map<number, State>();
  const actualInflow = new Map<number, number>();
  {
    const state: State = { soil: params.smax * 0.5, snow: 0 };
    for (const d of watershed) {
      actualInflow.set(dayNum(d.date), step(state, d));
      states.set(dayNum(d.date), { ...state });
    }
  }
  const demandOf = demandProfile(reports, currentYear);

  // Goldstream: the median change from a given day of year in past years, so it can ride along
  // with a Sooke Lake scenario. It is a small, operated backup system — typical behaviour is the
  // honest assumption, not a weather model.
  const dailyGold = dailyInterpolate(
    reports.filter((r) => r.goldstream_ml !== null).map((r) => ({ date: r.report_date, v: r.goldstream_ml as number })),
  );
  const goldPath = (startDay: number, startMl: number, n: number) => {
    const deltas: number[][] = Array.from({ length: n }, () => []);
    for (let k = 1; k <= 60; k++) {
      const base = dailyGold.get(startDay - 365 * k);
      if (base === undefined) continue;
      for (let i = 0; i < n; i++) {
        const v = dailyGold.get(startDay - 365 * k + i + 1);
        if (v !== undefined) (deltas[i] as number[]).push(v - base);
      }
    }
    return deltas.map((ds) => {
      const dv = ds.length
        ? quantile(
            ds.sort((a, b) => a - b),
            0.5,
          )
        : 0;
      return Math.min(CAPACITY_ML.goldstream, Math.max(0, startMl + dv));
    });
  };

  // Daily climatology of temperature (normals period) for the no-rain scenario.
  const tClim = new Map<number, { tmax: number[]; tmin: number[] }>();
  for (const d of watershed) {
    const y = Number(d.date.slice(0, 4));
    if (y < NORMALS.from || y > NORMALS.to) continue;
    const k = doy(d.date);
    const e = tClim.get(k) ?? { tmax: [], tmin: [] };
    e.tmax.push(d.tmax);
    e.tmin.push(d.tmin);
    tClim.set(k, e);
  }
  const climDay = (iso: string): WeatherDay => {
    const e = tClim.get(doy(iso));
    const tmax = e ? mean(e.tmax) : 12;
    const tmin = e ? mean(e.tmin) : 5;
    return { date: iso, precip: 0, tmax, tmin, tmean: (tmax + tmin) / 2 };
  };

  // ── Outlook: today's storage run forward under each past year's weather ──────────────────
  const DISPLAY_DAYS = 270;
  const OUTLOOK_STEP = 2;
  const refillBy = `${Number(latest.report_date.slice(5, 7)) >= 5 ? currentYear + 1 : currentYear}-05-01`;
  const refillIdx = dayNum(refillBy) - latestDay - 1;
  // Simulate at least to May 1 so "chance full by May 1" is never cut short in summer.
  const HORIZON = Math.max(DISPLAY_DAYS, refillIdx + 1);
  const wxByDay = new Map(watershed.map((d) => [dayNum(d.date), d]));
  const forecastByDay = new Map(toModelWeather(forecast).map((d) => [dayNum(d.date), d]));
  const todayDay = dayNum(today);
  // TRAP: a 10-day rain forecast is not certain. Treating all of it as known in every scenario
  // collapses the fan for weeks. The first few (most skilful) days are taken as given; after
  // that each day blends the forecast with the past year's weather, fading to the past year alone.
  const forecastWeight = (d: number) => {
    const k = d - todayDay;
    return k < FORECAST_TRUST_DAYS ? 1 : Math.max(0, 1 - (k - FORECAST_TRUST_DAYS + 1) / FORECAST_FADE_DAYS);
  };
  const weatherOn = (d: number, analog: WeatherDay): WeatherDay => {
    if (d < todayDay) return wxByDay.get(d) ?? analog;
    const fc = forecastByDay.get(d);
    const w = fc ? forecastWeight(d) : 0;
    if (!fc || w <= 0) return analog;
    const mix = (a: number, b: number) => w * a + (1 - w) * b;
    return {
      date: analog.date,
      precip: mix(fc.precip, analog.precip),
      tmax: mix(fc.tmax, analog.tmax),
      tmin: mix(fc.tmin, analog.tmin),
      tmean: mix(fc.tmean, analog.tmean),
    };
  };
  const startState = states.get(latestDay) ?? { soil: params.smax * 0.5, snow: 0 };
  const lastWeatherYear = Number((watershed.at(-1) as WeatherDay).date.slice(0, 4));
  const scenarioYears: number[] = [];
  for (let y = 1980; y <= lastWeatherYear - 1; y++) {
    if (wxByDay.has(dayNum(`${y}-01-01`) + (latestDay - dayNum(`${currentYear}-01-01`)) + HORIZON))
      scenarioYears.push(y);
  }
  const yearShift = (y: number) => dayNum(`${currentYear}-01-01`) - dayNum(`${y}-01-01`);
  const runScenario = (dayFor: (d: number) => WeatherDay | undefined) => {
    const state = { ...startState };
    const inflows: number[] = [];
    for (let i = 1; i <= HORIZON; i++) {
      const d = latestDay + i;
      const w = weatherOn(d, { ...(dayFor(d) ?? climDay(isoOf(d))), date: isoOf(d) });
      inflows.push(step(state, { ...w, date: isoOf(d) }));
    }
    return simulateStorage(latest.sooke_ml, inflows, (i) => demandOf(isoOf(latestDay + i + 1)), CAPACITY_ML.sooke);
  };
  const scenarios = scenarioYears.map((y) => ({
    year: y,
    storage: runScenario((d) => wxByDay.get(d - yearShift(y))),
  }));
  const goldAhead = goldPath(latestDay, latest.goldstream_ml ?? latestTotal - latest.sooke_ml, HORIZON);
  const raw = {
    p10: [] as number[],
    p25: [] as number[],
    p50: [] as number[],
    p75: [] as number[],
    p90: [] as number[],
  };
  for (let i = 0; i < DISPLAY_DAYS; i++) {
    const g = goldAhead[i] as number;
    const vals = scenarios.map((s) => (s.storage[i] as number) + g).sort((a, b) => a - b);
    raw.p10.push(tpct(quantile(vals, 0.1)));
    raw.p25.push(tpct(quantile(vals, 0.25)));
    raw.p50.push(tpct(quantile(vals, 0.5)));
    raw.p75.push(tpct(quantile(vals, 0.75)));
    raw.p90.push(tpct(quantile(vals, 0.9)));
  }
  // Light 7-day smoothing of the percentile curves (each day's quantiles are noisy), keeping the
  // first days (anchored to today's reading) as they are; then thinned to every other day.
  const outlook = { start: isoOf(latestDay + 1), step: OUTLOOK_STEP } as {
    start: string;
    step: number;
  } & Record<keyof typeof raw, number[]>;
  for (const key of Object.keys(raw) as (keyof typeof raw)[]) {
    const r = raw[key];
    outlook[key] = r
      .map((_, i) => (i < 3 ? (r[i] as number) : round(mean(r.slice(Math.max(0, i - 3), Math.min(r.length, i + 4))))))
      .filter((_, i) => i % OUTLOOK_STEP === 0);
  }
  // RULE: "full" means the whole system at FULL_PCT or more, the same test History uses.
  // "Full again" is after this year's summer drawdown: when May 1 is next year, only count full
  // days from October 1 on.
  const searchFrom =
    refillBy.slice(0, 4) === String(currentYear) ? 0 : Math.max(0, dayNum(`${currentYear}-10-01`) - latestDay - 1);
  const fullAt = (s: number[], until = s.length) => {
    const i = s
      .slice(searchFrom, until)
      .findIndex((v, k) => v + (goldAhead[k + searchFrom] as number) >= (CAPACITY_ML.total * FULL_PCT) / 100);
    return i < 0 ? -1 : i + searchFrom;
  };
  const refillDays = scenarios.map((s) => fullAt(s.storage, refillIdx + 1)).filter((i) => i >= 0);
  const refillProbability = scenarios.length ? refillDays.length / scenarios.length : 0;
  const allFull = scenarios
    .map((s) => fullAt(s.storage))
    .map((i) => (i < 0 ? Number.POSITIVE_INFINITY : i))
    .sort((a, b) => a - b);
  const medianFullIdx = quantile(allFull, 0.5);
  const fullNow = latestPct >= FULL_PCT;
  const medianRefillDate =
    !fullNow && Number.isFinite(medianFullIdx) ? isoOf(latestDay + Math.round(medianFullIdx) + 1) : null;
  // The middle half of refill dates across past years' weather.
  const refillAt = (q: number) => {
    const i = quantile(allFull, q);
    return !fullNow && Number.isFinite(i) ? isoOf(latestDay + Math.round(i) + 1) : null;
  };
  const refillRange = { early: refillAt(0.25), late: refillAt(0.75) };
  const lowestAheadIdx = raw.p50.reduce((m, v, i) => (v < (raw.p50[m] as number) ? i : m), 0);

  // ── Days of supply if it never rained again (whole system: Sooke + Goldstream) ───────────
  let daysNoRain = 0;
  {
    const state = { ...startState };
    let s = latestTotal;
    while (s > 0 && daysNoRain < 365 * 4) {
      const iso = isoOf(latestDay + daysNoRain + 1);
      s += step(state, climDay(iso)) - demandOf(iso);
      daysNoRain++;
    }
  }
  const simpleDays = latest.demand_week_mld ? Math.round(latestTotal / latest.demand_week_mld) : null;

  // ── Weather effect: the past 12 months as they happened vs the same start under each
  //    normal-period year's weather (actual demand in both, so only the weather differs) ─────
  const seasonStartReport = reports.find((r) => r.report_date >= isoOf(latestDay - 365)) ?? latest;
  const adjStart = dayNum(seasonStartReport.report_date);
  const adjDays = latestDay - adjStart;
  const actualDemand = dailyInterpolate(
    reports
      .filter((r) => r.demand_week_mld !== null)
      .map((r) => ({ date: r.report_date, v: r.demand_week_mld as number })),
  );
  const adjDemand = (i: number) => actualDemand.get(adjStart + i + 1) ?? demandOf(isoOf(adjStart + i + 1));
  const adjState = states.get(adjStart) ?? { soil: params.smax * 0.5, snow: 0 };
  const adjEnds: number[] = [];
  if (adjDays > 0) {
    const startYear = Number(seasonStartReport.report_date.slice(0, 4));
    for (let y = NORMALS.from; y <= Math.min(NORMALS.to + 5, lastWeatherYear - 1); y++) {
      if (y === startYear) continue; // that would be the actual weather
      const shift = dayNum(`${startYear}-01-01`) - dayNum(`${y}-01-01`);
      const state = { ...adjState };
      const inflows: number[] = [];
      for (let i = 1; i <= adjDays; i++) {
        const w = wxByDay.get(adjStart + i - shift);
        if (!w) break;
        inflows.push(step(state, { ...w, date: isoOf(adjStart + i) }));
      }
      if (inflows.length === adjDays)
        adjEnds.push(
          simulateStorage(seasonStartReport.sooke_ml, inflows, adjDemand, CAPACITY_ML.sooke).at(-1) as number,
        );
    }
  }
  const adjusted = {
    startDate: seasonStartReport.report_date,
    years: adjEnds.length,
    impactMl: null as number | null,
    impactPts: null as number | null,
  };
  if (adjEnds.length && adjDays > 0) {
    const inflows: number[] = [];
    for (let i = 1; i <= adjDays; i++) inflows.push(actualInflow.get(adjStart + i) ?? 0);
    const modelledEnd = simulateStorage(seasonStartReport.sooke_ml, inflows, adjDemand, CAPACITY_ML.sooke).at(
      -1,
    ) as number;
    const typical = quantile(
      adjEnds.sort((a, b) => a - b),
      0.5,
    );
    // Model vs model, so the model's own bias cancels out of the weather effect.
    adjusted.impactMl = Math.round(modelledEnd - typical);
    adjusted.impactPts = round((adjusted.impactMl / CAPACITY_ML.total) * 100, 1);
  }

  // ── Water use, and the model's estimate of what flows in ──────────────────────────────────
  const reportsByYear = new Map<number, ReportRow[]>();
  for (const r of reports) {
    if (r.demand_week_mld === null) continue;
    const y = Number(r.report_date.slice(0, 4));
    reportsByYear.set(y, [...(reportsByYear.get(y) ?? []), r]);
  }
  const demandYears: {
    year: number;
    avgMld: number;
    ytdMld: number | null;
    useMl: number;
    inflowMl: number | null;
    /** Average estimated inflow to Sooke Lake per day (ML/day), same days as use. */
    inflowMld: number | null;
    peakWeekMld: number;
    summerMld: number | null;
    /** July 1 population of the municipalities served, and use per person (litres a day). */
    population: number | null;
    perPersonL: number | null;
    partial: boolean;
  }[] = [];
  const people = new Map(
    (
      db.query("SELECT year, sum(persons) AS p FROM population GROUP BY year").all() as { year: number; p: number }[]
    ).map((r) => [r.year, r.p]),
  );
  const minYtdReports = Math.floor((latestDoy / 7) * 0.75);
  for (const [year, rows] of [...reportsByYear].sort((a, b) => a[0] - b[0])) {
    const vals = rows.map((r) => r.demand_week_mld as number);
    const ytd = rows.filter((r) => doy(r.report_date) <= latestDoy).map((r) => r.demand_week_mld as number);
    const summer = rows
      .filter((r) => ["06", "07", "08"].includes(r.report_date.slice(5, 7)))
      .map((r) => r.demand_week_mld as number);
    const partial = year === currentYear || rows.length < 40;
    const avg = mean(vals);
    // Days counted: the whole year, or Jan 1 → latest report for the current year.
    const from = dayNum(`${year}-01-01`);
    const to = year === currentYear ? latestDay : dayNum(`${year}-12-31`);
    let inflow = 0;
    let covered = 0;
    for (let d = from; d <= to; d++) {
      const v = actualInflow.get(d);
      if (v === undefined) continue;
      inflow += v;
      covered++;
    }
    demandYears.push({
      year,
      avgMld: round(avg),
      ytdMld: ytd.length >= minYtdReports && minYtdReports > 0 ? round(mean(ytd)) : null,
      useMl: Math.round(avg * (to - from + 1)),
      inflowMl: covered >= (to - from + 1) * 0.95 ? Math.round(inflow) : null,
      inflowMld: covered >= (to - from + 1) * 0.95 ? round(inflow / covered) : null,
      peakWeekMld: round(Math.max(...vals)),
      summerMld: summer.length ? round(mean(summer)) : null,
      population: people.get(year) ?? null,
      perPersonL: people.has(year) ? Math.round((avg * 1e6) / (people.get(year) as number)) : null,
      partial,
    });
  }
  const demandEnvelope = { p10: [] as number[], median: [] as number[], p90: [] as number[] };
  {
    const byDoy: number[][] = Array.from({ length: 366 }, () => []);
    const pts = reports.filter((r) => r.demand_week_mld !== null && Number(r.report_date.slice(0, 4)) < currentYear);
    for (const [d, v] of dailyInterpolate(pts.map((r) => ({ date: r.report_date, v: r.demand_week_mld as number })))) {
      (byDoy[doy(isoOf(d))] as number[]).push(v);
    }
    for (let k = 1; k <= 365; k++) {
      const s = (byDoy[k] as number[]).slice().sort((a, b) => a - b);
      demandEnvelope.p10.push(round(quantile(s, 0.1)));
      demandEnvelope.median.push(round(quantile(s, 0.5)));
      demandEnvelope.p90.push(round(quantile(s, 0.9)));
    }
  }
  const demandSeries: Record<string, [number, number][]> = {};
  for (const [y, rows] of reportsByYear)
    demandSeries[y] = rows.map((r) => [doy(r.report_date), r.demand_week_mld as number]);
  // Summer (Jun–Aug) vs winter (Dec–Feb) from the recent demand profile.
  const profileMean = (months: number[]) =>
    mean(
      Array.from({ length: 365 }, (_, i) => isoOf(dayNum("2025-01-01") + i))
        .filter((iso) => months.includes(Number(iso.slice(5, 7))))
        .map(demandOf),
    );
  const summerMld = profileMean([6, 7, 8]);
  const winterMld = profileMean([12, 1, 2]);
  const completeUse = demandYears.filter((y) => !y.partial);
  const pick = (better: (a: number, b: number) => boolean) =>
    completeUse.reduce<(typeof completeUse)[number] | null>((m, y) => (!m || better(y.avgMld, m.avgMld) ? y : m), null);
  const highestUse = pick((a, b) => a > b);
  const lowestUse = pick((a, b) => a < b);
  const withInflow = completeUse.filter((y) => y.inflowMl !== null);
  const inflowShare = withInflow.length
    ? round(mean(withInflow.map((y) => y.useMl / (y.inflowMl as number))), 2)
    : null;

  // Measured trend in use: least-squares growth of average daily use over complete years. When
  // use fell first and then rose (it did, 2009 → 2013 → now), the trend is taken from the low.
  const trendOf = (ys: { year: number; avgMld: number }[]) => {
    if (ys.length < 4) return null;
    const mx = mean(ys.map((y) => y.year));
    const my = mean(ys.map((y) => Math.log(y.avgMld)));
    const num = ys.reduce((acc, y) => acc + (y.year - mx) * (Math.log(y.avgMld) - my), 0);
    const den = ys.reduce((acc, y) => acc + (y.year - mx) ** 2, 0);
    if (!den) return null;
    const slope = num / den;
    return { pctPerYear: (Math.exp(slope) - 1) * 100, at: (year: number) => Math.exp(my + slope * (year - mx)) };
  };
  const firstUse = completeUse[0];
  const lastUse = completeUse.at(-1);
  const useTrend = (() => {
    if (!firstUse || !lastUse || !lowestUse) return null;
    const fellPct = ((firstUse.avgMld - lowestUse.avgMld) / firstUse.avgMld) * 100;
    const fromLow = lowestUse.year - firstUse.year >= 2 && fellPct >= 5 && lastUse.year - lowestUse.year >= 4;
    const from = fromLow ? lowestUse.year : firstUse.year;
    const fit = trendOf(completeUse.filter((y) => y.year >= from));
    if (fit === null) return null;
    const pctPerYear = fit.pctPerYear;
    return {
      firstYear: firstUse.year,
      lastYear: lastUse.year,
      fromYear: from,
      fellFirstPct: fromLow ? round(fellPct, 0) : null,
      pctPerYear: round(pctPerYear, 2),
      changeSinceFirstPct: round(((lastUse.avgMld - firstUse.avgMld) / firstUse.avgMld) * 100, 1),
      /** The fitted trend (average ML/day) at its first and last year, for drawing. */
      line: [
        [from, round(fit.at(from))],
        [lastUse.year, round(fit.at(lastUse.year))],
      ] as [number, number][],
    };
  })();
  // Use per person and population over the same years as the use trend (complete years with both).
  const perPerson = (() => {
    if (!useTrend) return null;
    const ys = completeUse.filter((y) => y.year >= useTrend.fromYear && y.perPersonL !== null);
    const pp = trendOf(ys.map((y) => ({ year: y.year, avgMld: y.perPersonL as number })));
    const pop = trendOf(ys.map((y) => ({ year: y.year, avgMld: y.population as number })));
    const withPop = completeUse.filter((y) => y.perPersonL !== null);
    const first = withPop[0];
    const last = withPop.at(-1);
    if (!pp || !pop || !first || !last) return null;
    return {
      pctPerYear: round(pp.pctPerYear, 2),
      populationPctPerYear: round(pop.pctPerYear, 2),
      first: { year: first.year, litres: first.perPersonL as number },
      last: { year: last.year, litres: last.perPersonL as number, population: last.population as number },
    };
  })();
  const growthPerYear = Math.max(0, (useTrend?.pctPerYear ?? 0) / 100);
  // This year against a typical year, day by day (Jan 1 → latest), and how much of the summer ran above typical.
  const useVsTypical = (() => {
    let actual = 0;
    let typical = 0;
    let summerDays = 0;
    let summerAbove = 0;
    for (let d = dayNum(`${currentYear}-01-01`); d <= latestDay; d++) {
      const a = actualDemand.get(d);
      const t = demandEnvelope.median[doy(isoOf(d)) - 1];
      if (a === undefined || t === undefined) continue;
      actual += a;
      typical += t;
      if (["06", "07", "08"].includes(isoOf(d).slice(5, 7))) {
        summerDays++;
        if (a > t) summerAbove++;
      }
    }
    return {
      ytdPct: typical > 0 ? round((actual / typical - 1) * 100) : null,
      summerAboveShare: summerDays >= 80 ? round(summerAbove / summerDays, 2) : null,
      weekTypicalMld: demandEnvelope.median[latestDoy - 1] ?? null,
    };
  })();

  // ── Why storage differs from typical, by water balance since the system was last full:
  //    gap now = gap then + (our change − typical change); the use part is measured demand above
  //    the typical demand for each day, and the rest is water that did (not) flow in — rain and
  //    runoff net of evaporation. All in percent of whole-system capacity.
  let fromDay = latestDay - 365;
  for (const r of reports) {
    const d = dayNum(r.report_date);
    if (d > fromDay && d < latestDay && tpct(totalOf(r) as number) >= FULL_PCT) fromDay = d;
  }
  let extraUseMl = 0;
  for (let d = fromDay + 1; d <= latestDay; d++) {
    const actual = actualDemand.get(d);
    const typical = demandEnvelope.median[doy(isoOf(d)) - 1];
    if (actual !== undefined && typical !== undefined) extraUseMl += actual - typical;
  }
  const typicalOn = (d: number) => envelope.median[doy(isoOf(d)) - 1];
  const why = (() => {
    const levelThen = daily.get(fromDay);
    const typThen = typicalOn(fromDay);
    const typNow = typicalOn(latestDay);
    if (levelThen === undefined || typThen === undefined || typNow === undefined) return null;
    const gap = latestPct - typNow;
    const startGap = levelThen - typThen;
    const usePct = (-extraUseMl / CAPACITY_ML.total) * 100;
    return {
      since: isoOf(fromDay),
      sinceFull: fromDay > latestDay - 365,
      gapPct: round(gap),
      startPct: round(startGap),
      usePct: round(usePct),
      inflowPct: round(gap - startGap - usePct),
    };
  })();

  // ── Dry-year test (measured): every summer since the first report, replayed from a typical
  //    May 1 level at today's use (the last 12 months), then with use growing at the CRD's
  //    reported rate until a summer like the worst one would take the system below 50% ─────────
  // TRAP: the water-balance model under-predicts some summers' drawdown by 3–8 points (e.g. this
  // one), so this test uses the measured levels; the model would contradict what people can see.
  const recentUse = new Map<number, number>();
  for (let d = latestDay - 364; d <= latestDay; d++) {
    const v = actualDemand.get(d);
    if (v !== undefined) recentUse.set(doy(isoOf(d)), v);
  }
  const dryFrom = dayNum(`${currentYear}-05-01`);
  const todayCum: number[] = [];
  for (let i = 0, c = 0; i < DRY_DAYS; i++) {
    const iso = isoOf(dryFrom + i);
    c += recentUse.get(doy(iso)) ?? demandOf(iso);
    todayCum.push(c);
  }
  const summers: { year: number; drop: number[] }[] = [];
  const mayLevels: number[] = [];
  for (const y of [...byYear.keys()].sort()) {
    const from = dayNum(`${y}-05-01`);
    const start = daily.get(from);
    if (start === undefined) continue;
    if (y < currentYear) mayLevels.push(start);
    const end = Math.min(from + DRY_DAYS - 1, latestDay);
    if (end - from < 120) continue;
    // Points below the May 1 level, adjusted for the difference between that year's use and today's.
    const drop: number[] = [];
    let used = 0;
    for (let d = from; d <= end; d++) {
      const v = daily.get(d);
      const u = actualDemand.get(d);
      if (v === undefined || u === undefined) break;
      used += u;
      drop.push(start - v + (((todayCum[d - from] as number) - used) / CAPACITY_ML.total) * 100);
    }
    if (drop.length === end - from + 1) summers.push({ year: y, drop });
  }
  const dryYear = (() => {
    if (summers.length < 5 || !mayLevels.length) return null;
    const startPct = round(
      quantile(
        mayLevels.sort((a, b) => a - b),
        0.5,
      ),
    );
    const lowOf = (s: (typeof summers)[number], factor: number) => {
      let idx = 0;
      let low = Number.POSITIVE_INFINITY;
      s.drop.forEach((dp, i) => {
        const v = startPct - dp - (((todayCum[i] as number) * (factor - 1)) / CAPACITY_ML.total) * 100;
        if (v < low) [low, idx] = [v, i];
      });
      return { low, idx };
    };
    const worstAt = (factor: number) =>
      summers.map((s) => ({ s, ...lowOf(s, factor) })).reduce((m, r) => (r.low < m.low ? r : m));
    const worst = worstAt(1);
    let below: { year: number; weatherYear: number; low: number } | null = null;
    // With no measured growth there is nothing to project: "today's use" is the whole story.
    for (let y = currentYear + 1; growthPerYear > 0.001 && y <= currentYear + DRY_SEARCH_YEARS && !below; y++) {
      const w = worstAt((1 + growthPerYear) ** (y - currentYear));
      if (w.low < DRY_THRESHOLD_PCT) below = { year: y, weatherYear: w.s.year, low: w.low };
    }
    return {
      start: isoOf(dryFrom),
      startPct,
      thresholdPct: DRY_THRESHOLD_PCT,
      growthPctPerYear: round(growthPerYear * 100, 2),
      growthFromYear: useTrend?.fromYear ?? null,
      searchedTo: currentYear + DRY_SEARCH_YEARS,
      firstYear: (summers[0] as (typeof summers)[number]).year,
      summers: summers.length,
      /** Each summer's low at today's use. */
      lows: summers.map((s) => ({ year: s.year, lowPct: round(lowOf(s, 1).low) })),
      worst: {
        year: worst.s.year,
        lowPct: round(worst.low),
        lowDate: isoOf(dryFrom + worst.idx),
        partial: worst.s.year === currentYear && worst.s.drop.length < DRY_DAYS,
      },
      below: below && { year: below.year, weatherYear: below.weatherYear, lowPct: round(below.low) },
    };
  })();

  // ── Rain since Sep 1: Sooke Lake (the CRD's gauge) and the city (Victoria Gonzales) ───────
  const lake = lakeRain(reports, latest.report_date);
  const cityRainSeason = cityRain(city, latest.report_date, NORMALS);

  // ── Monthly temperature in the city vs the 1991–2020 normals (the years the station has) ──
  const monthly = (rows: WxRow[], field: "precip" | "tmean", agg: "sum" | "mean") => {
    const byMonth = new Map<string, number[]>();
    for (const r of rows) {
      const v =
        field === "tmean" ? (r.tmean ?? (r.tmax !== null && r.tmin !== null ? (r.tmax + r.tmin) / 2 : null)) : r[field];
      if (v === null) continue;
      const k = r.date.slice(0, 7);
      byMonth.set(k, [...(byMonth.get(k) ?? []), v]);
    }
    const value = (xs: number[]) => (agg === "sum" ? xs.reduce((s, x) => s + x, 0) : mean(xs));
    const normals: number[] = [];
    const years = new Set<number>();
    for (let m = 1; m <= 12; m++) {
      const vals: number[] = [];
      for (let y = NORMALS.from; y <= NORMALS.to; y++) {
        const xs = byMonth.get(`${y}-${String(m).padStart(2, "0")}`);
        if (xs && xs.length >= 25) {
          vals.push(value(xs));
          years.add(y);
        }
      }
      normals.push(mean(vals));
    }
    // The years the normals actually rest on (a station can miss part of the normal period).
    const span = years.size ? { from: Math.min(...years), to: Math.max(...years) } : { ...NORMALS };
    return { byMonth, value, normals, span };
  };
  const cityT = monthly(city, "tmean", "mean");
  const months: { month: string; tmean: number | null; tmeanNormal: number; partial: boolean }[] = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const ct = cityT.byMonth.get(key);
    months.push({
      month: key,
      // A month counts once at least 25 of its days are in (a partial current month shows so far).
      tmean: ct && (i === 0 || ct.length >= 25) ? round(cityT.value(ct), 1) : null,
      tmeanNormal: round(cityT.normals[d.getUTCMonth()] as number, 1),
      partial: i === 0,
    });
  }

  // Lake rain over the same window as the "why" line (since the system was last full), vs the
  // CRD's normal for the same days.
  const rainSince = (() => {
    if (!why || latestDay - dayNum(why.since) < 30) return null;
    const r = lakeRainBetween(reports, why.since, latest.report_date);
    return r && r.normalMm > 0 ? { since: why.since, ...r } : null;
  })();
  // The warm spell behind this year's extra use: the longest run of April–September months at
  // least 1 °C warmer than normal (Victoria Gonzales). Named only when there is one.
  const WARM_DEG = 1;
  const warmMonths = (() => {
    let best: string[] = [];
    let run: string[] = [];
    for (let m = 4; m <= 9; m++) {
      const row = months.find((x) => x.month === `${currentYear}-${String(m).padStart(2, "0")}`);
      const warm = row && !row.partial && row.tmean !== null && row.tmean - row.tmeanNormal >= WARM_DEG;
      run = warm ? [...run, `${currentYear}-${String(m).padStart(2, "0")}-01`] : [];
      if (run.length > best.length) best = run;
    }
    return best;
  })();
  // ── History: how high did each spring's refill reach (Jan–Jun peak)? A spring only counts
  //    when the record covers the refill season before it (from the previous November).
  const firstDay = dayNum((reports[0] as ReportRow).report_date);
  const springs: { year: number; peakPct: number }[] = [];
  for (const [y, pts] of [...byYear].sort((a, b) => a[0] - b[0])) {
    if (firstDay > dayNum(`${y - 1}-11-01`)) continue;
    const spring = pts.filter((p) => p.date.slice(5, 7) <= "06");
    if (spring.length < 15) continue;
    springs.push({ year: y, peakPct: round(Math.max(...spring.map((p) => p.v))) });
  }

  // ── Health: the headline answers the season's question (see verdict in story.ts) ──────────
  // The usual refill date: the median first day at FULL_PCT from October 1 in each past refill
  // season the record covers, placed in this refill season.
  const seasonStart = (y: number) => dayNum(`${y}-10-01`);
  const thisSeason = seasonStart(latest.report_date.slice(5, 7) >= "07" ? currentYear : currentYear - 1);
  const refillOffsets: number[] = [];
  for (let y = 2000; y < currentYear; y++) {
    const from = seasonStart(y - 1);
    if (!daily.has(from) || from + 365 > latestDay) continue;
    for (let d = from; d < dayNum(`${y}-07-01`); d++) {
      if ((daily.get(d) ?? 0) >= FULL_PCT) {
        refillOffsets.push(d - from);
        break;
      }
    }
  }
  const usualRefillDate = refillOffsets.length
    ? isoOf(
        thisSeason +
          Math.round(
            quantile(
              [...refillOffsets].sort((a, b) => a - b),
              0.5,
            ),
          ),
      )
    : null;
  const allTimeLow = reports
    .filter((r) => Number(r.report_date.slice(0, 4)) < currentYear)
    .reduce<{ pct: number; date: string } | null>((m, r) => {
      const v = tpct(totalOf(r) as number);
      return m === null || v < m.pct ? { pct: round(v), date: r.report_date } : m;
    }, null);
  const seasonalLabel =
    percentile >= 0.75
      ? "Above normal"
      : percentile >= 0.4
        ? "Normal"
        : percentile >= 0.15
          ? "Below normal"
          : "Well below normal";
  const provisional = pastYears.length < 8;

  const story = buildStory({
    date: latest.report_date,
    provisional,
    totalPct: latestPct,
    sameDate,
    fullPct: FULL_PCT,
    why,
    outlook: {
      fullNow,
      refillDate: medianRefillDate,
      refillEarly: refillRange.early,
      refillLate: refillRange.late,
      refillBy,
      refillProbability,
      in4WeeksPct: raw.p50[27] ?? latestPct,
      usualRefillDate,
      lowestAheadDryPct: Math.min(...raw.p10),
      lowestAheadPct: raw.p50[lowestAheadIdx] ?? latestPct,
      lowestAheadDate: isoOf(latestDay + lowestAheadIdx + 1),
    },
    rain: { season: lake ? { mm: lake.mm, normalMm: lake.normalMm } : null, since: rainSince },
    use: {
      currentYear,
      years: demandYears.map((y) => ({ year: y.year, avgMld: y.avgMld, ytdMld: y.ytdMld, partial: y.partial })),
      summerWinterRatio: winterMld > 0 ? round(summerMld / winterMld, 2) : null,
      trend: useTrend,
      perPersonPctPerYear: perPerson?.pctPerYear ?? null,
      firstDrop: useTrend?.fellFirstPct ? firstYearDrop(reports, watershedRows, useTrend.firstYear) : null,
      ytdVsTypicalPct: useVsTypical.ytdPct,
      summerAboveShare: useVsTypical.summerAboveShare,
      warmMonths,
    },
    dryYear: dryYear && {
      worstYear: dryYear.worst.year,
      worstPartial: dryYear.worst.partial,
      worstLowPct: dryYear.worst.lowPct,
      worstLowDate: dryYear.worst.lowDate,
      firstYear: dryYear.firstYear,
      summers: dryYear.summers,
      growthPctPerYear: dryYear.growthPctPerYear,
      growthFromYear: dryYear.growthFromYear,
      belowYear: dryYear.below?.year ?? null,
      belowWeatherYear: dryYear.below?.weatherYear ?? null,
      belowPct: DRY_THRESHOLD_PCT,
      searchedTo: dryYear.searchedTo,
    },
    recordLow: allTimeLow && { ...allTimeLow, ...lowYearContext(reports, Number(allTimeLow.date.slice(0, 4))) },
    history: {
      firstYear: springs[0]?.year ?? currentYear,
      springs: springs.length,
      refilled: springs.filter((s) => s.peakPct >= FULL_PCT).length,
      thresholdPct: FULL_PCT,
      lowest: springs.reduce<(typeof springs)[number] | null>((m, s) => (!m || s.peakPct < m.peakPct ? s : m), null),
    },
  });

  const longDate = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  // ── "How we know": coverage and how each
  //    number is made. RULE: sentences are built here; the page only renders them.
  const buildProof = () => {
    const provenance = buildProvenance(db, today);
    const n0 = (v: number) => v.toLocaleString("en-CA");
    const shortDate = (iso: string) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    // Weekly inflow, modelled vs measured (change in storage + use), for every calibration
    // interval: the model's typical weekly error, quoted in the outlook's method.
    let sse = 0;
    let weeks = 0;
    for (const iv of intervals) {
      const a = dayNum(iv.from);
      const b = dayNum(iv.to);
      if (a < dayNum(calStart) + 365) continue;
      let m = 0;
      let ok = true;
      for (let d = a + 1; d <= b; d++) {
        const v = actualInflow.get(d);
        if (v === undefined) ok = false;
        else m += v;
      }
      if (!ok) continue;
      sse += ((m - iv.observedNet) * (7 / (b - a))) ** 2;
      weeks++;
    }
    const errorPct = weeks ? round((Math.sqrt(sse / weeks) / CAPACITY_ML.total) * 100, 1) : null;

    const p = provenance;
    const weatherLine = (w: NonNullable<NonNullable<typeof p>["weather"]["watershed"]>) =>
      `${shortDate(w.first)} – ${shortDate(w.last)} · ${n0(w.days)} days, ${w.missingDays ? `${n0(w.missingDays)} missing` : "none missing"}`;
    const v = p?.validation;
    const unreadableMissing = v ? v.unreadable.filter((u) => !u.recovered).length : 0;
    // RULE: each name matches a sourceList() entry; the sources page joins them by name.
    const sources = p
      ? [
          {
            name: "CRD Water Watch",
            facts: [
              `${n0(p.reports.count)} weekly reports, ${shortDate(p.reports.first)} – ${shortDate(p.reports.latest)}`,
              `${n0(p.reports.fromCrd)} from crd.ca, ${n0(p.reports.fromArchive)} from the Internet Archive${p.reports.archiveYears ? ` (${p.reports.archiveYears[0]}–${p.reports.archiveYears[1]})` : ""}`,
              `${p.reports.missingWeeks} of ${n0(p.reports.weeks)} weeks have no report.${unreadableMissing ? ` ${unreadableMissing === 1 ? "One report can’t be read" : `${unreadableMissing} reports can’t be read`}, and` : ""} ${p.reports.missingWeeks - unreadableMissing} aren’t on crd.ca or in the archive.`,
            ],
          },
          ...(p.weather.watershed
            ? [
                {
                  name: "Open-Meteo",
                  facts: ["Used to run the water-balance model and the outlook.", weatherLine(p.weather.watershed)],
                },
              ]
            : []),
          ...(p.weather.city
            ? [
                {
                  name: "Environment and Climate Change Canada",
                  facts: [
                    "Used for city rain, the Temperature view and the warm-months note.",
                    weatherLine(p.weather.city),
                  ],
                },
              ]
            : []),
          ...(people.size
            ? [
                {
                  name: "Statistics Canada",
                  facts: [
                    "Used for use per person and the Population view.",
                    `July 1 estimates, ${Math.min(...people.keys())}–${Math.max(...people.keys())}: ${n0(people.get(Math.max(...people.keys())) as number)} people in the latest year.`,
                  ],
                },
              ]
            : []),
        ]
      : [];
    const t = useTrend;
    const dy = dryYear;
    const firstPast = pastYears[0] ?? currentYear;
    const methods = [
      {
        claim: "The status beside the level",
        how: `“Full” means ${FULL_PCT}% or more. “Refilling” means the outlook’s middle line rises over the next four weeks. It’s “late” if that line reaches full ${STATUS.lateWeeks} or more weeks after the usual date. “May not refill” means less than a 75% chance of being full by May 1, and “unlikely” means less than 50%. Otherwise the level is “drawing down”, and its expected low is compared with the record low${allTimeLow ? ` of ${Math.round(allTimeLow.pct)}% (${allTimeLow.date.slice(0, 4)})` : ""}. Within ${STATUS.nearRecordPct} points of the record is “heading low”. Below it is “heading for a record low”.`,
      },
      {
        claim: "Typical, highest and lowest for the date",
        how: `The middle, highest and lowest levels on this date in the ${sameDate.length} past years with reports (${firstPast}–${currentYear - 1}). Days between weekly reports are filled in along a straight line.`,
      },
      {
        claim: `“Full” means ${FULL_PCT}% or more`,
        how: `The whole system counts as full at ${FULL_PCT}% or more. Goldstream often tops out below its capacity, so a 99% test would miss winters when Sooke Lake spills.`,
      },
      {
        claim: "Outlook and refill dates",
        how: `A water-balance model turns rain and temperature at the watershed into water flowing into Sooke Lake, minus typical use. It runs today’s level forward through the weather of each of ${scenarios.length} past years (${scenarioYears[0]}–${scenarioYears.at(-1)}).${errorPct !== null ? ` Tested on ${n0(weeks)} past weeks, it is usually within ${errorPct}% of capacity of the real weekly change.` : ""} The first ${FORECAST_TRUST_DAYS} days of the weather forecast are used as is. The next ${FORECAST_FADE_DAYS} days blend into each past year’s weather.`,
      },
      {
        claim: `${Math.floor(daysNoRain / 30.44)} months if it never rained again`,
        how: `The same model with no rain, normal temperatures and typical use. The whole system would run dry in ${daysNoRain} days.`,
      },
      ...(why
        ? [
            {
              claim: "Why it’s below typical",
              how: `This compares the change since the reservoirs were last full (${longDate(why.since)}) with a typical year. The use part is measured use above typical for each day. The rest is water that did or didn’t flow in.${Math.abs(why.startPct) >= 0.5 ? ` “A ${why.startPct < 0 ? "lower" : "higher"} start” means the level was already ${Math.abs(Math.round(why.startPct))}% ${why.startPct < 0 ? "below" : "above"} typical that day.` : ""}`,
            },
          ]
        : []),
      ...(t
        ? [
            {
              claim: "Use trend",
              how: `A straight-line fit to average daily use for each full year from ${t.fromYear} to ${t.lastYear}. It starts in ${t.fromYear}, the low point after ${t.firstYear}.`,
            },
          ]
        : []),
      ...(dy
        ? [
            {
              claim: dy.below ? `Below 50% around ${dy.below.year}` : "Worst summer at today’s use",
              how: `Each May to December since ${dy.firstYear} is replayed from a typical May 1 level, at the last 12 months’ use. Then use grows ${round(dy.growthPctPerYear, 2)}% a year until one of those summers would take the reservoirs below 50%. It shows where the trend leads if nothing else changes.`,
            },
          ]
        : []),
      {
        claim: "Use per person",
        how: `Average use in each complete year, divided by the July 1 population of the ${Object.keys(POPULATION.areas).length} municipalities the regional supply serves (${Object.keys(POPULATION.areas).join(", ")}). The Juan de Fuca area and First Nations reserves, served in part, aren’t counted, and use includes businesses and institutions, so it is a little high per person. The current year has no estimate until Statistics Canada publishes it.`,
      },
      {
        claim: "Refills in History",
        how: "The highest level each spring (January to June), starting with the first spring whose refill season is in the record.",
      },
      {
        claim: "Why use fell after the first year",
        how: "Average weekly use from June to September (mostly watering) and from November to March (mostly indoor), in the record’s first year and the next. Summer heat and rain are from the Sooke Lake watershed station over the same months.",
      },
      {
        claim: "The lowest point in History",
        how: "What came before the lowest level in past years, from that year’s reports: the spring’s highest level, Sooke Lake rain from September to August against the CRD’s average, and average use from June to September, each compared with every other year in the reports.",
      },
      {
        claim: "Rain",
        how: `Sooke Lake rain comes from the CRD’s own gauge, as each Water Watch report gives it. That is the total since September 1 and the CRD’s long-term average for the same days. City rain is from ${CITY.name} over the same days, compared with its ${cityRainSeason ? `${cityRainSeason.normalFrom}–${cityRainSeason.normalTo}` : `${NORMALS.from}–${NORMALS.to}`} average for each day. Missing city days are counted, not filled in.`,
      },
    ];

    const headlines = {
      coverage: p
        ? `${n0(p.reports.count)} weekly reports since ${p.reports.first.slice(0, 4)}, covering ${Math.round((1 - p.reports.missingWeeks / p.reports.weeks) * 100)}% of weeks`
        : "Sources",
      downloadsNote: "Each weekly row has a source_url column linking to the CRD PDF it came from.",
    };
    return {
      provenance,
      headlines,
      sources,
      methods,
      downloads: DOWNLOADS,
      repoUrl: REPO_URL || null,
    };
  };

  const days = latestDay - dayNum(prev.report_date) || 7;
  const prevTotal = totalOf(prev) as number;
  return {
    generatedAt: new Date().toISOString(),
    capacity: CAPACITY_ML,
    story,
    latest: {
      date: latest.report_date,
      totalMl: latestTotal,
      totalPct: latestPct,
      sookeMl: latest.sooke_ml,
      sookePct: pct(latest.sooke_ml),
      goldstreamMl: latest.goldstream_ml,
      goldstreamPct:
        latest.goldstream_ml === null ? null : round((latest.goldstream_ml / CAPACITY_ML.goldstream) * 100),
      weekChangeMl: Math.round(((latestTotal - prevTotal) / days) * 7),
      weekChangePct: round(((latestPct - tpct(prevTotal)) / days) * 7, 1),
      prevDate: prev.report_date,
      prevPct: tpct(prevTotal),
      demandWeekMld: latest.demand_week_mld,
      demand5yrMld: latest.demand_5yr_mld,
      sourceUrl: latest.source_url,
    },
    health: {
      level: story.verdict.level ?? "good",
      // Until enough past years are loaded (e.g. a fresh install mid-backfill), the comparisons
      // and the model are not trustworthy enough to headline.
      provisional,
      /** Whole-system percent that counts as "full" (outlook, History, takeaways). */
      fullPct: FULL_PCT,
      seasonal: {
        label: seasonalLabel,
        percentile: round(percentile * 100, 0),
        typicalPct: envelope.median[latestDoy - 1] ?? null,
        lastYearPct: lastYearPct === null ? null : round(lastYearPct),
        recordLow: recordLow,
        recordHigh: recordHigh,
        yearsCompared: sameDay.length,
      },
    },
    supply: {
      daysNoRain,
      simpleDays,
      fullNow,
      refillBy,
      refillProbability: round(refillProbability, 2),
      medianRefillDate,
      refillRange,
      scenarioYears: scenarios.length,
    },
    history: {
      dates: reports.map((r) => r.report_date),
      total: reports.map((r) => tpct(totalOf(r) as number)),
    },
    seasonal: { envelope, years: yearSeries, firstYear: pastYears[0] ?? currentYear, currentYear },
    outlook,
    adjusted,
    dryYear,
    rain: { lake, city: cityRainSeason, months, tempNormal: cityT.span },
    demand: {
      years: demandYears,
      envelope: demandEnvelope,
      series: demandSeries,
      summerMld: round(summerMld),
      winterMld: round(winterMld),
      highest: highestUse && { year: highestUse.year, avgMld: highestUse.avgMld },
      lowest: lowestUse && { year: lowestUse.year, avgMld: lowestUse.avgMld },
      useShareOfInflow: inflowShare,
      trend: useTrend && { ...useTrend, crdPctPerYear: round(CRD_GROWTH_PCT, 2) },
      perPerson,
      ...useVsTypical,
    },
    why,
    model: {
      ...calibration,
      params: {
        catchmentKm2: round(params.area, 1),
        soilCapacityMm: round(params.smax, 0),
        drainagePerDay: round(params.k, 3),
        lakeEvaporationKm2: round(params.lakeArea, 2),
      },
      rmseMlPerWeek: Math.round(calibration.rmseMlPerWeek),
      r2: round(calibration.r2, 3),
      weatherPoint: WATERSHED,
      petNote: "Hargreaves (1985) temperature-based evapotranspiration",
    },
    sources: sourceList(),
    proof: buildProof(),
  };
}

export function sourceList() {
  return [
    {
      name: "CRD Water Watch",
      by: "Capital Regional District · Infrastructure & Water Services",
      what: "Weekly reservoir storage, demand and Sooke Lake rainfall",
      url: CRD.waterWatchPage,
      licence: "© Capital Regional District — see crd.ca/disclaimer",
      licenceUrl: CRD.disclaimer,
    },
    {
      name: "Water Watch archive 2009–2021",
      by: "Internet Archive Wayback Machine",
      what: "Earlier weekly reports from crd.bc.ca",
      url: "https://web.archive.org/web/2017/https://www.crd.bc.ca/service/drinking-water/water-watch",
      licence: "Archived copies of CRD publications",
      licenceUrl: "https://archive.org/about/terms.php",
    },
    {
      name: "Open-Meteo",
      by: "Open-Meteo.com · ERA5 by ECMWF for the Copernicus Climate Change Service",
      what: `Daily modelled weather (ERA5) for the Sooke Lake watershed (${WATERSHED.latitude}, ${WATERSHED.longitude})`,
      url: "https://open-meteo.com/",
      licence: "CC BY 4.0",
      licenceUrl: "https://open-meteo.com/en/license",
    },
    {
      name: "Environment and Climate Change Canada",
      by: "Meteorological Service of Canada",
      what: `Daily weather measured at ${CITY.name} (station IDs ${CITY.climateIds.join(", ")})`,
      url: "https://climate.weather.gc.ca/",
      licence: "Open Government Licence – Canada",
      licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    },
    {
      name: "Sooke Water Supply Area",
      by: "Capital Regional District",
      what: "The watershed covers 8,620 ha. About 6,720 ha of it drains straight to the reservoir.",
      url: SOOKE_WATERSHED.url,
      licence: "© Capital Regional District — see crd.ca/disclaimer",
      licenceUrl: CRD.disclaimer,
    },
    {
      name: "Statistics Canada",
      by: "Population estimates, July 1 (table 17-10-0155-01)",
      what: `Yearly population of the ${Object.keys(POPULATION.areas).length} municipalities the regional supply serves`,
      url: POPULATION.tableUrl,
      licence: "Statistics Canada Open Licence",
      licenceUrl: "https://www.statcan.gc.ca/en/terms-conditions/open-licence",
    },
    {
      name: "2026–2035 Water Conservation Plan",
      by: "Capital Regional District",
      what: `Metered use in ${CRD_CONSUMPTION.from.year} and ${CRD_CONSUMPTION.to.year}. The use trend is checked against it.`,
      url: "https://www.crd.ca/media/file/2026-2035-water-cons-plan-greater-victoriapdf",
      licence: "© Capital Regional District — see crd.ca/disclaimer",
      licenceUrl: CRD.disclaimer,
    },
  ];
}

export { netInflows, pet };
