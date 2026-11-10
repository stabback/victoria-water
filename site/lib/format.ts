/** Number and date formatting shared by the build (Astro) and the browser (charts). */

export type Num = number | null | undefined;

export const nf0 = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });
export const nf1 = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const DAY = 86_400_000;
export const dayNum = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
export const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const parts = (iso: string) => ({
  y: Number(iso.slice(0, 4)),
  m: Number(iso.slice(5, 7)) - 1,
  d: Number(iso.slice(8, 10)),
});
export const fmtDate = (iso: string, year = true) => {
  const { y, m, d } = parts(iso);
  return `${MONTHS[m]} ${d}${year ? `, ${y}` : ""}`;
};
export const pct = (v: Num, digits = 1) => (v === null || v === undefined ? "–" : `${(digits ? nf1 : nf0).format(v)}%`);
export const signed = (v: number, f: (n: number) => string) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${f(Math.abs(v))}`;
export const doyToIso = (doy: number, year = 2025) => isoOf(dayNum(`${year}-01-01`) + doy - 1);
export function doyOf(iso: string) {
  const { y } = parts(iso);
  const n = dayNum(iso) - dayNum(`${y}-01-01`) + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return leap && n > 59 ? n - 1 : n;
}
/** Billions of litres from megalitres: 59,647 ML → "60 billion litres". */
export const billions = (ml: number) => `${nf0.format(ml / 1000)} billion litres`;
/** A timestamp in Victoria time, whatever the build machine's zone: "Nov 8, 2026, 5:02 a.m." */
export const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Vancouver" });
