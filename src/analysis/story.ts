/**
 * The one-line takeaways that headline each section of the page. Pure functions of a small set
 * of already-computed facts, so they are deterministic, testable and can be rendered by any
 * front end (live page or static build) without re-deriving anything from the data.
 *
 * RULE: one short sentence each, built only from numbers in the facts — no filler.
 */
import { dayNum } from "./dates.ts";

/** Green or amber; red only for a record low. RULE: never alarmist — the sentence carries the detail. */
export type Level = "good" | "watch" | "record";

export type StoryFacts = {
  /** Date of the latest report (YYYY-MM-DD). */
  date: string;
  provisional: boolean;
  /** Whole system (Sooke + Goldstream), percent of useable capacity. */
  totalPct: number;
  /** Whole-system percent on this date in each past year with data. */
  sameDate: { year: number; pct: number }[];
  /** Whole-system percent that counts as "full", everywhere. */
  fullPct: number;
  /** Why storage differs from typical, by water balance since `since` (percent of capacity). */
  why: {
    since: string;
    sinceFull: boolean;
    gapPct: number;
    startPct: number;
    usePct: number;
    inflowPct: number;
  } | null;
  outlook: {
    fullNow: boolean;
    /** Median date the system is full again (null when full now or not within the horizon). */
    refillDate: string | null;
    /** The middle half of refill dates (25th and 75th percentile), when known. */
    refillEarly: string | null;
    refillLate: string | null;
    refillBy: string;
    refillProbability: number;
    /** Median-outlook level four weeks ahead (percent): above today means it is refilling. */
    in4WeeksPct: number;
    /** The usual date it is full again (median since the record began), for this refill season. */
    usualRefillDate: string | null;
    /** The 10th-percentile outlook's lowest level ahead (percent): a dry year's low. */
    lowestAheadDryPct: number;
    /** Lowest median-outlook level ahead (percent). */
    lowestAheadPct: number;
    lowestAheadDate: string;
  };
  rain: {
    /** Sooke Lake (the CRD's gauge) since September 1 and the normal for the same days; null without data. */
    season: { mm: number; normalMm: number } | null;
    /** Lake rain over the same window as `why` (since the system was last full) vs the CRD's normal. */
    since: { since: string; mm: number; normalMm: number } | null;
  };
  use: {
    currentYear: number;
    /** Average use (ML/day) per year; `ytdMld` is Jan 1 → the latest report's day of year. */
    years: { year: number; avgMld: number; ytdMld: number | null; partial: boolean }[];
    summerWinterRatio: number | null;
    /** Measured trend in average use over complete years (see dashboard.ts). */
    trend: {
      firstYear: number;
      fromYear: number;
      fellFirstPct: number | null;
      pctPerYear: number;
    } | null;
    /** Trend in use per person over the same years as `trend` (null without population data). */
    perPersonPctPerYear: number | null;
    /** When use fell first: the record's first year against the next (percent changes; tmax in °C). */
    firstDrop: {
      year: number;
      next: number;
      summerPct: number;
      winterPct: number;
      tmaxDiff: number | null;
      rainPct: number | null;
    } | null;
    /** This year Jan 1 → latest vs a typical year over the same days (percent difference). */
    ytdVsTypicalPct: number | null;
    /** Share of this summer's days (Jun–Aug) with use above typical. */
    summerAboveShare: number | null;
    /** The run of this year's months (YYYY-MM-01) at least 1 °C warmer than normal, if any. */
    warmMonths: string[];
  };
  dryYear: {
    /** The summer (May → Dec) that, replayed at today's use, falls lowest. */
    worstYear: number;
    /** True when the worst summer is this year's and still under way. */
    worstPartial: boolean;
    worstLowPct: number;
    worstLowDate: string;
    firstYear: number;
    /** Summers in the record, including this one. */
    summers: number;
    /** Measured growth in use, and the year that trend is measured from. */
    growthPctPerYear: number;
    growthFromYear: number | null;
    /** First year that summer, with use growing, would take the system below `belowPct`. */
    belowYear: number | null;
    belowWeatherYear: number | null;
    belowPct: number;
    searchedTo: number;
  } | null;
  /** The lowest level in past years' reports, and what that year looked like. */
  recordLow: {
    pct: number;
    date: string;
    /** That year's Jan–Jun peak (null when the record starts too late to see it). */
    springPeakPct: number | null;
    /** The CRD's Sooke Lake rain from September to the end of August before the low, % of normal. */
    rainPctOfNormal: number | null;
    /** Driest such rain season in the reports. */
    driestRain: boolean;
    /** Highest June–September use in the reports. */
    highestSummerUse: boolean;
  } | null;
  /** Spring refills (Jan–Jun peak) since the record first covers a whole refill season. */
  history: {
    firstYear: number;
    springs: number;
    refilled: number;
    thresholdPct: number;
    lowest: { year: number; peakPct: number } | null;
  };
};

const MONTHS = [
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

export const monthName = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] as string;

/** "early November", "mid-March", "late January". */
export function partOfMonth(iso: string): string {
  const d = Number(iso.slice(8, 10));
  return d <= 10 ? `early ${monthName(iso)}` : d <= 20 ? `mid-${monthName(iso)}` : `late ${monthName(iso)}`;
}

const ORDINAL_WORD = ["", "second", "third"];
const r0 = (v: number) => Math.round(v);
const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/** Weeks late at which a refill counts as late, and points above the record that count as near it. */
export const STATUS = { lateWeeks: 3, nearRecordPct: 5 } as const;
const LATE_WEEKS = STATUS.lateWeeks;
const NEAR_RECORD_PCT = STATUS.nearRecordPct;

/** Where today sits against the same date in past years: rank from the bottom and top. */
function rankOf(facts: StoryFacts) {
  const tol = 0.25;
  const n = facts.sameDate.length;
  const below = facts.sameDate.filter((s) => s.pct < facts.totalPct - tol).length;
  const above = facts.sameDate.filter((s) => s.pct > facts.totalPct + tol).length;
  const share = n ? (below + 0.5 * (n - below - above)) / n : 0.5;
  return { n, below, above, share };
}

/**
 * Where today ranks for this date. As a heading: "Second-lowest for early November in 18 years".
 * As a sentence: "It's the second-lowest level for early November in 18 years."
 */
function rankPhrase(f: StoryFacts, sentence = false) {
  const when = partOfMonth(f.date);
  const { n, below, above, share } = rankOf(f);
  const span = `${n + 1} years`;
  const say = (heading: string, text: string) => (sentence ? `It’s ${text}.` : heading);
  if (f.totalPct >= f.fullPct) return say("Full", "full");
  if (n >= 3 && below <= 2)
    return say(
      `${below ? `${cap(ORDINAL_WORD[below] as string)}-lowest` : "Lowest"} for ${when} in ${span}`,
      `the ${below ? `${ORDINAL_WORD[below]}-` : ""}lowest level for ${when} in ${span}`,
    );
  if (n >= 3 && above <= 2)
    return say(
      `${above ? `${cap(ORDINAL_WORD[above] as string)}-highest` : "Highest"} for ${when} in ${span}`,
      `the ${above ? `${ORDINAL_WORD[above]}-` : ""}highest level for ${when} in ${span}`,
    );
  const rel =
    share < 0.15
      ? "lower than typical"
      : share < 0.4
        ? "a little lower than typical"
        : share <= 0.75
          ? "about typical"
          : "higher than typical";
  return say(`${rel.charAt(0).toUpperCase()}${rel.slice(1)} for ${when}`, `${rel} for ${when}`);
}

/**
 * The headline answers the question of the season. Full: how low a typical summer takes it.
 * Refilling: will it fill, and when. Drawing down: is it heading for a record low.
 * RULE: say the rank plainly up front, so nothing further down reads as contradicting it.
 */
export function verdict(f: StoryFacts): { word: string; text: string; level: Level | null } {
  if (f.provisional) return { word: "Loading.", text: "History is still being collected.", level: null };
  const o = f.outlook;
  const summer = `A typical summer takes it down to about ${r0(o.lowestAheadPct)}% by ${monthName(o.lowestAheadDate)}.`;
  if (f.totalPct >= f.fullPct) return { word: "Full.", text: summer, level: "good" };
  const rank = rankPhrase(f, true);
  if (o.in4WeeksPct > f.totalPct + 0.5) {
    const chance = `Only ${Math.round(o.refillProbability * 10)} in 10 past years had enough rain to fill it by ${monthName(o.refillBy)} 1.`;
    if (o.refillProbability < 0.5) return { word: "Unlikely to refill.", text: `${rank} ${chance}`, level: "watch" };
    if (o.refillProbability < 0.75 || !o.refillDate)
      return { word: "May not refill.", text: `${rank} ${chance}`, level: "watch" };
    const lateWeeks = o.usualRefillDate ? Math.round((dayNum(o.refillDate) - dayNum(o.usualRefillDate)) / 7) : 0;
    const text = `${rank} It should be full by ${partOfMonth(o.refillDate)}.`;
    return lateWeeks >= LATE_WEEKS
      ? { word: "Refilling late.", text, level: "good" }
      : { word: "Refilling.", text, level: "good" };
  }
  const rec = f.recordLow;
  const low = `It usually bottoms out near ${r0(o.lowestAheadPct)}% in ${monthName(o.lowestAheadDate)}.`;
  if (!rec) return { word: "Drawing down.", text: `${rank} ${low}`, level: "good" };
  const text = `${rank} ${low} The record is ${r0(rec.pct)}% (${rec.date.slice(0, 4)}).`;
  if (o.lowestAheadPct < rec.pct) return { word: "Heading for a record low.", text, level: "record" };
  if (o.lowestAheadPct < rec.pct + NEAR_RECORD_PCT || o.lowestAheadDryPct < rec.pct)
    return { word: "Heading low.", text, level: "watch" };
  return { word: "Drawing down.", text, level: "good" };
}

/** The This-year headline: the gap to typical and its main cause; falls back to the rank. */
function yearLine(f: StoryFacts) {
  const w = f.why;
  const gap = w ? Math.round(w.gapPct) : 0;
  if (w && Math.abs(gap) >= 3) {
    const lower = gap < 0;
    const sign = lower ? -1 : 1;
    const use = Math.round(w.usePct * sign);
    const start = Math.round(w.startPct * sign);
    const inflow = Math.abs(gap) - use - start;
    const main =
      inflow >= use && inflow >= start
        ? `${lower ? "less" : "more"} water flowed in`
        : use >= start
          ? `use was ${lower ? "higher" : "lower"}`
          : `it started ${lower ? "lower" : "higher"}`;
    return `${points(Math.abs(gap))} ${lower ? "below" : "above"} typical, mostly because ${main}`;
  }
  const { n } = rankOf(f);
  if (f.totalPct >= f.fullPct) {
    const fullYears = f.sameDate.filter((s) => s.pct >= f.fullPct).length;
    return `Full, like ${fullYears} of the past ${n} years in ${partOfMonth(f.date)}`;
  }
  return rankPhrase(f);
}

/** Differences in storage, written in % of capacity: "12% below typical". */
const points = (n: number) => `${n}%`;

function outlookLine(f: StoryFacts) {
  const o = f.outlook;
  if (o.fullNow)
    return `Full now, and a typical summer takes it to about ${r0(o.lowestAheadPct)}% by ${monthName(o.lowestAheadDate)}`;
  if (o.refillDate && o.refillProbability >= 0.5) {
    // The middle half of past years' weather: the band the chart calls "Likely".
    const early = o.refillEarly && partOfMonth(o.refillEarly);
    const late = o.refillLate && partOfMonth(o.refillLate);
    return early && late && early !== late
      ? `Likely full again between ${early} and ${late}`
      : `Likely full again by ${partOfMonth(o.refillDate)}`;
  }
  return `Only ${Math.round(o.refillProbability * 10)} in 10 past years had enough rain to fill it by ${monthName(o.refillBy)} 1`;
}

/**
 * "Of the 12%, 9% is less water flowing in since May, 2% is higher use and 1% is a lower start."
 * Parts are rounded so they add up to the rounded gap.
 */
function whyLine(f: StoryFacts) {
  const w = f.why;
  const gap = w ? Math.round(w.gapPct) : 0;
  if (!w || Math.abs(gap) < 3) return null;
  const lower = gap < 0;
  const sign = lower ? -1 : 1;
  const use = Math.round(w.usePct * sign);
  const start = Math.round(w.startPct * sign);
  const inflow = Math.abs(gap) - use - start;
  const since = w.sinceFull ? `since ${monthName(w.since)}` : "over the past year";
  const parts: string[] = [];
  if (inflow >= 1) parts.push(`${points(inflow)} is ${lower ? "less" : "more"} water flowing in ${since}`);
  if (use >= 1) parts.push(`${points(use)} is ${lower ? "higher" : "lower"} use`);
  if (start >= 1) parts.push(`${points(start)} is a ${lower ? "lower" : "higher"} start`);
  if (!parts.length) return null;
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Of the ${points(Math.abs(gap))}, ${joined}.`;
}

/** Ties the rain section to the "why" window without a second, competing percentage. */
function rainNote(f: StoryFacts) {
  const r = f.rain.since;
  if (!r || r.normalMm <= 0) return null;
  const ratio = r.mm / r.normalMm;
  const when = f.why?.sinceFull
    ? `since ${monthName(r.since)}, when the reservoirs were last full`
    : "over the past year";
  return ratio < 0.9
    ? `Rain has been below average ${when}.`
    : ratio > 1.1
      ? `Rain has been above average ${when}.`
      : null;
}

/** Sooke Lake against the CRD's average ("Average (1914–2025)" in each report). */
function rainLine(f: StoryFacts) {
  const s = f.rain.season;
  if (!s || s.normalMm <= 0) return "Rain since September";
  const ratio = s.mm / s.normalMm;
  return ratio >= 0.9 && ratio <= 1.1
    ? "About average rain at Sooke Lake since September"
    : `${r0(ratio * 100)}% of average rain at Sooke Lake since September`;
}

/** 0.95 → "about 1%", 0.4 → "0.4%". */
const rate = (pct: number) =>
  Math.abs(pct - Math.round(pct)) <= 0.15 && Math.round(pct) !== 0 ? `about ${Math.round(pct)}%` : `${pct.toFixed(1)}%`;

/** Growth in total use, split by use per person (more people vs more use each). */
const perPersonTail = (pp: number | null) =>
  pp === null
    ? ""
    : pp <= -0.3
      ? ", but we all use less"
      : pp < 0.3
        ? ", but we all use about the same"
        : ", and we all use more";

/** "Use is back near 2009 levels after growing about 1% a year since 2013", or plain growth. */
function backNear(f: StoryFacts, r: number) {
  const trend = f.use.trend as NonNullable<StoryFacts["use"]["trend"]>;
  const first = f.use.years.find((y) => y.year === trend.firstYear);
  const last = f.use.years.filter((y) => !y.partial).at(-1);
  const near = first && last && Math.abs(last.avgMld - first.avgMld) / first.avgMld <= 0.05;
  return near
    ? `Use is back near ${trend.firstYear} levels after growing ${rate(r)} a year since ${trend.fromYear}`
    : `Use has grown ${rate(r)} a year since ${trend.fromYear}`;
}

function useLines(f: StoryFacts) {
  const { currentYear, summerWinterRatio, trend, ytdVsTypicalPct, warmMonths } = f.use;
  let headline = "Water use through the year";
  if (trend) {
    const r = trend.pctPerYear;
    headline =
      Math.abs(r) < 0.3
        ? `Use has been flat since ${trend.fromYear}`
        : r > 0 && trend.fellFirstPct !== null && f.use.perPersonPctPerYear === null
          ? backNear(f, r)
          : r > 0
            ? `Use has grown ${rate(r)} a year since ${trend.fromYear}${perPersonTail(f.use.perPersonPctPerYear)}`
            : `Use has fallen ${rate(-r)} a year since ${trend.fromYear}`;
  }
  let note: string | null = null;
  if (ytdVsTypicalPct !== null && Math.abs(ytdVsTypicalPct) >= 2) {
    // Only name a cause the page can show: months measurably warmer than normal.
    const names = warmMonths.map((m) => monthName(m));
    const cause =
      ytdVsTypicalPct > 0 && names.length
        ? names.length === 1
          ? ` ${names[0]} was warmer than normal.`
          : ` ${names[0]} to ${names.at(-1)} were warmer than normal.`
        : "";
    note = `So far in ${currentYear}, use is ${r0(Math.abs(ytdVsTypicalPct))}% ${ytdVsTypicalPct > 0 ? "above" : "below"} a typical year.${cause}`;
  } else if (summerWinterRatio !== null && summerWinterRatio >= 1.15)
    note = `Summer use is ${summerWinterRatio >= 1.85 && summerWinterRatio <= 2.15 ? "about double" : `${summerWinterRatio.toFixed(1)} times`} winter use.`;
  return { headline, note };
}

/** Why use fell after the record's first year: summer (watering) against winter (indoor) use. */
function useDropNote(f: StoryFacts) {
  const d = f.use.firstDrop;
  if (!d || d.summerPct > -2 || d.summerPct >= d.winterPct) return null;
  const winter =
    Math.abs(d.winterPct) < 3
      ? "winter use barely changed"
      : `winter use ${d.winterPct < 0 ? "fell" : "rose"} ${r0(Math.abs(d.winterPct))}%`;
  const wx: string[] = [];
  if (d.tmaxDiff !== null && d.tmaxDiff <= -0.5) wx.push(`${r0(-d.tmaxDiff)} °C cooler`);
  if (d.rainPct !== null && d.rainPct >= 20) wx.push("wetter");
  const why = wx.length ? `${d.next}’s summer was ${wx.join(" and ")} than ${d.year}’s, so ` : `In ${d.next}, `;
  return `${why}summer use fell ${r0(-d.summerPct)}% while ${winter}.`;
}

/** The "at current trends" scenario, told as a consequence of the use trend. */
function dryYearNote(f: StoryFacts) {
  const d = f.dryYear;
  if (!d) return null;
  const year = Number(f.date.slice(0, 4));
  const like = d.belowWeatherYear === year ? year : d.belowWeatherYear;
  if (d.growthPctPerYear <= 0.1)
    return `At today’s use, even the worst summer since ${d.firstYear} would stay above ${Math.floor(d.worstLowPct)}%.`;
  const growing = `If use keeps growing ${rate(d.growthPctPerYear)} a year and nothing else changes`;
  return d.belowYear !== null
    ? `${growing}, a summer like ${like === year ? "this year’s" : `${like}’s`} would take the reservoirs below ${d.belowPct}% around ${d.belowYear}.`
    : `${growing}, no summer since ${d.firstYear} would take the reservoirs below ${d.belowPct}% before ${d.searchedTo}.`;
}

function historyLine(f: StoryFacts) {
  const { firstYear, springs, refilled, thresholdPct, lowest } = f.history;
  if (springs === 0) return "";
  if (refilled === springs) return `Full (${thresholdPct}% or more) every spring since ${firstYear}`;
  const low = lowest ? `, with a lowest peak of ${r0(lowest.peakPct)}% in ${lowest.year}` : "";
  return `Full in ${refilled} of ${springs} springs since ${firstYear}${low}`;
}

/** What lay behind the record low, from that year's own reports. */
function historyNote(f: StoryFacts) {
  const rec = f.recordLow;
  if (!rec) return null;
  const parts: string[] = [];
  if (rec.springPeakPct !== null && rec.springPeakPct < f.fullPct)
    parts.push(`a spring that only reached ${r0(rec.springPeakPct)}%`);
  if (rec.rainPctOfNormal !== null && rec.rainPctOfNormal < 90)
    parts.push(
      `${rec.driestRain ? "the driest year of rain on record" : "a dry year"} (${r0(rec.rainPctOfNormal)}% of normal)`,
    );
  if (rec.highestSummerUse) parts.push("the highest summer use on record");
  if (!parts.length) return null;
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `The lowest point, ${r0(rec.pct)}% in ${monthName(rec.date)} ${rec.date.slice(0, 4)}, came after ${joined}.`;
}

export function buildStory(f: StoryFacts) {
  const use = useLines(f);
  return {
    verdict: verdict(f),
    year: yearLine(f),
    why: whyLine(f),
    outlook: outlookLine(f),
    rain: rainLine(f),
    rainNote: rainNote(f),
    use: use.headline,
    useNote: use.note,
    useDropNote: useDropNote(f),
    dryYearNote: dryYearNote(f),
    history: historyLine(f),
    historyNote: historyNote(f),
  };
}

export type Story = ReturnType<typeof buildStory>;
