/**
 * ABBA · Real-time economic calendar
 *
 * Uses a free public calendar feed (ForexFactory JSON mirror / similar).
 * Falls back to an empty schedule if the source is unreachable so the
 * engine never blocks on news fetch failure.
 *
 * Filter: high-impact (red) events for USD / EUR / GBP / JPY within a
 * configurable pre/post window. Sessions use wall-clock UTC, not sim time.
 */

export interface NewsEvent {
  id: string;
  title: string;
  country: string; // USD, EUR, …
  impact: "high" | "medium" | "low";
  ts: number; // unix ms UTC
}

export interface NewsWindow {
  active: boolean;
  label: string;
  blockFrom: number; // ms
  blockUntil: number;
  nextEventIn: number; // ms until next high-impact, 0 if unknown
}

const PRE_MS = 5 * 60_000;
const POST_MS = 8 * 60_000;
const RELEVANT = new Set(["USD", "EUR", "GBP", "JPY"]);

let cache: NewsEvent[] = [];
let cacheAt = 0;
const CACHE_TTL = 15 * 60_000;

async function fetchCalendar(): Promise<NewsEvent[]> {
  // Primary: public Forex Factory calendar JSON (community mirrors rotate;
  // override with NEWS_CALENDAR_URL if you have a preferred source).
  const url =
    process.env.NEWS_CALENDAR_URL ||
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return cache;
    const raw = (await res.json()) as Array<{
      title?: string;
      country?: string;
      impact?: string;
      date?: string;
    }>;
    const events: NewsEvent[] = [];
    for (const row of raw) {
      if (!row.date || !row.title) continue;
      const impactRaw = (row.impact || "").toLowerCase();
      let impact: NewsEvent["impact"] = "low";
      if (impactRaw.includes("high") || impactRaw === "red") impact = "high";
      else if (impactRaw.includes("medium") || impactRaw === "orange") impact = "medium";
      const country = (row.country || "").toUpperCase();
      const ts = Date.parse(row.date);
      if (!Number.isFinite(ts)) continue;
      events.push({
        id: `${ts}-${country}-${row.title}`.slice(0, 120),
        title: row.title,
        country,
        impact,
        ts,
      });
    }
    events.sort((a, b) => a.ts - b.ts);
    return events;
  } catch {
    return cache;
  }
}

export async function refreshNewsCalendar(force = false): Promise<NewsEvent[]> {
  if (!force && cache.length && Date.now() - cacheAt < CACHE_TTL) return cache;
  const fresh = await fetchCalendar();
  if (fresh.length) {
    cache = fresh;
    cacheAt = Date.now();
  }
  return cache;
}

export function newsWindowAt(nowMs: number, events?: NewsEvent[]): NewsWindow {
  const list = events ?? cache;
  let active = false;
  let label = "";
  let blockFrom = 0;
  let blockUntil = 0;
  let nextEventIn = 0;

  for (const ev of list) {
    if (ev.impact !== "high") continue;
    if (!RELEVANT.has(ev.country)) continue;
    const from = ev.ts - PRE_MS;
    const until = ev.ts + POST_MS;
    if (nowMs >= from && nowMs < until) {
      active = true;
      label = `${ev.country} ${ev.title}`;
      blockFrom = from;
      blockUntil = until;
      break;
    }
    if (ev.ts > nowMs) {
      nextEventIn = ev.ts - nowMs;
      break;
    }
  }

  return { active, label, blockFrom, blockUntil, nextEventIn };
}
