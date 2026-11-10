import { describe, expect, test } from "bun:test";
import { dayNum, doy, isoOf, quantile, waterYearOf } from "../src/analysis/dates.ts";
import { calibrate, type Interval, netInflows, pet, simulateStorage, type WeatherDay } from "../src/analysis/model.ts";

function syntheticWeather(days: number): WeatherDay[] {
  const start = dayNum("2015-01-01");
  return Array.from({ length: days }, (_, i) => {
    const date = isoOf(start + i);
    const season = Math.cos(((doy(date) - 15) / 365) * 2 * Math.PI); // 1 in winter, -1 in summer
    const precip = (i * 7919) % 5 === 0 ? 25 + 20 * season : 0;
    return { date, precip: Math.max(0, precip), tmax: 12 - 8 * season, tmin: 4 - 5 * season, tmean: 8 - 6.5 * season };
  });
}

describe("dates", () => {
  test("day of year folds Feb 29", () => {
    expect(doy("2024-02-29")).toBe(59);
    expect(doy("2024-03-01")).toBe(60);
    expect(doy("2025-03-01")).toBe(60);
    expect(doy("2025-12-31")).toBe(365);
  });
  test("water year starts Sep 1", () => {
    expect(waterYearOf("2026-08-31")).toBe(2026);
    expect(waterYearOf("2026-09-01")).toBe(2027);
  });
  test("quantile", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
  });
});

describe("model", () => {
  test("evapotranspiration is higher in summer", () => {
    expect(pet("2025-07-15", 25, 12, 18)).toBeGreaterThan(pet("2025-01-15", 7, 2, 4.5) * 3);
  });

  test("storage never exceeds capacity or drops below zero", () => {
    const s = simulateStorage(90, [50, 50, -500, 0], () => 10, 100);
    expect(s).toEqual([100, 100, 0, 0]);
  });

  test("calibration recovers a known watershed", () => {
    const weather = syntheticWeather(365 * 6);
    const truth = { area: 90, smax: 150, k: 0.02, lakeArea: 6 };
    const daily = netInflows(weather, truth);
    const intervals: Interval[] = [];
    for (let i = 400; i + 7 < weather.length; i += 7) {
      intervals.push({
        from: (weather[i] as WeatherDay).date,
        to: (weather[i + 7] as WeatherDay).date,
        // Storage on a report date includes that day's flows: the interval covers days from+1 … to.
        observedNet: daily.slice(i + 1, i + 8).reduce((a, b) => a + b, 0),
      });
    }
    const fit = calibrate(weather, intervals);
    expect(fit.r2).toBeGreaterThan(0.95);
    expect(fit.params.area).toBeGreaterThan(60);
    expect(fit.params.area).toBeLessThan(130);
  });
});
