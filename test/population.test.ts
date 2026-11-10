import { describe, expect, test } from "bun:test";
import { POPULATION } from "../src/config.ts";
import { parsePopulation } from "../src/ingest/population.ts";
import wds from "./fixtures/statcan-population.json";

const clone = () => structuredClone(wds) as typeof wds;
const total = (year: number) =>
  parsePopulation(wds)
    .filter((r) => r.year === year)
    .reduce((s, r) => s + r.persons, 0);

describe("parsePopulation", () => {
  test("StatCan WDS response (fields the parser reads)", () => {
    const rows = parsePopulation(wds);
    expect(rows.length).toBe(Object.keys(POPULATION.areas).length * 25);
    expect(rows.find((r) => r.area === "Saanich" && r.year === 2009)?.persons).toBe(112_344);
    expect(total(2009)).toBe(338_774);
    expect(total(2025)).toBe(433_113);
  });

  test("rejects bad values, dates and failed vectors", () => {
    const badValue = clone();
    (badValue[0]?.object.vectorDataPoint[0] as { value: number | null }).value = 12.5;
    expect(() => parsePopulation(badValue)).toThrow(/people/);
    const badDate = clone();
    (badDate[0]?.object.vectorDataPoint[0] as { refPerRaw: string }).refPerRaw = "2001-01-01";
    expect(() => parsePopulation(badDate)).toThrow(/date/);
    const failed = clone();
    (failed[0] as { status: string }).status = "FAILED";
    expect(() => parsePopulation(failed)).toThrow(/status/);
    expect(() => parsePopulation(clone().slice(1))).toThrow(/no data/);
  });

  test("drops a year that not every area has yet", () => {
    const partial = clone();
    partial[0]?.object.vectorDataPoint.pop();
    expect(parsePopulation(partial).some((r) => r.year === 2025)).toBe(false);
  });
});
