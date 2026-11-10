/**
 * `bun run ingest [job ...]` — run ingestion by hand. With no arguments every job runs; on an
 * empty database that is the full historical backfill.
 */
import { db } from "../db.ts";
import { JOBS, type JobName, runJobs } from "./run.ts";

const names = process.argv.slice(2) as JobName[];
for (const n of names) {
  if (!(n in JOBS)) {
    console.error(`Unknown job "${n}". Jobs: ${Object.keys(JOBS).join(", ")}`);
    process.exit(1);
  }
}
const results = await runJobs(db(), names.length ? names : undefined);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
