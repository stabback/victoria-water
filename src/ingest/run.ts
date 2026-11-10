import type { Database } from "bun:sqlite";
import { ingestPopulation } from "./population.ts";
import { ingestWaterWatch } from "./water-watch.ts";
import { ingestWaterWatchArchive } from "./water-watch-archive.ts";
import { ingestCity, ingestWatershed } from "./weather.ts";

/** Run in this order: the long one-time archive backfill goes last so a fresh deploy is useful quickly. */
export const JOBS = {
  "water-watch": ingestWaterWatch,
  "weather-watershed": ingestWatershed,
  "weather-city": ingestCity,
  population: ingestPopulation,
  "water-watch-archive": ingestWaterWatchArchive,
} as const;

export type JobName = keyof typeof JOBS;

const LEASE_MS = 30 * 60_000;
const holder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** Takes or renews the cross-process ingestion lease. False if another process holds it. */
function acquireLease(db: Database): boolean {
  return db
    .transaction(() => {
      const now = new Date();
      const row = db.query("SELECT holder, expires_at FROM job_lock WHERE id = 1").get() as {
        holder: string;
        expires_at: string;
      } | null;
      if (row && row.holder !== holder && row.expires_at > now.toISOString()) return false;
      db.query("INSERT OR REPLACE INTO job_lock (id, holder, expires_at) VALUES (1, ?, ?)").run(
        holder,
        new Date(now.getTime() + LEASE_MS).toISOString(),
      );
      return true;
    })
    .immediate();
}

function releaseLease(db: Database) {
  db.query("DELETE FROM job_lock WHERE id = 1 AND holder = ?").run(holder);
}

/**
 * Runs the named jobs one after another, recording each in `job_runs`.
 * RULE: never throws — a failed job is recorded and the next one still runs.
 */
export async function runJobs(db: Database, names: JobName[] = Object.keys(JOBS) as JobName[]) {
  const results: { job: JobName; ok: boolean; detail: unknown }[] = [];
  try {
    if (!acquireLease(db)) {
      console.log("[ingest] another process is ingesting; skipping this run");
      return results;
    }
  } catch (error) {
    console.error("[ingest] could not take the ingestion lease:", error);
    return results;
  }
  try {
    // Runs left unfinished by a process that died (we hold the lease, so nobody else is running).
    db.query(`UPDATE job_runs SET finished_at = ?, ok = 0, detail = '"interrupted"' WHERE finished_at IS NULL`).run(
      new Date().toISOString(),
    );
    // The archive job can take an hour on first run, so the lease is renewed between jobs and
    // the archive job's own progress keeps the run moving.
    for (const job of names) {
      acquireLease(db);
      let id: number | undefined;
      let ok = true;
      let detail: unknown;
      try {
        id = (
          db
            .query("INSERT INTO job_runs (job, started_at) VALUES (?, ?) RETURNING id")
            .get(job, new Date().toISOString()) as {
            id: number;
          }
        ).id;
        detail = await JOBS[job](db, (msg) => {
          console.log(`[ingest] ${msg}`);
          acquireLease(db);
        });
      } catch (error) {
        ok = false;
        detail = error instanceof Error ? error.message : String(error);
        console.error(`[ingest] ${job} failed:`, error);
      }
      try {
        if (id !== undefined)
          db.query("UPDATE job_runs SET finished_at = ?, ok = ?, detail = ? WHERE id = ?").run(
            new Date().toISOString(),
            ok ? 1 : 0,
            JSON.stringify(detail),
            id,
          );
      } catch (error) {
        console.error("[ingest] could not record job run:", error);
      }
      results.push({ job, ok, detail });
    }
  } catch (error) {
    console.error("[ingest] run aborted:", error);
  } finally {
    try {
      releaseLease(db);
    } catch {
      // The lease expires on its own.
    }
  }
  return results;
}
