import type { Database } from "bun:sqlite";
import { CITY, ECCC, OPEN_METEO, TIMEZONE, WATERSHED } from "../config.ts";
import { addDays, isoToday, politeFetch } from "./http.ts";

/** Weather series identifiers stored in `weather_daily.source`. */
export const WEATHER_SOURCES = {
  /** Open-Meteo ERA5 reanalysis at the Sooke Lake watershed — the rain that fills the reservoir. */
  watershed: "watershed",
  /** Open-Meteo forecast at the watershed for the coming days (replaced on every run). */
  forecast: "forecast",
  /** ECCC observations at Victoria Gonzales — the city's climate station. */
  city: "city",
} as const;

type DailyRow = {
  date: string;
  tmax: number | null;
  tmin: number | null;
  tmean: number | null;
  precip: number | null;
  rain: number | null;
  snow: number | null;
};

function upsertDaily(db: Database, source: string, rows: DailyRow[]) {
  const stmt = db.query(
    `INSERT INTO weather_daily (source, date, tmax, tmin, tmean, precip, rain, snow)
     VALUES ($source, $date, $tmax, $tmin, $tmean, $precip, $rain, $snow)
     ON CONFLICT (source, date) DO UPDATE SET tmax = excluded.tmax, tmin = excluded.tmin, tmean = excluded.tmean,
       precip = excluded.precip, rain = excluded.rain, snow = excluded.snow`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run({ source, ...r });
  })();
}

const DAILY_VARS = "precipitation_sum,rain_sum,snowfall_sum,temperature_2m_max,temperature_2m_min,temperature_2m_mean";

type OpenMeteoDaily = {
  daily: {
    time: string[];
    precipitation_sum: (number | null)[];
    rain_sum: (number | null)[];
    snowfall_sum: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    temperature_2m_mean: (number | null)[];
  };
};

function openMeteoRows(json: OpenMeteoDaily): DailyRow[] {
  const d = json.daily;
  return d.time
    .map((date, i) => ({
      date,
      tmax: d.temperature_2m_max[i] ?? null,
      tmin: d.temperature_2m_min[i] ?? null,
      tmean: d.temperature_2m_mean[i] ?? null,
      precip: d.precipitation_sum[i] ?? null,
      rain: d.rain_sum[i] ?? null,
      snow: d.snowfall_sum[i] ?? null,
    }))
    .filter((r) => r.precip !== null || r.tmax !== null);
}

function lastDate(db: Database, source: string): string | null {
  const row = db.query("SELECT max(date) AS d FROM weather_daily WHERE source = ?").get(source) as { d: string | null };
  return row.d;
}

/**
 * Watershed weather. First run backfills from OPEN_METEO.backfillStart in 10-year chunks
 * (Open-Meteo weights requests by size); later runs re-fetch the trailing three weeks because
 * the most recent days are provisional and get revised.
 */
export async function ingestWatershed(db: Database, log: (msg: string) => void = console.log) {
  const today = isoToday();
  const last = lastDate(db, WEATHER_SOURCES.watershed);
  let start = last ? addDays(last, -21) : OPEN_METEO.backfillStart;
  let total = 0;
  while (start <= today) {
    const end = [addDays(start, 3652), today].sort()[0] as string;
    const url = `${OPEN_METEO.archive}?latitude=${WATERSHED.latitude}&longitude=${WATERSHED.longitude}&start_date=${start}&end_date=${end}&daily=${DAILY_VARS}&timezone=${encodeURIComponent(TIMEZONE)}`;
    const rows = openMeteoRows((await (await politeFetch(url)).json()) as OpenMeteoDaily);
    upsertDaily(db, WEATHER_SOURCES.watershed, rows);
    total += rows.length;
    log(`weather: watershed ${start} → ${end}: ${rows.length} days`);
    start = addDays(end, 1);
  }

  // The coming week at the watershed (replaced wholesale).
  const fUrl = `${OPEN_METEO.forecast}?latitude=${WATERSHED.latitude}&longitude=${WATERSHED.longitude}&daily=${DAILY_VARS}&forecast_days=10&timezone=${encodeURIComponent(TIMEZONE)}`;
  const forecast = openMeteoRows((await (await politeFetch(fUrl)).json()) as OpenMeteoDaily).filter(
    (r) => r.date >= today,
  );
  db.transaction(() => {
    db.query("DELETE FROM weather_daily WHERE source = ?").run(WEATHER_SOURCES.forecast);
    upsertDaily(db, WEATHER_SOURCES.forecast, forecast);
  })();
  return { days: total, forecastDays: forecast.length };
}

type EcccFeature = {
  properties: {
    LOCAL_DATE: string;
    MAX_TEMPERATURE: number | null;
    MIN_TEMPERATURE: number | null;
    MEAN_TEMPERATURE: number | null;
    TOTAL_PRECIPITATION: number | null;
    TOTAL_RAIN: number | null;
    TOTAL_SNOW: number | null;
  };
};

/** Victoria Gonzales observations from the ECCC OGC API (max 10,000 rows per page). */
export async function ingestCity(db: Database, log: (msg: string) => void = console.log) {
  const today = isoToday();
  const last = lastDate(db, WEATHER_SOURCES.city);
  const start = last ? addDays(last, -21) : ECCC.backfillStart;
  // RULE: the stations overlap; merge field by field, the later station winning where it reports.
  const byDate = new Map<string, DailyRow>();
  for (const climateId of CITY.climateIds) {
    for (let offset = 0; ; offset += 10_000) {
      const url =
        `${ECCC.climateDaily}?f=json&CLIMATE_IDENTIFIER=${climateId}&datetime=${start}/${today}` +
        `&sortby=LOCAL_DATE&limit=10000&offset=${offset}&skipGeometry=true` +
        "&properties=LOCAL_DATE,MAX_TEMPERATURE,MIN_TEMPERATURE,MEAN_TEMPERATURE,TOTAL_PRECIPITATION,TOTAL_RAIN,TOTAL_SNOW";
      const json = (await (await politeFetch(url)).json()) as { features: EcccFeature[] };
      for (const { properties: p } of json.features) {
        const date = p.LOCAL_DATE.slice(0, 10);
        const prev = byDate.get(date);
        byDate.set(date, {
          date,
          tmax: p.MAX_TEMPERATURE ?? prev?.tmax ?? null,
          tmin: p.MIN_TEMPERATURE ?? prev?.tmin ?? null,
          tmean: p.MEAN_TEMPERATURE ?? prev?.tmean ?? null,
          precip: p.TOTAL_PRECIPITATION ?? prev?.precip ?? null,
          rain: p.TOTAL_RAIN ?? prev?.rain ?? null,
          snow: p.TOTAL_SNOW ?? prev?.snow ?? null,
        });
      }
      if (json.features.length < 10_000) break;
    }
  }
  // Days not yet reported come back with every field null.
  const rows = [...byDate.values()]
    .filter((r) => r.precip !== null || r.tmax !== null || r.tmin !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  upsertDaily(db, WEATHER_SOURCES.city, rows);
  log(`weather: city (${CITY.climateIds.join(" + ")}) from ${start}: ${rows.length} days`);
  return { days: rows.length };
}
