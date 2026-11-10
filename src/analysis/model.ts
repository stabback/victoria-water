/**
 * A small daily water-balance model of the Sooke Lake watershed, calibrated against the CRD's
 * own weekly storage reports.
 *
 *   rain + snowmelt → soil bucket → (overflow + slow drainage) × catchment area → reservoir inflow
 *   reservoir: storage += inflow − demand − lake evaporation, capped at full (the rest spills)
 *
 * 1 mm of runoff over 1 km² is exactly 1 ML, so the catchment "area" parameter converts runoff
 * depth to megalitres. Evapotranspiration uses Hargreaves' temperature-only formula, which only
 * needs the daily min/max temperatures we already have.
 *
 * It is deliberately simple — four fitted numbers — so it is explainable and stable. It powers
 * the outlook (what happens next under each of ~45 past years' weather), the weather-adjusted
 * comparison, and the days-of-supply estimate.
 */
import { dayNum, isoOf } from "./dates.ts";

export type WeatherDay = { date: string; precip: number; tmax: number; tmin: number; tmean: number };
export type Params = { area: number; smax: number; k: number; lakeArea: number };
export type State = { soil: number; snow: number };

const LAT = (48.55 * Math.PI) / 180;
const MELT_MM_PER_DEG = 3;

/** Hargreaves reference evapotranspiration (mm/day). */
export function pet(date: string, tmax: number, tmin: number, tmean: number): number {
  const j = dayNum(date) - dayNum(`${date.slice(0, 4)}-01-01`) + 1;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * j) / 365);
  const decl = 0.409 * Math.sin((2 * Math.PI * j) / 365 - 1.39);
  const ws = Math.acos(-Math.tan(LAT) * Math.tan(decl));
  const ra =
    ((24 * 60) / Math.PI) *
    0.082 *
    dr *
    (ws * Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.sin(ws));
  return Math.max(0, 0.0023 * 0.408 * ra * (tmean + 17.8) * Math.sqrt(Math.max(0, tmax - tmin)));
}

/** Advances the watershed one day; returns net reservoir inflow (ML) before demand. */
export function stepWatershed(
  state: State,
  day: WeatherDay,
  p: Params,
  petMm = pet(day.date, day.tmax, day.tmin, day.tmean),
) {
  let water = day.precip;
  if (day.tmean < 0) {
    state.snow += day.precip;
    water = 0;
  } else if (state.snow > 0) {
    const melt = Math.min(state.snow, day.tmean * MELT_MM_PER_DEG);
    state.snow -= melt;
    water += melt;
  }
  state.soil += water;
  state.soil -= Math.min(state.soil, petMm * Math.min(1, state.soil / p.smax));
  const quick = Math.max(0, state.soil - p.smax);
  state.soil -= quick;
  const slow = p.k * state.soil;
  state.soil -= slow;
  return (quick + slow) * p.area - petMm * p.lakeArea;
}

/** Net inflow (ML/day) for every day of a weather series, starting from a given state. */
export function netInflows(weather: WeatherDay[], p: Params, state: State = { soil: p.smax * 0.5, snow: 0 }) {
  return weather.map((d) => stepWatershed(state, d, p));
}

export type Interval = { from: string; to: string; observedNet: number };

/**
 * Calibration targets: for each pair of consecutive reports, observed net inflow
 * = Δstorage + demand × days. Skipped when either end is (nearly) full, because then the lake
 * is spilling and the true inflow is unknown.
 */
export function calibrationIntervals(
  reports: { report_date: string; sooke_ml: number; demand_week_mld: number | null }[],
  capacity: number,
): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < reports.length; i++) {
    const a = reports[i - 1] as (typeof reports)[number];
    const b = reports[i] as (typeof reports)[number];
    const days = dayNum(b.report_date) - dayNum(a.report_date);
    if (days < 5 || days > 15) continue;
    if (a.sooke_ml > capacity * 0.985 || b.sooke_ml > capacity * 0.985) continue;
    const demand = b.demand_week_mld ?? a.demand_week_mld;
    if (demand === null) continue;
    out.push({ from: a.report_date, to: b.report_date, observedNet: b.sooke_ml - a.sooke_ml + demand * days });
  }
  return out;
}

function sse(weather: WeatherDay[], petMm: number[], intervals: Interval[], p: Params) {
  const state: State = { soil: p.smax * 0.5, snow: 0 };
  const cum = new Float64Array(weather.length + 1);
  for (let i = 0; i < weather.length; i++) {
    cum[i + 1] = (cum[i] as number) + stepWatershed(state, weather[i] as WeatherDay, p, petMm[i]);
  }
  const start = dayNum((weather[0] as WeatherDay).date);
  let err = 0;
  let n = 0;
  for (const iv of intervals) {
    // Storage on a report date includes that day's flows, so an interval covers days from+1 … to.
    const i0 = dayNum(iv.from) - start + 1;
    const i1 = dayNum(iv.to) - start + 1;
    if (i0 < 365 || i1 > weather.length) continue;
    const modelled = (cum[i1] as number) - (cum[i0] as number);
    err += (modelled - iv.observedNet) ** 2;
    n++;
  }
  return { err, n };
}

const BOUNDS: Record<keyof Params, [number, number]> = {
  area: [30, 300],
  smax: [10, 500],
  k: [0.001, 0.3],
  lakeArea: [0, 20],
};

/** Deterministic pseudo-random numbers so a calibration is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Calibration = {
  params: Params;
  intervals: number;
  rmseMlPerWeek: number;
  r2: number;
};

/** Random search followed by shrinking coordinate refinement. Takes well under a second. */
export function calibrate(weather: WeatherDay[], intervals: Interval[]): Calibration {
  const petMm = weather.map((d) => pet(d.date, d.tmax, d.tmin, d.tmean));
  const rand = mulberry32(42);
  const keys = Object.keys(BOUNDS) as (keyof Params)[];
  const draw = (): Params =>
    Object.fromEntries(keys.map((k) => [k, BOUNDS[k][0] + rand() * (BOUNDS[k][1] - BOUNDS[k][0])])) as Params;
  let best = draw();
  let bestErr = sse(weather, petMm, intervals, best).err;
  for (let i = 0; i < 400; i++) {
    const p = draw();
    const e = sse(weather, petMm, intervals, p).err;
    if (e < bestErr) [best, bestErr] = [p, e];
  }
  for (let scale = 0.25; scale > 0.002; scale *= 0.6) {
    for (let pass = 0; pass < 3; pass++) {
      for (const k of keys) {
        const [lo, hi] = BOUNDS[k];
        for (const dir of [-1, 1]) {
          const p = { ...best, [k]: Math.min(hi, Math.max(lo, best[k] + dir * scale * (hi - lo))) };
          const e = sse(weather, petMm, intervals, p).err;
          if (e < bestErr) [best, bestErr] = [p, e];
        }
      }
    }
  }
  const { err, n } = sse(weather, petMm, intervals, best);
  // R² over exactly the intervals the fit used (those with a year of spin-up and weather coverage).
  const start = dayNum((weather[0] as WeatherDay).date);
  const used = intervals.filter(
    (iv) => dayNum(iv.from) - start + 1 >= 365 && dayNum(iv.to) - start + 1 <= weather.length,
  );
  const mean = used.reduce((s, iv) => s + iv.observedNet, 0) / Math.max(1, used.length);
  const sst = used.reduce((s, iv) => s + (iv.observedNet - mean) ** 2, 0);
  return { params: best, intervals: n, rmseMlPerWeek: Math.sqrt(err / Math.max(1, n)), r2: 1 - err / sst };
}

/**
 * Mean model error (observed − modelled net inflow, ML/day) by calendar month of each
 * calibration interval, shrunk toward zero for months with few intervals.
 *
 * TRAP: the fit is dominated by big winter inflows, so on its own the model runs ~20–40 ML/day
 * too wet from May to October — about 5 points of storage over a summer. Scenarios that care
 * about summer drawdown (outlook, days of supply, dry-year test) must add this correction.
 */
export function monthlyBias(weather: WeatherDay[], intervals: Interval[], p: Params, shrink = 10): number[] {
  const state: State = { soil: p.smax * 0.5, snow: 0 };
  const start = dayNum((weather[0] as WeatherDay).date);
  const cum = new Float64Array(weather.length + 1);
  for (let i = 0; i < weather.length; i++)
    cum[i + 1] = (cum[i] as number) + stepWatershed(state, weather[i] as WeatherDay, p);
  const sum = new Array<number>(12).fill(0);
  const n = new Array<number>(12).fill(0);
  for (const iv of intervals) {
    const i0 = dayNum(iv.from) - start + 1;
    const i1 = dayNum(iv.to) - start + 1;
    if (i0 < 365 || i1 > weather.length) continue;
    const days = i1 - i0;
    const m = Number(isoOf(Math.round((dayNum(iv.from) + dayNum(iv.to)) / 2)).slice(5, 7)) - 1;
    sum[m] = (sum[m] as number) + (iv.observedNet - ((cum[i1] as number) - (cum[i0] as number))) / days;
    n[m] = (n[m] as number) + 1;
  }
  return sum.map((s, m) => s / ((n[m] as number) + shrink));
}

/** Runs the reservoir forward: storage capped at capacity, floored at zero. */
export function simulateStorage(
  start: number,
  inflows: number[],
  demand: (i: number) => number,
  capacity: number,
): number[] {
  const out: number[] = [];
  let s = start;
  for (let i = 0; i < inflows.length; i++) {
    s = Math.min(capacity, Math.max(0, s + (inflows[i] as number) - demand(i)));
    out.push(s);
  }
  return out;
}

export { isoOf };
