// Where storm alert data comes from: NOAA MRMS hail grids, SPC ground reports, and the
// US Census geocoder. All free and public, no API keys.

import { gunzipSync } from "node:zlib";
import { DateTime } from "luxon";
import { parseGrib2, type HailGrid } from "./grib2.ts";
import { meshKey, type GroundReport } from "./rules.ts";

const USER_AGENT = "storm-alert/0.1 (contractor storm alerts)";

export interface HailSource {
  /** The MESH grid for a storm date, or null if NOAA hasn't posted it (or never will). */
  grid(stormDate: string): Promise<{ key: string; grid: HailGrid } | null>;
}

export interface ReportSource {
  /** SPC's filtered hail reports for a storm date. Empty when there are none or the file isn't there. */
  hailReports(stormDate: string): Promise<GroundReport[]>;
}

export interface Geocoder {
  locate(address: { street: string; city: string; state: string; zip: string }): Promise<
    { status: "matched"; lat: number; lon: number; note: string } | { status: "not_found"; note: string }
  >;
}

export class MrmsHailSource implements HailSource {
  private readonly baseUrl: string;
  private cache: { date: string; key: string; grid: HailGrid } | null = null;

  constructor(baseUrl = "https://noaa-mrms-pds.s3.amazonaws.com") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async grid(stormDate: string): Promise<{ key: string; grid: HailGrid } | null> {
    if (this.cache?.date === stormDate) return { key: this.cache.key, grid: this.cache.grid };
    const key = meshKey(stormDate);
    const response = await fetch(`${this.baseUrl}/${key}`, { headers: { "user-agent": USER_AGENT } });
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`MRMS download failed: HTTP ${response.status}`);
    const grid = parseGrib2(gunzipSync(Buffer.from(await response.arrayBuffer())));
    // Keep one decoded grid (about 50 MB) so every client checked for the same day shares it.
    this.cache = { date: stormDate, key, grid };
    return { key, grid };
  }
}

/** Parses SPC's hail CSV: Time,Size,Location,County,State,Lat,Lon,Comments. Size is in hundredths of an inch. */
export function parseSpcHailCsv(text: string): GroundReport[] {
  const reports: GroundReport[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split(",");
    if (fields.length < 7 || !/^\d{3,4}$/.test(fields[0]!.trim())) continue;
    const size = Number(fields[1]);
    let lat = Number(fields[5]);
    let lon = Number(fields[6]);
    if (!Number.isFinite(size) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Some SPC tables drop the decimal point (3390 for 33.90) or the minus sign on west longitudes.
    if (Math.abs(lat) > 90) lat /= 100;
    if (Math.abs(lon) > 180) lon /= 100;
    if (lon > 0) lon = -lon;
    reports.push({ size: size / 100, location: fields[2]!.trim(), county: fields[3]!.trim(), state: fields[4]!.trim(), lat, lon });
  }
  return reports;
}

export class SpcReportSource implements ReportSource {
  private readonly baseUrl: string;

  constructor(baseUrl = "https://www.spc.noaa.gov/climo/reports") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async hailReports(stormDate: string): Promise<GroundReport[]> {
    const yymmdd = DateTime.fromISO(stormDate, { zone: "utc" }).toFormat("yyLLdd");
    const response = await fetch(`${this.baseUrl}/${yymmdd}_rpts_filtered_hail.csv`, { headers: { "user-agent": USER_AGENT } });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`SPC reports download failed: HTTP ${response.status}`);
    return parseSpcHailCsv(await response.text());
  }
}

export class CensusGeocoder implements Geocoder {
  private readonly baseUrl: string;

  constructor(baseUrl = "https://geocoding.geo.census.gov/geocoder") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async locate(address: { street: string; city: string; state: string; zip: string }) {
    const params = new URLSearchParams({
      street: address.street,
      city: address.city,
      state: address.state,
      zip: address.zip,
      benchmark: "Public_AR_Current",
      format: "json",
    });
    const response = await fetch(`${this.baseUrl}/locations/address?${params}`, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Census geocoder failed: HTTP ${response.status}`);
    const data = (await response.json()) as {
      result?: { addressMatches?: { matchedAddress?: string; coordinates?: { x?: number; y?: number } }[] };
    };
    const matches = data.result?.addressMatches ?? [];
    const first = matches[0];
    if (!first?.coordinates || typeof first.coordinates.x !== "number" || typeof first.coordinates.y !== "number") {
      return { status: "not_found" as const, note: "The Census geocoder didn't recognize this address." };
    }
    const note = `${first.matchedAddress ?? "Matched"}${matches.length > 1 ? ` (first of ${matches.length} matches)` : ""}`;
    return { status: "matched" as const, lat: first.coordinates.y, lon: first.coordinates.x, note };
  }
}
