import { describe, expect, test } from "bun:test";
import { buildStory, partOfMonth, type StoryFacts, verdict } from "../src/analysis/story.ts";

const years = Array.from({ length: 17 }, (_, i) => 2009 + i);
const dry = {
  worstYear: 2026,
  worstPartial: true,
  worstLowPct: 58.3,
  worstLowDate: "2026-11-01",
  firstYear: 2009,
  summers: 18,
  growthPctPerYear: 0.95,
  growthFromYear: 2013,
  belowYear: 2051,
  belowWeatherYear: 2026,
  belowPct: 50,
  searchedTo: 2076,
};

/** Early November, below every past year but one. */
const base: StoryFacts = {
  date: "2026-11-01",
  provisional: false,
  totalPct: 58.1,
  sameDate: years.map((year) => ({ year, pct: year === 2009 ? 54.4 : 62 + (year % 7) })),
  fullPct: 95,
  why: { since: "2026-05-17", sinceFull: true, gapPct: -12, startPct: -1, usePct: -1.9, inflowPct: -9.1 },
  outlook: {
    fullNow: false,
    refillDate: "2027-01-23",
    refillEarly: "2027-01-08",
    refillLate: "2027-02-12",
    refillBy: "2027-05-01",
    refillProbability: 0.89,
    in4WeeksPct: 66,
    usualRefillDate: "2027-01-08",
    lowestAheadDryPct: 57,
    lowestAheadPct: 58,
    lowestAheadDate: "2026-11-05",
  },
  rain: { season: { mm: 187, normalMm: 250 }, since: { since: "2026-05-17", mm: 380, normalMm: 500 } },
  use: {
    currentYear: 2026,
    years: [
      { year: 2009, avgMld: 148.6, ytdMld: 154.5, partial: false },
      { year: 2013, avgMld: 127.5, ytdMld: 133.8, partial: false },
      { year: 2025, avgMld: 143.4, ytdMld: 151.1, partial: false },
      { year: 2026, avgMld: 151.3, ytdMld: 151.3, partial: true },
    ],
    summerWinterRatio: 1.94,
    trend: { firstYear: 2009, fromYear: 2013, fellFirstPct: 14, pctPerYear: 0.95 },
    perPersonPctPerYear: null,
    firstDrop: { year: 2009, next: 2010, summerPct: -7.4, winterPct: -1.8, tmaxDiff: -1.9, rainPct: 53 },
    ytdVsTypicalPct: 6.9,
    summerAboveShare: 0.67,
    warmMonths: ["2026-04-01", "2026-05-01", "2026-06-01"],
  },
  dryYear: dry,
  recordLow: {
    pct: 53,
    date: "2009-10-18",
    springPeakPct: 90,
    rainPctOfNormal: 63,
    driestRain: true,
    highestSummerUse: true,
  },
  history: { firstYear: 2010, springs: 17, refilled: 17, thresholdPct: 95, lowest: { year: 2019, peakPct: 96.4 } },
};

describe("story", () => {
  test("use growth split by use per person", () => {
    const at = (pp: number) => buildStory({ ...base, use: { ...base.use, perPersonPctPerYear: pp } }).use;
    expect(at(-0.8)).toBe("Use has grown about 1% a year since 2013, but we all use less");
    expect(at(0.1)).toBe("Use has grown about 1% a year since 2013, but we all use about the same");
    expect(at(0.6)).toBe("Use has grown about 1% a year since 2013, and we all use more");
  });

  test("headline verdict and section takeaways", () => {
    const s = buildStory(base);
    // Refilling, two weeks behind the usual date: on time.
    expect(s.verdict).toEqual({
      word: "Refilling.",
      text: "It’s the second-lowest level for early November in 18 years. It should be full by late January.",
      level: "good",
    });
    expect(s.year).toBe("12% below typical, mostly because less water flowed in");
    // The parts add up to the gap shown (12 = 9 + 2 + 1).
    expect(s.why).toBe("Of the 12%, 9% is less water flowing in since May, 2% is higher use and 1% is a lower start.");
    expect(s.outlook).toBe("Likely full again between early January and mid-February");
    expect(s.rain).toBe("75% of average rain at Sooke Lake since September");
    expect(s.rainNote).toBe("Rain has been below average since May, when the reservoirs were last full.");
    expect(s.use).toBe("Use is back near 2009 levels after growing about 1% a year since 2013");
    expect(s.useNote).toBe("So far in 2026, use is 7% above a typical year. April to June were warmer than normal.");
    expect(s.useDropNote).toBe(
      "2010’s summer was 2 °C cooler and wetter than 2009’s, so summer use fell 7% while winter use barely changed.",
    );
    expect(s.dryYearNote).toBe(
      "If use keeps growing about 1% a year and nothing else changes, a summer like this year’s would take the reservoirs below 50% around 2051.",
    );
    expect(s.history).toBe("Full (95% or more) every spring since 2010");
    expect(s.historyNote).toBe(
      "The lowest point, 53% in October 2009, came after a spring that only reached 90%, the driest year of rain on record (63% of normal) and the highest summer use on record.",
    );
  });

  test("record lows and full systems change the wording", () => {
    const lowest = buildStory({ ...base, totalPct: 50 });
    expect(lowest.verdict.text).toBe(
      "It’s the lowest level for early November in 18 years. It should be full by late January.",
    );

    const full = buildStory({
      ...base,
      date: "2026-03-05",
      totalPct: 100,
      sameDate: years.map((year) => ({ year, pct: year % 4 ? 100 : 90 })),
      why: { since: "2026-03-01", sinceFull: true, gapPct: 0.5, startPct: 0, usePct: 0, inflowPct: 0.5 },
      outlook: {
        ...base.outlook,
        fullNow: true,
        refillDate: null,
        refillEarly: null,
        refillLate: null,
        lowestAheadPct: 71.4,
        lowestAheadDate: "2026-10-20",
      },
    });
    expect(full.verdict).toEqual({
      word: "Full.",
      text: "A typical summer takes it down to about 71% by October.",
      level: "good",
    });
    expect(full.why).toBeNull();
    expect(full.year).toBe("Full, like 13 of the past 17 years in early March");
    expect(full.outlook).toBe("Full now, and a typical summer takes it to about 71% by October");
  });

  test("past dry years, flat use, higher levels and unlikely refills", () => {
    const s = buildStory({
      ...base,
      rain: { season: { mm: 300, normalMm: 250 }, since: null },
      why: { since: "2025-11-02", sinceFull: false, gapPct: 6, startPct: 2, usePct: 0.4, inflowPct: 3.6 },
      outlook: { ...base.outlook, refillDate: null, refillEarly: null, refillLate: null, refillProbability: 0.3 },
      dryYear: {
        ...dry,
        worstYear: 2015,
        worstLowPct: 61.5,
        growthPctPerYear: 0,
        belowYear: null,
        belowWeatherYear: null,
      },
      use: { ...base.use, trend: { firstYear: 2009, fromYear: 2009, fellFirstPct: null, pctPerYear: 0.1 } },
      history: { ...base.history, refilled: 15, lowest: { year: 2012, peakPct: 89.2 } },
    });
    expect(s.rain).toBe("120% of average rain at Sooke Lake since September");
    expect(s.why).toBe("Of the 6%, 4% is more water flowing in over the past year and 2% is a higher start.");
    expect(s.outlook).toBe("Only 3 in 10 past years had enough rain to fill it by May 1");
    expect(s.year).toBe("6% above typical, mostly because more water flowed in");
    expect(s.dryYearNote).toBe("At today’s use, even the worst summer since 2009 would stay above 61%.");
    expect(s.use).toBe("Use has been flat since 2009");
    expect(s.history).toBe("Full in 15 of 17 springs since 2010, with a lowest peak of 89% in 2012");
  });

  test("the headline answers the season's question", () => {
    const at = (outlook: Partial<StoryFacts["outlook"]>, extra: Partial<StoryFacts> = {}) =>
      verdict({ ...base, ...extra, outlook: { ...base.outlook, ...outlook } });
    // Refilling: on time, late, in doubt, unlikely.
    expect(at({ refillDate: "2027-02-12" })).toMatchObject({ word: "Refilling late.", level: "good" });
    expect(at({ refillDate: "2027-02-12" }).text).toEndWith("It should be full by mid-February.");
    expect(at({ refillProbability: 0.6 })).toEqual({
      word: "May not refill.",
      text: "It’s the second-lowest level for early November in 18 years. Only 6 in 10 past years had enough rain to fill it by May 1.",
      level: "watch",
    });
    expect(at({ refillProbability: 0.3 })).toMatchObject({ word: "Unlikely to refill.", level: "watch" });
    // Drawing down (no rise over the next four weeks): against the record low.
    const summer = { date: "2026-08-02", totalPct: 77 };
    const down = { in4WeeksPct: 72, lowestAheadPct: 63, lowestAheadDryPct: 58, lowestAheadDate: "2026-10-18" };
    expect(at(down, summer)).toMatchObject({ word: "Drawing down.", level: "good" });
    expect(at(down, summer).text).toEndWith("It usually bottoms out near 63% in October. The record is 53% (2009).");
    expect(at({ ...down, lowestAheadDryPct: 51 }, summer)).toMatchObject({ word: "Heading low.", level: "watch" });
    expect(at({ ...down, lowestAheadPct: 56 }, summer)).toMatchObject({ word: "Heading low.", level: "watch" });
    expect(at({ ...down, lowestAheadPct: 52 }, summer)).toMatchObject({
      word: "Heading for a record low.",
      level: "record",
    });
  });

  test("part of month", () => {
    expect(partOfMonth("2026-11-01")).toBe("early November");
    expect(partOfMonth("2026-03-15")).toBe("mid-March");
    expect(partOfMonth("2026-01-31")).toBe("late January");
  });
});
