import type { Database } from "bun:sqlite";
import { POPULATION } from "../config.ts";
import { politeFetch } from "./http.ts";

export type PopulationRow = { year: number; area: string; vector: number; persons: number; released: string };

type WdsPoint = { refPerRaw: string; value: number | null; releaseTime: string };
type WdsResponse = { status: string; object?: { vectorId: number; vectorDataPoint: WdsPoint[] } }[];

/** Largest plausible municipality here (Saanich is about 120,000) and the smallest (Highlands, about 2,500). */
const MAX_PERSONS = 250_000;
const MIN_PERSONS = 1_000;

/**
 * Validates a StatCan WDS response for POPULATION.areas.
 * RULE: every area, every year, July 1, a whole number in range — anything else throws.
 */
export function parsePopulation(json: unknown): PopulationRow[] {
  if (!Array.isArray(json)) throw new Error("population: response is not a list");
  const byVector = new Map<number, WdsPoint[]>();
  for (const item of json as WdsResponse) {
    if (item.status !== "SUCCESS" || !item.object) throw new Error(`population: vector status ${item.status}`);
    byVector.set(item.object.vectorId, item.object.vectorDataPoint);
  }
  const rows: PopulationRow[] = [];
  for (const [area, vector] of Object.entries(POPULATION.areas)) {
    const points = byVector.get(vector);
    if (!points?.length) throw new Error(`population: no data for ${area} (v${vector})`);
    for (const p of points) {
      if (!/^\d{4}-07-01$/.test(p.refPerRaw)) throw new Error(`population: ${area} has date ${p.refPerRaw}`);
      const v = p.value;
      if (v === null || !Number.isInteger(v) || v < MIN_PERSONS || v > MAX_PERSONS)
        throw new Error(`population: ${area} ${p.refPerRaw} has ${v} people`);
      rows.push({ year: Number(p.refPerRaw.slice(0, 4)), area, vector, persons: v, released: p.releaseTime });
    }
  }
  // RULE: a year counts only when every area has it, so totals never mix partial coverage.
  const areas = Object.keys(POPULATION.areas).length;
  const perYear = new Map<number, number>();
  for (const r of rows) perYear.set(r.year, (perYear.get(r.year) ?? 0) + 1);
  return rows.filter((r) => perYear.get(r.year) === areas);
}

/** StatCan July 1 estimates for the municipalities served. Small: refetched in full each run. */
export async function ingestPopulation(db: Database, log: (msg: string) => void = console.log) {
  const ids = Object.values(POPULATION.areas)
    .map((v) => `%22${v}%22`)
    .join(",");
  const url = `${POPULATION.wds}?vectorIds=${ids}&startRefPeriod=${POPULATION.from}-01-01&endReferencePeriod=2100-12-31`;
  const rows = parsePopulation(await (await politeFetch(url)).json());
  const stmt = db.query(
    `INSERT INTO population (year, area, vector, persons, released) VALUES ($year, $area, $vector, $persons, $released)
     ON CONFLICT (year, area) DO UPDATE SET vector = excluded.vector, persons = excluded.persons, released = excluded.released`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(r);
  })();
  const years = [...new Set(rows.map((r) => r.year))].sort();
  log(`population: ${rows.length} rows, ${years[0]}–${years.at(-1)}`);
  return { rows: rows.length, latestYear: years.at(-1) ?? null };
}
