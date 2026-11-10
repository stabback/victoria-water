import type { Database } from "bun:sqlite";
import { politeFetch } from "./http.ts";
import { parseWaterWatchPdf, upsertReport } from "./water-watch.ts";
import manifest from "./wayback-manifest.json";

/**
 * One-time historical backfill of 2009–2021 Water Watch reports from the Internet Archive.
 *
 * RULE: each archived URL is attempted once and recorded in `source_files`, success or not, so
 * this job is a no-op (no network) once the backfill has run. Requests are spaced out — the
 * Wayback Machine is a shared public service.
 */
export async function ingestWaterWatchArchive(db: Database, log: (msg: string) => void = console.log) {
  // Done = produced a report, or failed within the last week (retried after that, so a flaky
  // capture gets another chance without hammering the archive every run).
  const seen = new Set(
    (
      db
        .query(
          `SELECT url FROM source_files
           WHERE reports_found > 0 OR rejected IS NOT NULL OR fetched_at > datetime('now', '-7 days')`,
        )
        .all() as { url: string }[]
    ).map((r) => r.url),
  );
  const haveDates = new Set(
    (db.query("SELECT report_date FROM reservoir_reports").all() as { report_date: string }[]).map(
      (r) => r.report_date,
    ),
  );
  const todo = manifest.entries.filter((e) => !seen.has(e.url) && !(e.date && haveDates.has(e.date)));
  if (todo.length) log(`water-watch-archive: ${todo.length} archived reports to fetch`);
  let added = 0;
  const failed: string[] = [];
  const record = db.query(
    `INSERT OR REPLACE INTO source_files (url, title, label, bytes, sha256, fetched_at, reports_found, rejected, error)
     VALUES (?, ?, 'Internet Archive', ?, ?, ?, ?, ?, ?)`,
  );
  let done = 0;
  const work = async (entry: (typeof todo)[number]) => {
    let error: string | null = null;
    // TRAP: the Wayback Machine sometimes answers 200 with an empty body; retry once before
    // moving on to an alternate capture.
    for (const url of [entry.url, entry.url, ...entry.alternates]) {
      try {
        await Bun.sleep(1_200);
        const data = new Uint8Array(await (await politeFetch(url, { attempts: 2, timeoutMs: 60_000 })).arrayBuffer());
        if (data.byteLength < 500 || new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-") {
          throw new Error(`not a PDF (${data.byteLength} bytes)`);
        }
        // TRAP: pdf.js detaches the buffer it is given — measure and hash before parsing.
        const bytes = data.byteLength;
        const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
        const { reports, rejected } = await parseWaterWatchPdf(data);
        if (!reports.length && !rejected.length) throw new Error("no Water Watch summary found in PDF");
        db.transaction(() => {
          for (const { report, page, text } of reports) {
            if (!haveDates.has(report.reportDate)) upsertReport(db, report, url, page, text);
            haveDates.add(report.reportDate);
          }
          record.run(
            entry.url,
            `Water Watch ${entry.date ?? ""}`.trim(),
            bytes,
            sha256,
            new Date().toISOString(),
            reports.length,
            rejected.length ? JSON.stringify(rejected) : null,
            null,
          );
        })();
        added += reports.length;
        error = null;
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        await Bun.sleep(3_000);
      }
    }
    if (error) {
      failed.push(`${entry.date ?? "undated"} ${entry.url}: ${error}`);
      try {
        record.run(
          entry.url,
          `Water Watch ${entry.date ?? ""}`.trim(),
          null,
          null,
          new Date().toISOString(),
          0,
          null,
          error,
        );
      } catch (e) {
        failed.push(`could not record failure for ${entry.url}: ${e}`);
      }
    }
    if (++done % 25 === 0) log(`water-watch-archive: ${done}/${todo.length} (${added} reports)`);
  };
  // A small worker pool: three requests in flight at most, each worker pausing between requests.
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) await work(entry);
    }),
  );
  return { attempted: todo.length, reportsAdded: added, failed };
}
