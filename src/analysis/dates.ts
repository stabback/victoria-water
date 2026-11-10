const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for an ISO date (UTC, so no DST surprises). */
export const dayNum = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
export const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Day of year 1..365, with Feb 29 folded onto Feb 28 so years line up. */
export function doy(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const n = dayNum(iso) - dayNum(`${y}-01-01`) + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return leap && n > 59 ? n - 1 : n;
}

/** Water year (CRD "season") starts September 1 — reports quote rain "Sep 1 – date". */
export const waterYearOf = (iso: string) => Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) >= 9 ? 1 : 0);
export const waterYearStart = (wy: number) => `${wy - 1}-09-01`;

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export const round = (v: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
