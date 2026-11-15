// Storm alert decisions: which storm day to check, which customers count as hit, who gets
// contacted, and when. Pure functions, no I/O.

import { DateTime } from "luxon";
import type { ClientSettings } from "../settings.ts";

export const MM_PER_INCH = 25.4;
/** One storm alert per homeowner per contractor in this many days, however many storms come through. */
export const COOLDOWN_DAYS = 30;
/** An unreviewed storm day expires after this long. A week-old storm note reads as opportunistic. */
export const REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Ground reports this close to a hit are shown as corroboration. */
export const REPORT_RADIUS_MILES = 10;
/** MESH for a storm day is the 24-hour maximum ending 12:00 UTC the next day. Wait a little for it to post. */
const POSTED_AFTER_UTC_MINUTES = 12 * 60 + 20;

/** A storm day runs 12:00 UTC to 11:59 UTC the next day, the same as SPC's storm reports. */
export function latestStormDate(now: number): string {
  const utc = DateTime.fromMillis(now, { zone: "utc" });
  const minutes = utc.hour * 60 + utc.minute;
  return utc.minus({ days: minutes >= POSTED_AFTER_UTC_MINUTES ? 1 : 2 }).toISODate()!;
}

/** Storm dates from `from` to `to`, inclusive, as YYYY-MM-DD. */
export function stormDatesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  let day = DateTime.fromISO(from, { zone: "utc" });
  const last = DateTime.fromISO(to, { zone: "utc" });
  while (day <= last) {
    dates.push(day.toISODate()!);
    day = day.plus({ days: 1 });
  }
  return dates;
}

/** S3 key of the MESH file covering a storm date. */
export function meshKey(stormDate: string): string {
  const next = DateTime.fromISO(stormDate, { zone: "utc" }).plus({ days: 1 }).toFormat("yyyyLLdd");
  return `CONUS/MESH_Max_1440min_00.50/${next}/MRMS_MESH_Max_1440min_00.50_${next}-120000.grib2.gz`;
}

/** Weekday name for the homeowner email: "Tuesday". */
export function stormDay(stormDate: string): string {
  return DateTime.fromISO(stormDate, { zone: "utc" }).setLocale("en-US").toFormat("cccc");
}

/** Weekday and date for postcards, which arrive days later: "Tuesday, May 12". */
export function stormDateLong(stormDate: string): string {
  return DateTime.fromISO(stormDate, { zone: "utc" }).setLocale("en-US").toFormat("cccc, LLLL d");
}

// NWS hail-size names, smallest first.
const SIZES: [number, string][] = [
  [0.75, "penny"],
  [0.88, "nickel"],
  [1.0, "quarter"],
  [1.25, "half dollar"],
  [1.5, "ping pong ball"],
  [1.75, "golf ball"],
  [2.0, "hen egg"],
  [2.5, "tennis ball"],
  [2.75, "baseball"],
  [3.0, "tea cup"],
];

/** How the contractor sees a radar estimate: “about 1.25″ (half dollar).” */
export function sizeBand(mm: number): string {
  const inches = mm / MM_PER_INCH;
  if (inches >= 4) return "4″ or larger (radar estimate, check ground reports)";
  let band: [number, string] | null = null;
  for (const size of SIZES) if (inches >= size[0] - 0.005) band = size;
  if (!band) return `under 0.75″`;
  return `about ${band[0].toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}″ (${band[1]})`;
}

export function inches(mm: number): string {
  return `${(mm / MM_PER_INCH).toFixed(2)}″`;
}

export function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

export interface GroundReport {
  /** Hail size in inches. */
  size: number;
  location: string;
  county: string;
  state: string;
  lat: number;
  lon: number;
}

/** The nearest ground report within the radius, preferring larger hail at similar distance. */
export function nearestReport(lat: number, lon: number, reports: GroundReport[], radiusMiles = REPORT_RADIUS_MILES) {
  let best: { report: GroundReport; miles: number } | null = null;
  for (const report of reports) {
    const miles = distanceMiles(lat, lon, report.lat, report.lon);
    if (miles > radiusMiles) continue;
    if (!best || miles < best.miles - 1 || (Math.abs(miles - best.miles) <= 1 && report.size > best.report.size)) best = { report, miles };
  }
  return best;
}

export interface Candidate {
  contactId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  street: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lon: number;
  optedOut: boolean;
  /** When this contact last got a storm alert from this contractor, if ever. */
  lastAlertAt: number | null;
}

export interface HitDecision {
  candidate: Candidate;
  mm: number;
  /** null means include; otherwise why this customer is left out. */
  skipReason: string | null;
}

function addressKey(c: Candidate): string {
  return `${c.street}|${c.zip}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
}

/**
 * Customers at or above the threshold, each marked included or skipped with a reason.
 * Below-threshold customers aren't returned at all.
 */
export function decideHits(
  candidates: Candidate[],
  valueAt: (lat: number, lon: number) => number,
  thresholdInches: number,
  now: number,
): HitDecision[] {
  const thresholdMm = thresholdInches * MM_PER_INCH;
  const seenAddresses = new Map<string, Candidate>();
  const seenEmails = new Map<string, Candidate>();
  const decisions: HitDecision[] = [];
  for (const candidate of candidates) {
    const mm = valueAt(candidate.lat, candidate.lon);
    if (mm < thresholdMm) continue;
    let skipReason: string | null = null;
    const address = addressKey(candidate);
    const email = candidate.email?.toLowerCase() ?? null;
    if (candidate.optedOut) skipReason = "Unsubscribed from storm alerts";
    else if (candidate.lastAlertAt !== null && now - candidate.lastAlertAt < COOLDOWN_DAYS * 24 * 60 * 60 * 1000) {
      skipReason = `Already got a storm alert in the last ${COOLDOWN_DAYS} days`;
    } else if (seenAddresses.has(address)) {
      const first = seenAddresses.get(address)!;
      skipReason = `Same address as ${first.firstName} ${first.lastName}`;
    } else if (email && seenEmails.has(email)) {
      const first = seenEmails.get(email)!;
      skipReason = `Same email as ${first.firstName} ${first.lastName}`;
    }
    if (!skipReason) {
      seenAddresses.set(address, candidate);
      if (email) seenEmails.set(email, candidate);
    }
    decisions.push({ candidate, mm, skipReason });
  }
  return decisions.sort((a, b) => b.mm - a.mm);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Now, if it's inside the client's storm send window; otherwise the next time the window opens. */
export function nextSendTime(now: number, s: Pick<ClientSettings, "timezone" | "stormSendStart" | "stormSendEnd">): number {
  const local = DateTime.fromMillis(now, { zone: s.timezone });
  const start = minutesOf(s.stormSendStart);
  const end = minutesOf(s.stormSendEnd);
  const minute = local.hour * 60 + local.minute;
  if (minute >= start && minute < end) return now;
  const day = minute < start ? local : local.plus({ days: 1 });
  return day.set({ hour: Math.floor(start / 60), minute: start % 60, second: 0, millisecond: 0 }).toMillis();
}
