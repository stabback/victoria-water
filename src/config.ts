/**
 * Every tunable and every external address lives here. Nothing in this file is secret —
 * the project is meant to be open source and runnable by anyone with `bun install`.
 */

export const PORT = Number(process.env.PORT ?? 3000);
/** Loopback by default: a reverse proxy or tunnel sits in front. Docker sets 0.0.0.0. */
export const HOST = process.env.HOST ?? "127.0.0.1";
export const SITE_URL = (process.env.SITE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
export const DATA_DIR = process.env.DATA_DIR ?? "./data";
/**
 * Optional Alertmanager-style webhook (`{alerts: [{labels, annotations}]}`) that `update` posts to
 * after a new report is in and the site is rebuilt. Unset: no alert.
 */
export const ALERT_URL = process.env.ALERT_URL ?? "";

export const USER_AGENT = `victoria-water/0.1 (open-source reservoir dashboard; +${SITE_URL})`;

/** Useable storage when full, from the Water Watch reports (100.0% = these values). */
export const CAPACITY_ML = {
  sooke: 92_727,
  goldstream: 9_907,
  total: 102_634,
} as const;

export const CRD = {
  waterWatchPage: "https://www.crd.ca/programs-services/water/greater-victorias-water-supply/water-watch",
  origin: "https://www.crd.ca",
  sookeLakePage: "https://www.crd.ca/programs-services/water/greater-victorias-water-supply/sooke-lake-reservoir",
  disclaimer: "https://www.crd.ca/disclaimer",
} as const;

/**
 * The real catchment, to sanity-check the model's fitted one. CRD: the Sooke Water Supply Area is
 * 8,620 ha, of which about 6,720 ha drains directly to the reservoir; the rest reaches it through
 * diversions (Council Lake, Leech River).
 */
export const SOOKE_WATERSHED = {
  supplyAreaKm2: 86,
  directKm2: 67,
  url: "https://www.crd.bc.ca/service/drinking-water/watershed-protection/sooke-water-supply-area-primary-water-supply",
  factsUrl: "https://crd.bc.ca/service/public-tours/watershed-tours/facts-figures",
} as const;

/** Sooke Lake Reservoir — the watershed point used for weather (rain here is what fills the lake). */
export const WATERSHED = { latitude: 48.55, longitude: -123.7, name: "Sooke Lake watershed" } as const;

/** Victoria Gonzales — the city's climate station (since 1898), about 2 km from downtown. */
export const CITY = {
  name: "Victoria Gonzales",
  /**
   * ECCC climate identifiers, oldest first: Gonzales Heights (to 2004) and Gonzales CS (1995 →),
   * at the same site. Where both report a day, the later station wins, field by field.
   */
  climateIds: ["1018610", "1018611"],
} as const;

export const OPEN_METEO = {
  archive: "https://archive-api.open-meteo.com/v1/archive",
  forecast: "https://api.open-meteo.com/v1/forecast",
  /** First day of the watershed backfill. ERA5 goes back to 1940; 1980 gives ample normals. */
  backfillStart: "1980-01-01",
} as const;

export const ECCC = {
  climateDaily: "https://api.weather.gc.ca/collections/climate-daily/items",
  backfillStart: "1980-01-01",
} as const;

/**
 * People served: Statistics Canada's July 1 population estimates for the 13 municipalities the
 * Regional Water Supply serves (table 17-10-0155-01, 2021 census boundaries), one vector each.
 * Not counted: the Juan de Fuca Electoral Area and First Nations reserves, which are served in part.
 * TRAP: StatCan replaces the table when census boundaries change (after the 2026 census); the
 * vectors then stop updating and the ingest reports the latest year as stale.
 */
export const POPULATION = {
  table: "17-10-0155-01",
  tableUrl: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1710015501",
  wds: "https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorByReferencePeriodRange",
  from: 2001,
  areas: {
    Victoria: 1592185055,
    Saanich: 1592185051,
    "Oak Bay": 1592185054,
    Esquimalt: 1592185056,
    "View Royal": 1592185060,
    Colwood: 1592185057,
    Langford: 1592185059,
    Metchosin: 1592185058,
    Highlands: 1592185061,
    Sooke: 1592185062,
    "Central Saanich": 1592185050,
    "North Saanich": 1592185048,
    Sidney: 1592185049,
  },
} as const;

/** Climate normal period (WMO standard). */
export const NORMALS = { from: 1991, to: 2020 } as const;

export const TIMEZONE = "America/Vancouver";

/**
 * The open data, written as static files next to the page by `site/pages/data/`.
 * RULE: every download link on the page comes from here.
 */
export const DOWNLOADS = [
  { label: "Weekly reservoir reports", format: "CSV", path: "/data/reservoir.csv" },
  { label: "Daily weather, Sooke Lake watershed", format: "CSV", path: "/data/weather-watershed.csv" },
  { label: "Daily weather, Victoria Gonzales", format: "CSV", path: "/data/weather-city.csv" },
  { label: "Population of the municipalities served", format: "CSV", path: "/data/population.csv" },
  { label: "Everything on this site", format: "JSON", path: "/data/dashboard.json" },
] as const;

/** Who made the site (footer and author tag). */
export const AUTHOR = "Josh Stabback";
export const AUTHOR_EMAIL = "victoria-water@stabback.com";
export const AUTHOR_GITHUB = "https://github.com/stabback";
export const AUTHOR_LINKEDIN = "https://www.linkedin.com/in/stabback";

/** Public source repository (footer and Sources page). */
export const REPO_URL = "https://github.com/stabback/victoria-water";
