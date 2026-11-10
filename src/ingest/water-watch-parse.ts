/**
 * Parser for page 1 of a CRD "Water Watch" weekly report (the text summary).
 *
 * The layout has drifted over the years — volumes were printed in ML and MIG (million imperial
 * gallons) until early 2026 and in ML only since; the season-rainfall label is "2023/2024",
 * "2021 - 2022" or just "2022"; a few 2025 pages say "Issued <date>" — so every field is matched
 * loosely and validated afterwards rather than trusted.
 */

export type WaterWatchReport = {
  reportDate: string;
  sookeMl: number;
  goldstreamMl: number | null;
  totalMl: number | null;
  sookePct: number | null;
  goldstreamPct: number | null;
  totalPct: number | null;
  monthEnd: string | null;
  sooke5yrMl: number | null;
  goldstream5yrMl: number | null;
  total5yrMl: number | null;
  sookeLastYearMl: number | null;
  goldstreamLastYearMl: number | null;
  totalLastYearMl: number | null;
  demandMonthMld: number | null;
  demandWeekMld: number | null;
  demandMaxDayMld: number | null;
  demand5yrMld: number | null;
  rainMonthNormalMm: number | null;
  rainMonthMm: number | null;
  rainSeasonNormalMm: number | null;
  rainSeasonMm: number | null;
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const num = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/,/g, "")));
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(month: string, day: string, year: string): string | null {
  // Full names or abbreviations ("Aug", "Sept.") — the 2011 reports abbreviate.
  const key = month.toLowerCase().replace(/\./g, "").slice(0, 3);
  const m = key.length === 3 ? MONTHS.findIndex((name) => name.startsWith(key)) : -1;
  if (m < 0) return null;
  const d = new Date(Date.UTC(Number(year), m, Number(day)));
  if (d.getUTCMonth() !== m) return null;
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** Returns null when the page is not a Water Watch summary page (e.g. a chart page). */
export function parseWaterWatchPage(lines: string[]): WaterWatchReport | null {
  const text = lines.join("\n");
  if (!/Useable\s+Volume/i.test(text)) return null;

  // "Water Watch for July 5, 2009" · "Sept. 26, 2010" · "Sept.11, 2011" · "Water Watch Issued: February 4, 2013"
  const DATE = String.raw`([A-Za-z]+)(?:\.\s*|\s+)(\d{1,2}),?\s+(\d{4})`;
  const dateMatch =
    text.match(new RegExp(String.raw`Water\s+Watch\s+(?:for|Issued:?)\s+${DATE}`, "i")) ??
    text.match(new RegExp(String.raw`Issued:?\s+${DATE}`, "i"));
  if (!dateMatch) return null;
  const reportDate = isoDate(dateMatch[1] as string, dateMatch[2] as string, dateMatch[3] as string);
  if (!reportDate) return null;

  const storage: Record<string, { cols: number[]; pct: number | null }> = {};
  for (const line of lines) {
    const m = line.match(/^(Sooke|Goldstream|Total)\b\s*\*?\s*(.*)$/i);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    if (storage[key]) continue;
    const rest = m[2] as string;
    const pct = rest.match(/([\d.]+)\s*%/);
    const values = (rest.replace(/([\d.]+)\s*%.*/, "").match(/\d{1,3}(?:,\d{3})+|\d+/g) ?? []).map(
      (s) => num(s) as number,
    );
    if (values.length < 3) continue;
    // ML + MIG pairs (6 numbers) before 2026; ML only (3 numbers) since.
    const cols = values.length >= 6 ? [values[0], values[2], values[4]] : values.slice(0, 3);
    storage[key] = { cols: cols as number[], pct: pct ? Number(pct[1]) : null };
  }
  const sooke = storage.sooke;
  if (!sooke) return null;

  // "Reservoir System November 30 November 30/25 November 1/26" — the month-end the
  // 5-year-average and last-year columns refer to.
  let monthEnd: string | null = null;
  const header = lines.find((l) => /^Reservoir/i.test(l));
  const hm = header?.match(/([A-Za-z]+)\s+(\d{1,2})\b/);
  if (hm) {
    const year = reportDate.slice(0, 4);
    const candidate = isoDate(hm[1] as string, hm[2] as string, year);
    // A late-December report can reference the following January (and vice versa); keep it near.
    if (candidate) {
      const diff = (Date.parse(candidate) - Date.parse(reportDate)) / 86_400_000;
      if (diff < -200) monthEnd = isoDate(hm[1] as string, hm[2] as string, String(Number(year) + 1));
      else if (diff > 200) monthEnd = isoDate(hm[1] as string, hm[2] as string, String(Number(year) - 1));
      else monthEnd = candidate;
    }
  }
  monthEnd ??= lastDayOfMonth(reportDate);

  const find = (re: RegExp) => {
    const m = text.match(re);
    return m ? num(m[1]) : null;
  };
  const NUM = String.raw`([\d,]+(?:\.\d+)?)`;

  // Section-aware rainfall parsing: section 4 is the month, section 5 the season (Sep 1 – date).
  let section = 0;
  let rainMonthNormalMm: number | null = null;
  let rainMonthMm: number | null = null;
  let rainSeasonNormalMm: number | null = null;
  let rainSeasonMm: number | null = null;
  for (const line of lines) {
    const s = line.match(/^(\d)\.\s/);
    if (s) section = Number(s[1]);
    if (section === 4) {
      const avg = line.match(new RegExp(String.raw`Average\s*\([^)]*\)\s*:?\s*${NUM}\s*mm`, "i"));
      if (avg) rainMonthNormalMm = num(avg[1]);
      const act = line.match(new RegExp(String.raw`Actual\s+Rainfall\s+to\s+Date\s*:?\s*${NUM}`, "i"));
      if (act) rainMonthMm = num(act[1]);
    } else if (section === 5) {
      const avg = line.match(new RegExp(String.raw`Average\s*\([^)]*\)\s*:?\s*${NUM}\s*mm`, "i"));
      if (avg) rainSeasonNormalMm = num(avg[1]);
      else {
        const act = line.match(new RegExp(String.raw`^\d{4}(?:\s*[-/]\s*\d{4})?\s*:?\s*${NUM}\s*(?:mm|\()`, "i"));
        if (act) rainSeasonMm = num(act[1]);
      }
    }
  }

  const report: WaterWatchReport = {
    reportDate,
    sookeMl: sooke.cols[2] as number,
    goldstreamMl: storage.goldstream?.cols[2] ?? null,
    totalMl: storage.total?.cols[2] ?? null,
    sookePct: sooke.pct,
    goldstreamPct: storage.goldstream?.pct ?? null,
    totalPct: storage.total?.pct ?? null,
    monthEnd,
    sooke5yrMl: sooke.cols[0] ?? null,
    goldstream5yrMl: storage.goldstream?.cols[0] ?? null,
    total5yrMl: storage.total?.cols[0] ?? null,
    sookeLastYearMl: sooke.cols[1] ?? null,
    goldstreamLastYearMl: storage.goldstream?.cols[1] ?? null,
    totalLastYearMl: storage.total?.cols[1] ?? null,
    demandMonthMld: find(new RegExp(String.raw`For\s+the\s+month\s+of\s+[A-Za-z]+\s*:?\s*${NUM}\s*MLD?\b`, "i")),
    demandWeekMld: find(new RegExp(String.raw`For\s+week\s+ending[^\n]*?\d{4}\s*:?\s*${NUM}\s*MLD?\b`, "i")),
    demandMaxDayMld: find(new RegExp(String.raw`Max\.?\s+day[^\n]*?to\s+date\s*:?\s*${NUM}\s*MLD?\b`, "i")),
    demand5yrMld: find(new RegExp(String.raw`(?:Average\s*\(\d{4}\s*-\s*\d{4}\)|Actual)\s*:?\s*${NUM}\s*MLD`, "i")),
    rainMonthNormalMm,
    rainMonthMm,
    rainSeasonNormalMm,
    rainSeasonMm,
  };
  return report;
}

/** Sanity checks: a report that fails any of these is stored nowhere and logged instead. */
export function validateReport(r: WaterWatchReport, capacity: { sooke: number; total: number }): string[] {
  const problems: string[] = [];
  if (!(r.sookeMl > 0 && r.sookeMl <= capacity.sooke * 1.001)) problems.push(`sooke_ml out of range: ${r.sookeMl}`);
  if (r.sookePct !== null) {
    const implied = (r.sookeMl / capacity.sooke) * 100;
    if (Math.abs(implied - r.sookePct) > 0.6) problems.push(`sooke % mismatch: ${r.sookePct} vs ${implied.toFixed(1)}`);
  }
  if (r.totalMl !== null && r.goldstreamMl !== null && Math.abs(r.sookeMl + r.goldstreamMl - r.totalMl) > 3) {
    problems.push(`sooke + goldstream != total (${r.sookeMl} + ${r.goldstreamMl} != ${r.totalMl})`);
  }
  for (const [k, v] of [
    ["demand_week", r.demandWeekMld],
    ["demand_month", r.demandMonthMld],
  ] as const) {
    if (v !== null && !(v > 30 && v < 400)) problems.push(`${k} out of range: ${v}`);
  }
  return problems;
}
