# Victoria Water

A dashboard of Greater Victoria's water supply: **Sooke Lake** and the **Goldstream** reservoirs, now and back to 2009. It shows rain, water use, a refill outlook based on past weather and a dry-summer scenario. Each section's heading is a sentence generated from the data at build time.

It's a static site. [Astro](https://astro.build) builds it from a `bun:sqlite` database, which [Bun](https://bun.sh) scripts fill from the public sources. Text, numbers and the gauge are plain HTML, and hand-rolled SVG charts draw from the same data inlined in the page. It needs no accounts or API keys.

## Run it

```sh
bun install
bun run ingest     # fill the database (the first run is the full backfill, below)
bun run dev        # http://localhost:4321, rebuilt from the database on each change
```

On an empty database `bun run ingest` is the full historical backfill:

| Step                             | Source                                                      | Time       |
| -------------------------------- | ----------------------------------------------------------- | ---------- |
| CRD Water Watch, 2022 → today    | crd.ca (annual compilations + weekly PDFs)                  | ~1 min     |
| Weather, 1980 → today            | Open-Meteo (Sooke Lake watershed), ECCC (Victoria Gonzales) | ~1 min     |
| Water Watch archive, 2009 → 2021 | Internet Archive (≈750 small PDFs, throttled)               | ~30–60 min |

A lease in the database lets only one process ingest at a time. Single jobs: `bun run ingest water-watch weather-watershed weather-city water-watch-archive`.

## Build and publish

`bun run build` writes the whole site to `dist/` in a second or two: `index.html`, the data files below, `robots.txt` and `sitemap.xml`. It fails rather than publish a site with no data. Serve `dist/` from any static host.

`bun run update` is ingest + build in one. Each report covers the week to a Sunday, and the CRD posts it Monday–Wednesday, usually Monday midday. So run it a few times a day (e.g. 12:00 and 16:00), from cron or a systemd timer, under `flock` so two never overlap: `flock .update.lock bun run update`. Once the week's report is in, later runs do nothing; until then, they ingest and leave the site unchanged. When a new report arrives (the week's, or a late one), it builds into `dist-next/` and swaps that into `dist/` only if the build succeeds. `bun run update --force` ingests and rebuilds regardless. `bun run start` serves `dist/` (`@elysia/static`). It keeps the files in memory, so restart it after each update.

| Script                  |                                   |
| ----------------------- | --------------------------------- |
| `bun run dev`           | Astro dev server                  |
| `bun run build`         | Build the site into `dist/`       |
| `bun run update`        | Ingest, build, swap into `dist/`  |
| `bun run start`         | Serve `dist/`                     |
| `bun run ingest [job…]` | Run ingestion only                |
| `bun test`              | Tests                             |
| `bun run lint`          | Type-check (`astro check`, `tsc`) |
| `bun run check`         | Biome lint + format check         |

Settings (all optional, see `.env.example`): `PORT`, `HOST` (default `127.0.0.1`), `SITE_URL` (canonical URL, read at build time), `DATA_DIR`, `ALERT_URL` (Alertmanager-style webhook, posted to when a new report is in and the site is rebuilt).

### Docker

```sh
docker build -t victoria-water .
docker run -v victoria-water-data:/app/data victoria-water bun run ingest   # once
docker run -p 3000:3000 -v victoria-water-data:/app/data -e SITE_URL=https://example.org victoria-water
```

The container builds the site on start, then serves it; schedule `bun run update` with `docker exec` and restart it.

## Data

| Source                                                                                                   | What                                                                                   | Licence                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [CRD Water Watch](https://www.crd.ca/programs-services/water/greater-victorias-water-supply/water-watch) | Weekly useable storage (Sooke, Goldstream, total), demand, Sooke Lake rainfall (gauge) | © Capital Regional District ([disclaimer](https://www.crd.ca/disclaimer)) |
| [Internet Archive](https://web.archive.org/)                                                             | 2009–2021 Water Watch reports from the old crd.bc.ca site                              | Archived copies                                                           |
| [Open-Meteo](https://open-meteo.com/) (ERA5)                                                             | Daily weather at the Sooke Lake watershed (48.55, −123.70), 1980 →                     | CC BY 4.0                                                                 |
| [ECCC](https://climate.weather.gc.ca/)                                                                   | Daily observations at Victoria Gonzales (1018610 + 1018611), 1980 → (none for 1991–92) | Open Government Licence – Canada                                          |

The CRD publishes the reservoir data only as PDFs. `src/ingest/water-watch.ts` scrapes the Water Watch page for links (the file names change every week), downloads each new PDF, rebuilds the text layout (`pdf-text.ts`) and parses the summary page (`water-watch-parse.ts`). Every parsed report is validated (percent full must match volume ÷ capacity, Sooke + Goldstream must equal Total) before it is stored; the page text is kept in the database so reports can be re-parsed. `src/ingest/wayback-manifest.json` lists the archived 2009–2021 reports.

## How the numbers are made

- **Full** — the whole system at 95 % or more, everywhere (outlook chance, refill dates, History). Not 99 %: Goldstream is operated and often peaks below its capacity in winter while Sooke Lake spills.
- **Headline** — the whole system (Sooke Lake 92,727 ML + Goldstream 9,907 ML = 102,634 ML), as Water Watch reports it.
- **Typical / range** — every weekly report since 2009, interpolated to daily, compared by day of year.
- **Water-balance model** (`src/analysis/model.ts`) — a four-parameter daily model of the Sooke Lake watershed: rain and snowmelt fill a soil bucket, which overflows and drains into the lake; evapotranspiration follows Hargreaves (temperature only); the lake loses water to demand and evaporation and spills when full. It is calibrated against every pair of consecutive reports (when the lake isn't spilling) and explains roughly 90 % of week-to-week inflow. A monthly bias correction (its mean error per calendar month) removes its tendency to run too wet in summer.
- **Outlook** — today's storage, run forward under each past year's weather (1980 →); the first 4 forecast days are taken as given and the rest of the 10-day forecast fades into each past year's weather over 6 days, and the typical seasonal demand; Goldstream follows its median seasonal change. Bands are the 10–90 % and 25–75 % ranges; "full again" is the median.
- **Days of supply** — the same model with zero precipitation and normal temperatures, drawing down the whole system.
- **Weather effect** — the past 12 months re-run from the same starting level and the same actual demand under each 1991–2025 year's weather; the difference from the run with actual weather, in whole-system points.
- **Inflow** — the model's (bias-corrected) net inflow to Sooke Lake, summed per year.
- **Why lower / higher** — a water balance since the system was last full, in percentage points of capacity: the gap to typical splits into how far off typical it started, measured use above the typical amount for each day, and the rest — water that did or didn't flow in (rain and runoff, less evaporation). Parts are rounded to add up to the rounded gap.
- **Rain** — Sooke Lake from the CRD's gauge, as each Water Watch report quotes it: the total since September 1 and the normal for the same days (the band is the 10–90 % range of seasons since 2009). The city is Victoria Gonzales (ECCC), over the same days, against the mean rain on each day in 1991–2020 (the station has nothing for 1991–92); missing days are counted, not filled. The reanalysis weather at the watershed only drives the model.
- **Refills** — each spring's Jan–Jun peak, counted from the first spring whose refill season (from November) is in the record.
- **Use trend** — least-squares growth of average daily use over complete years, measured from the low year when use first fell (2009 → 2013) and then rose. It agrees with the CRD's [2026–2035 Water Conservation Plan](https://www.crd.ca/media/file/2026-2035-water-cons-plan-greater-victoriapdf) (46,469 ML in 2013 → 51,428 ML in 2023, ≈1 %/yr).
- **"A summer as dry as …"** (in Water use) — each measured May–December since 2009, replayed from the typical May 1 level and adjusted to the last 12 months' use; then with use growing at the measured trend until a summer like the worst one would take the system below 50 %. The current, unfinished year never enters annual use comparisons.
- **Headline status** — answers the season's question, after the rank for the date. Full (95 %+): how low a typical summer takes it. Refilling (the median outlook rises over the next four weeks): _Refilling_, or _Refilling late_ when the median refill date is 3+ weeks after the usual one (the median first-full date since 2009), _May not refill_ under a 75 % chance of being full by May 1, _Unlikely to refill_ under 50 %. Otherwise drawing down: _Drawing down_, _Heading low_ when the median low is within 5 points of the record low (or a dry year's low is below it), _Heading for a record low_ when the median low is below it. The CRD's reports define no status of their own.
- **How we know** (`src/analysis/provenance.ts` + `proof` in the payload) — per-source coverage (a week-by-week grid), freshness, the ingest checks re-run on every stored report, unreadable or vanished files, the model's weekly fit against the reports, and one line per headline number on how it is made. Download links live in `DOWNLOADS` in `src/config.ts`; `REPO_URL` is the source-code link.
- **Takeaways** (`src/analysis/story.ts`) — one sentence per section, a pure function of the computed facts, shipped in the payload as `story`.

## Open data

Every build publishes the data behind the page as static files, free to reuse:

| File                           |                                                        |
| ------------------------------ | ------------------------------------------------------ |
| `/data/dashboard.json`         | Everything on the page (the payload the charts draw)   |
| `/data/reservoir.csv`, `.json` | Weekly reports, 2009 →                                 |
| `/data/weather-watershed.csv`  | Daily weather at Sooke Lake (Open-Meteo ERA5), 1980 →  |
| `/data/weather-city.csv`       | Daily observations at Victoria Gonzales (ECCC), 1980 → |
| `/data/weather-forecast.csv`   | The 10-day forecast at Sooke Lake used by the outlook  |
| `/data/sources.json`           | The sources and every file ingested, with checksums    |

## Layout

```
src/
  index.ts            static file server for dist/
  update.ts           ingest + build + swap (the scheduled entry point)
  export.ts           the /data tables, CSV, robots.txt, sitemap
  db.ts               bun:sqlite + append-only migrations
  ingest/             CRD PDFs, Internet Archive backfill, Open-Meteo, ECCC
  analysis/           water-balance model and dashboard computations
site/                 the Astro site (srcDir)
  pages/index.astro   the page; all text and figures rendered at build time
  pages/data/         the open-data files
  components/         the hero gauge
  scripts/            app.ts (charts and their controls), charts.ts (SVG toolkit)
  lib/                build-time data access, shared formatting
public/               favicon, Open Graph image
test/                 bun test — parser fixtures, model, site data
```

Site by Josh Stabback. The data belongs to the people who measure and publish it (see [Data](#data)), with thanks. Not affiliated with the Capital Regional District. The code is licensed under the MIT licence.
