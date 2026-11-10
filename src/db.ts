import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";

/**
 * Ordered schema migrations. RULE: append only — never edit a shipped entry.
 * `PRAGMA user_version` records how many have been applied.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE source_files (
    url           TEXT PRIMARY KEY,
    title         TEXT,
    label         TEXT,
    bytes         INTEGER,
    sha256        TEXT,
    fetched_at    TEXT NOT NULL,
    reports_found INTEGER NOT NULL DEFAULT 0,
    rejected      TEXT,
    error         TEXT
  );

  CREATE TABLE reservoir_reports (
    report_date             TEXT PRIMARY KEY,
    source_url              TEXT NOT NULL,
    source_page             INTEGER NOT NULL,
    sooke_ml                REAL NOT NULL,
    goldstream_ml           REAL,
    total_ml                REAL,
    sooke_pct               REAL,
    goldstream_pct          REAL,
    total_pct               REAL,
    month_end               TEXT,
    sooke_5yr_ml            REAL,
    goldstream_5yr_ml       REAL,
    total_5yr_ml            REAL,
    sooke_last_year_ml      REAL,
    goldstream_last_year_ml REAL,
    total_last_year_ml      REAL,
    demand_month_mld        REAL,
    demand_week_mld         REAL,
    demand_max_day_mld      REAL,
    demand_5yr_mld          REAL,
    rain_month_normal_mm    REAL,
    rain_month_mm           REAL,
    rain_season_normal_mm   REAL,
    rain_season_mm          REAL,
    raw_text                TEXT NOT NULL,
    ingested_at             TEXT NOT NULL
  );

  CREATE TABLE weather_daily (
    source TEXT NOT NULL,
    date   TEXT NOT NULL,
    tmax   REAL,
    tmin   REAL,
    tmean  REAL,
    precip REAL,
    rain   REAL,
    snow   REAL,
    PRIMARY KEY (source, date)
  ) WITHOUT ROWID;

  CREATE TABLE job_runs (
    id          INTEGER PRIMARY KEY,
    job         TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    detail      TEXT
  );
  `,
  // A lease so only one process (server cron or `bun run ingest`) ingests at a time.
  `
  CREATE TABLE job_lock (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    holder     TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  // The city weather moved from Victoria Airport to Victoria Gonzales (source 'city').
  `
  DELETE FROM weather_daily WHERE source = 'airport';
  `,
  // People served: StatCan July 1 estimates per municipality.
  `
  CREATE TABLE population (
    year       INTEGER NOT NULL,
    area       TEXT NOT NULL,
    vector     INTEGER NOT NULL,
    persons    INTEGER NOT NULL,
    released   TEXT NOT NULL,
    PRIMARY KEY (year, area)
  ) WITHOUT ROWID;
  `,
];

export function openDb(path = `${DATA_DIR}/victoria-water.sqlite`): Database {
  if (path !== ":memory:") mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  // The site build and the ingest CLI may share the file; wait for a writer instead of failing.
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.run(MIGRATIONS[i] as string);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}

let shared: Database | undefined;

/** The process-wide connection. Opened lazily so tests can use their own in-memory databases. */
export function db(): Database {
  shared ??= openDb();
  return shared;
}
