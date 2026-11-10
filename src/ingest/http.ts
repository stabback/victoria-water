import { USER_AGENT } from "../config.ts";

/** fetch with a descriptive User-Agent, a timeout and polite retries (incl. HTTP 429). */
export async function politeFetch(url: string, { attempts = 4, timeoutMs = 120_000 } = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      // Open-Meteo's per-minute budget resets on the minute; wait it out.
      await Bun.sleep(res.status === 429 ? 61_000 : 5_000 * attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("HTTP 4")) throw error;
      await Bun.sleep(5_000 * attempt);
    }
  }
  throw lastError;
}

export const isoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
