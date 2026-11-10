import { expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { runJobs } from "../src/ingest/run.ts";

test("a run is skipped while another process holds the ingestion lease", async () => {
  const db = openDb(":memory:");
  const future = new Date(Date.now() + 60_000).toISOString();
  db.query("INSERT INTO job_lock (id, holder, expires_at) VALUES (1, 'someone-else', ?)").run(future);
  expect(await runJobs(db, ["water-watch"])).toEqual([]);
  expect((db.query("SELECT count(*) AS n FROM job_runs").get() as { n: number }).n).toBe(0);
});

test("an expired lease is taken over, and interrupted runs are closed", async () => {
  const db = openDb(":memory:");
  const past = new Date(Date.now() - 60_000).toISOString();
  db.query("INSERT INTO job_lock (id, holder, expires_at) VALUES (1, 'crashed', ?)").run(past);
  db.query("INSERT INTO job_runs (job, started_at) VALUES ('water-watch', ?)").run(past);
  expect(await runJobs(db, [])).toEqual([]);
  const run = db.query("SELECT ok, detail FROM job_runs").get() as { ok: number; detail: string };
  expect(run).toEqual({ ok: 0, detail: '"interrupted"' });
  expect(db.query("SELECT * FROM job_lock").get()).toBeNull();
});
