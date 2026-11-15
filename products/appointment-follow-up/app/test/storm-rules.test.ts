import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  decideHits,
  distanceMiles,
  latestStormDate,
  meshKey,
  nearestReport,
  nextSendTime,
  sizeBand,
  stormDateLong,
  stormDatesBetween,
  stormDay,
  type Candidate,
} from "../src/storm/rules.ts";

const DAY = 24 * 60 * 60 * 1000;

function candidate(id: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    contactId: id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    email: `c${id}@example.com`,
    street: `${id} Oak St`,
    city: "Abilene",
    state: "TX",
    zip: "79601",
    lat: 32.4 + id / 100,
    lon: -99.7,
    optedOut: false,
    lastAlertAt: null,
    ...overrides,
  };
}

describe("storm days", () => {
  it("checks yesterday once the 12:00 UTC file has had time to post", () => {
    assert.equal(latestStormDate(Date.parse("2026-05-13T12:30:00Z")), "2026-05-12");
    assert.equal(latestStormDate(Date.parse("2026-05-13T12:10:00Z")), "2026-05-11");
    assert.equal(latestStormDate(Date.parse("2026-05-13T23:59:00Z")), "2026-05-12");
  });

  it("names the MESH file that covers the day", () => {
    assert.equal(meshKey("2026-05-12"), "CONUS/MESH_Max_1440min_00.50/20260513/MRMS_MESH_Max_1440min_00.50_20260513-120000.grib2.gz");
    assert.equal(meshKey("2026-12-31"), "CONUS/MESH_Max_1440min_00.50/20270101/MRMS_MESH_Max_1440min_00.50_20270101-120000.grib2.gz");
  });

  it("lists dates and names them", () => {
    assert.deepEqual(stormDatesBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    assert.equal(stormDay("2026-05-12"), "Tuesday");
    assert.equal(stormDateLong("2026-05-12"), "Tuesday, May 12");
  });
});

describe("size bands", () => {
  it("uses NWS names for radar estimates", () => {
    assert.equal(sizeBand(25.4), "about 1″ (quarter)");
    assert.equal(sizeBand(32), "about 1.25″ (half dollar)");
    assert.equal(sizeBand(44.45), "about 1.75″ (golf ball)");
    assert.equal(sizeBand(10), "under 0.75″");
    assert.equal(sizeBand(110), "4″ or larger (radar estimate, check ground reports)");
  });
});

describe("ground reports", () => {
  const reports = [
    { size: 1.0, location: "Near", county: "Taylor", state: "TX", lat: 32.45, lon: -99.73 },
    { size: 1.75, location: "Close", county: "Taylor", state: "TX", lat: 32.46, lon: -99.72 },
    { size: 2.5, location: "Far", county: "Jones", state: "TX", lat: 32.8, lon: -99.9 },
  ];

  it("measures miles", () => {
    assert.ok(Math.abs(distanceMiles(32.4, -99.7, 32.5, -99.7) - 6.9) < 0.1);
  });

  it("picks the nearest report within ten miles, favoring bigger hail at about the same distance", () => {
    const best = nearestReport(32.45, -99.73, reports);
    assert.equal(best?.report.location, "Close");
    assert.equal(nearestReport(33.5, -99.7, reports), null);
  });
});

describe("who gets a storm alert", () => {
  const now = Date.parse("2026-05-13T13:00:00Z");
  const values = new Map<number, number>();
  const valueAt = (lat: number) => values.get(Math.round((lat - 32.4) * 100)) ?? 0;

  it("includes customers at or above the threshold, biggest first", () => {
    values.clear();
    values.set(1, 25.4).set(2, 20).set(3, 40);
    const decisions = decideHits([candidate(1), candidate(2), candidate(3)], valueAt, 1, now);
    assert.deepEqual(decisions.map((d) => [d.candidate.contactId, d.skipReason]), [[3, null], [1, null]]);
  });

  it("leaves out unsubscribed customers and anyone alerted in the last 30 days", () => {
    values.clear();
    values.set(1, 30).set(2, 30).set(3, 30);
    const decisions = decideHits(
      [candidate(1, { optedOut: true }), candidate(2, { lastAlertAt: now - 10 * DAY }), candidate(3, { lastAlertAt: now - 31 * DAY })],
      valueAt,
      1,
      now,
    );
    const reasons = Object.fromEntries(decisions.map((d) => [d.candidate.contactId, d.skipReason]));
    assert.equal(reasons[1], "Unsubscribed from storm alerts");
    assert.match(reasons[2]!, /last 30 days/);
    assert.equal(reasons[3], null);
  });

  it("contacts one person per household and per email", () => {
    values.clear();
    values.set(1, 30).set(2, 30).set(3, 30);
    const decisions = decideHits(
      [candidate(1), candidate(2, { street: "1 Oak St.", zip: "79601" }), candidate(3, { email: "C1@example.com", street: "9 Elm" })],
      valueAt,
      1,
      now,
    );
    const reasons = Object.fromEntries(decisions.map((d) => [d.candidate.contactId, d.skipReason]));
    assert.equal(reasons[1], null);
    assert.equal(reasons[2], "Same address as First1 Last1");
    assert.equal(reasons[3], "Same email as First1 Last1");
  });
});

describe("storm send window", () => {
  const s = { timezone: "America/Chicago", stormSendStart: "09:00", stormSendEnd: "18:00" };
  const local = (iso: string) => DateTime.fromISO(iso, { zone: s.timezone }).toMillis();

  it("sends now inside the window", () => {
    assert.equal(nextSendTime(local("2026-05-13T10:15"), s), local("2026-05-13T10:15"));
  });

  it("waits for 9:00 when it's early or late", () => {
    assert.equal(nextSendTime(local("2026-05-13T07:40"), s), local("2026-05-13T09:00"));
    assert.equal(nextSendTime(local("2026-05-13T19:05"), s), local("2026-05-14T09:00"));
    assert.equal(nextSendTime(local("2026-03-07T21:00"), s), local("2026-03-08T09:00"), "across the spring DST change");
  });
});
