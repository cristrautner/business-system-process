import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { MIGRATIONS, migrate, openDb } from "../src/db.ts";
import type { OAuthClient } from "../src/google.ts";
import { DryRunMailer, type Mailer, type OutgoingEmail } from "../src/mailer.ts";
import { Store, type Client } from "../src/store.ts";
import { parseCsv } from "../src/storm/csv.ts";
import type { HailGrid } from "../src/storm/grib2.ts";
import { checkStorms, geocodePending, runReports, sendStormDue, type StormDeps } from "../src/storm/jobs.ts";
import type { GroundReport } from "../src/storm/rules.ts";
import type { Geocoder, HailSource, ReportSource } from "../src/storm/sources.ts";
import { createApp } from "../src/web/app.ts";

const APP_URL = "https://followup.agency.example";
const AUTH = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };
const FROM_DASHBOARD = { ...AUTH, origin: APP_URL };
const zone = "America/Chicago";
const local = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();

/** Hail by street number: customers at "1 Oak St" get hail[1] millimeters. Coordinates encode the number. */
class FakeHail implements HailSource {
  byDate = new Map<string, Map<number, number>>();
  requested: string[] = [];
  set(date: string, values: Record<number, number>) {
    this.byDate.set(date, new Map(Object.entries(values).map(([k, v]) => [Number(k), v])));
  }
  async grid(date: string): Promise<{ key: string; grid: HailGrid } | null> {
    this.requested.push(date);
    const values = this.byDate.get(date);
    if (!values) return null;
    return { key: `mesh/${date}`, grid: { maxNear: (lat: number) => values.get(Math.round((lat - 32) * 1000)) ?? 0 } };
  }
}

class FakeReports implements ReportSource {
  reports: GroundReport[] = [];
  async hailReports(): Promise<GroundReport[]> {
    return this.reports;
  }
}

class FakeGeocoder implements Geocoder {
  calls = 0;
  async locate(address: { street: string }) {
    this.calls++;
    if (address.street.startsWith("999")) return { status: "not_found" as const, note: "No match" };
    if (address.street.startsWith("500")) throw new Error("network down");
    const n = Number(address.street.split(" ")[0]);
    return { status: "matched" as const, lat: 32 + n / 1000, lon: -99.7, note: `${address.street}, matched` };
  }
}

class FlakyMailer implements Mailer {
  readonly dryRun = false;
  async send(_email: OutgoingEmail): Promise<{ id: string }> {
    throw new Error("Resend is down");
  }
}

const CUSTOMERS = [
  "first_name,last_name,email,phone,street,city,state,zip,job_date",
  "Linda,Smith,linda@example.com,555-010-0101,1 Oak St,Abilene,TX,79601,2024-06-02",
  "Ray,Diaz,ray@example.com,555-010-0102,2 Oak St,Abilene,TX,79601,",
  "Ann,Lee,,555-010-0103,3 Oak St,Abilene,TX,79601,",
  "Joe,Park,joe@example.com,,4 Oak St,Abilene,TX,79601,",
  "Nobody,Home,nobody@example.com,,999 Nowhere Rd,Abilene,TX,79601,",
].join("\n");

describe("storm alerts", () => {
  let store: Store;
  let mailer: DryRunMailer;
  let hail: FakeHail;
  let reports: FakeReports;
  let geocoder: FakeGeocoder;
  let clock: number;
  let client: Client;
  let deps: StormDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new Store(openDb(":memory:"));
    mailer = new DryRunMailer(() => {});
    hail = new FakeHail();
    reports = new FakeReports();
    geocoder = new FakeGeocoder();
    clock = local("2026-05-13T07:45");
    client = store.createClient("Sandhill Roofing", "sandhill", clock);
    store.saveSettings(client.id, {
      ...client.settings,
      senderName: "Dusty",
      phone: "(555) 010-0199",
      fromAddress: "dusty@sandhillroofing.example",
      replyTo: "dusty@gmail.example",
      timezone: zone,
      stormEnabled: true,
      businessAddress: "PO Box 12, Abilene, TX 79601",
      postcardsEnabled: true,
      postcardOrderEmail: "orders@infusionmedia.example",
    });
    client = store.client(client.id)!;
    deps = { store, mailer, hail, reports, geocoder, appUrl: APP_URL, now: () => clock, log: () => {} };
    app = createApp({
      store,
      oauth: { authUrl: () => "", exchangeCode: async () => ({ refreshToken: "", email: null }) } satisfies OAuthClient,
      mailer, tokenKey: randomBytes(32), appUrl: APP_URL, adminUser: "admin", adminPassword: "secret", now: () => clock, log: () => {},
    });
  });

  async function importAndLocate() {
    const res = await app.request(`/clients/${client.id}/import`, { method: "POST", headers: FROM_DASHBOARD, body: new URLSearchParams({ csv: CUSTOMERS }) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Added 5 and updated 0 customers/);
    await geocodePending(deps);
  }

  async function stormMorning(values: Record<number, number>) {
    hail.set("2026-05-12", values);
    await checkStorms(deps);
    const day = store.storm.stormDayFor(client.id, "2026-05-12");
    assert.ok(day, "a storm day was created");
    return day;
  }

  it("imports customers and locates them", async () => {
    await importAndLocate();
    const counts = store.storm.customerCounts(client.id);
    assert.deepEqual(counts, { customers: 5, located: 4, notFound: 1, waiting: 0, withEmail: 4 });
    assert.equal(store.storm.unlocated(client.id)[0]?.name, "Nobody Home");
  });

  it("matches imported rows to existing contacts, and relocates them when the address changes", async () => {
    store.upsertContact(client.id, {
      firstName: "Linda", lastName: "Smith", email: "linda@example.com", phone: null, street: "77 Old Rd", city: "Abilene", state: "TX",
      zip: "79601", service: "Inspection", insuranceClaim: null, notes: null, source: "website",
    }, "", clock);
    await geocodePending(deps);
    const res = await app.request(`/clients/${client.id}/import`, { method: "POST", headers: FROM_DASHBOARD, body: new URLSearchParams({ csv: CUSTOMERS }) });
    assert.match(await res.text(), /Added 4 and updated 1 customers/);
    const linda = store.contacts(client.id).find((c) => c.email === "linda@example.com")!;
    assert.equal(linda.isCustomer, true);
    assert.equal(linda.service, "Inspection", "existing details are kept");
    assert.equal(linda.street, "1 Oak St");
    assert.equal(linda.geocodeStatus, null, "moved, so it gets located again");
  });

  it("marks failed lookups and tries them again after the next storm check", async () => {
    store.upsertContact(client.id, {
      firstName: "Net", lastName: "Down", email: "n@example.com", phone: null, street: "500 Elm", city: "Abilene", state: "TX",
      zip: "79601", service: null, insuranceClaim: null, notes: null, source: "website",
    }, "", clock);
    await geocodePending(deps);
    assert.equal(store.contacts(client.id)[0]?.geocodeStatus, "error");
    hail.set("2026-05-12", {});
    await checkStorms(deps);
    assert.equal(store.contacts(client.id)[0]?.geocodeStatus, null);
  });

  it("finds hit customers the morning after and emails the contractor a review link", async () => {
    await importAndLocate();
    reports.reports = [{ size: 1.5, location: "2 N Abilene", county: "Taylor", state: "TX", lat: 32.002, lon: -99.69 }];
    const day = await stormMorning({ 1: 38, 2: 26, 3: 30, 4: 10 });
    const hits = store.storm.hits(day.id);
    assert.deepEqual(hits.map((h) => [h.firstName, h.status]), [["Linda", "pending"], ["Ann", "pending"], ["Ray", "pending"]]);
    assert.equal(hits[0]!.reportSize, 1.5);

    const summary = mailer.sent.at(-1)!;
    assert.equal(summary.to, "dusty@gmail.example", "falls back to the reply-to address");
    assert.equal(summary.subject, "Hail hit 3 of your customers on Tuesday");
    assert.match(summary.text, new RegExp(`${APP_URL}/storm/${day.reviewToken}`));
    assert.match(summary.text, /Linda Smith, 1 Oak St: about 1.5″ \(ping pong ball\); ground report of 1.50″/);
    assert.match(summary.text, /Ann Lee, 3 Oak St: about 1″ \(quarter\), no email on file/);
    assert.equal(mailer.sent.filter((e) => !e.subject.startsWith("Hail hit")).length, 0, "nothing goes to homeowners yet");

    await checkStorms(deps);
    assert.equal(mailer.sent.length, 1, "the same storm day isn't checked twice");
  });

  it("does nothing when the file isn't posted, nobody was hit, or the client isn't ready", async () => {
    await importAndLocate();
    await checkStorms(deps);
    assert.equal(store.storm.run("2026-05-12"), undefined, "not posted yet, so it tries again later");

    hail.set("2026-05-12", { 1: 5 });
    await checkStorms(deps);
    assert.equal(store.storm.run("2026-05-12")?.status, "done");
    assert.equal(store.storm.stormDays(client.id).length, 0);

    store.saveSettings(client.id, { ...client.settings, businessAddress: "" });
    clock = local("2026-05-14T07:45");
    hail.set("2026-05-13", { 1: 50 });
    hail.requested = [];
    await checkStorms(deps);
    assert.deepEqual(hail.requested, [], "no client is ready, so nothing is downloaded");
  });

  it("sends approved emails in the window, with the required footer and one-click unsubscribe", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38, 2: 26, 3: 30 });
    const [linda, ann, ray] = store.storm.hits(day.id);

    // Dusty unticks Ray and sends at 7:50 AM, before the 9:00 window.
    const res = await app.request(`/storm/${day.reviewToken}`, {
      method: "POST",
      body: new URLSearchParams([["hit", String(linda!.id)], ["hit", String(ann!.id)], ["action", "send"]]),
    });
    assert.equal(res.status, 303);
    assert.equal(store.storm.stormDay(day.id)?.status, "approved");
    assert.equal(store.storm.hit(ray!.id)?.status, "removed");
    assert.equal(store.storm.hit(ann!.id)?.status, "skipped", "no email and no postcard means nothing to send");

    clock = local("2026-05-13T08:30");
    await sendStormDue(deps);
    assert.equal(mailer.sent.length, 1, "waits for 9:00");
    clock = local("2026-05-13T09:01");
    await sendStormDue(deps);
    const email = mailer.sent.at(-1)!;
    assert.equal(email.to, "linda@example.com");
    assert.equal(email.from, '"Dusty at Sandhill Roofing" <dusty@sandhillroofing.example>');
    assert.equal(email.replyTo, "dusty@gmail.example");
    assert.equal(email.subject, "Hail near your home on Tuesday");
    assert.match(email.text, /^Hi Linda,\n\nWeather radar showed hail passing near 1 Oak St on Tuesday\./);
    assert.doesNotMatch(email.text, /deductible|insurance|″/i);
    const unsubscribe = `${APP_URL}/u/${linda!.unsubToken}`;
    assert.ok(email.text.endsWith(`--\nSandhill Roofing · PO Box 12, Abilene, TX 79601\nDon't want storm alerts? ${unsubscribe}`));
    assert.deepEqual(email.headers, { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    assert.equal(store.storm.hit(linda!.id)?.emailStatus, "sent");

    const page = await (await app.request(`/storm/${day.reviewToken}`)).text();
    assert.match(page, /Approved/);
    assert.doesNotMatch(page, /name="action"/, "can't be sent twice");
  });

  it("honors unsubscribes from the link, including one-click, and skips that customer next time", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38 });
    const [linda] = store.storm.hits(day.id);
    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams([["hit", String(linda!.id)], ["action", "send"]]) });

    const page = await app.request(`/u/${linda!.unsubToken}`);
    assert.match(await page.text(), /stop sending storm alerts to <strong>linda@example.com/);
    const res = await app.request(`/u/${linda!.unsubToken}`, { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) });
    assert.equal(res.status, 200);
    assert.equal(store.storm.hit(linda!.id)?.emailStatus, "failed", "the queued email is stopped");

    clock = local("2026-05-13T10:00");
    await sendStormDue(deps);
    assert.equal(mailer.sent.filter((e) => e.to === "linda@example.com").length, 0);

    clock = local("2026-07-01T07:45");
    hail.set("2026-06-30", { 1: 40, 2: 40 });
    await checkStorms(deps);
    const next = store.storm.stormDayFor(client.id, "2026-06-30")!;
    const lindaAgain = store.storm.hits(next.id).find((h) => h.firstName === "Linda")!;
    assert.equal(lindaAgain.status, "skipped");
    assert.equal(lindaAgain.reason, "Unsubscribed from storm alerts");
  });

  it("doesn't alert the same customer twice in 30 days", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38 });
    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams([["hit", String(store.storm.hits(day.id)[0]!.id)], ["action", "send"]]) });
    clock = local("2026-05-20T07:45");
    hail.set("2026-05-19", { 1: 40, 2: 40 });
    await checkStorms(deps);
    const second = store.storm.hits(store.storm.stormDayFor(client.id, "2026-05-19")!.id);
    assert.deepEqual(second.map((h) => [h.firstName, h.status]), [["Linda", "skipped"], ["Ray", "pending"]]);
  });

  it("builds a Smartpress mailing list when the contractor asks for postcards", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38, 3: 30 });
    const hitIds = store.storm.hits(day.id).map((h) => ["hit", String(h.id)]);
    const review = await (await app.request(`/storm/${day.reviewToken}`)).text();
    assert.match(review, /Also mail each one a postcard \(about \$1.70 for 2/);

    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams([...hitIds, ["postcards", "on"], ["action", "send"]]) });
    const batch = store.storm.batches(client.id)[0]!;
    assert.equal(batch.pieceCount, 2, "Ann has no email but still gets a card");
    assert.equal(batch.status, "needs_order");
    const notice = mailer.sent.at(-1)!;
    assert.equal(notice.to, "orders@infusionmedia.example");
    assert.match(notice.text, new RegExp(`${APP_URL}/postcard-batches/${batch.id}`));

    assert.equal((await app.request(`/postcard-batches/${batch.id}/mailing-list.csv`)).status, 401, "behind the agency login");
    const csv = await app.request(`/postcard-batches/${batch.id}/mailing-list.csv`, { headers: AUTH });
    assert.match(csv.headers.get("content-disposition") ?? "", /sandhill-storm-postcards-/);
    const rows = parseCsv(await csv.text());
    assert.deepEqual(rows[0], ["FirstName", "LastName", "Address1", "City", "State", "Zip", "Headline", "Message", "Street", "StormDate"]);
    const ann = rows.find((r) => r[0] === "Ann")!;
    assert.deepEqual(ann.slice(0, 6), ["Ann", "Lee", "3 Oak St", "Abilene", "TX", "79601"]);
    assert.equal(ann[6], "Hail came through your neighborhood");
    assert.match(ann[7]!, /^Hi Ann,\n\nWeather radar showed hail passing near 3 Oak St on Tuesday, May 12\./);
    assert.match(ann[7]!, /call \(555\) 010-0199/);
    assert.equal(ann[9], "Tuesday, May 12");

    const marked = await app.request(`/postcard-batches/${batch.id}/ordered`, { method: "POST", headers: FROM_DASHBOARD, body: new URLSearchParams({ order_ref: "SP-48213" }) });
    assert.equal(marked.status, 303);
    assert.equal(store.storm.batch(batch.id)?.orderRef, "SP-48213");
  });

  it("lets the contractor dismiss a storm day, and expires ones nobody reviews", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38 });
    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams({ action: "dismiss" }) });
    assert.equal(store.storm.stormDay(day.id)?.status, "dismissed");
    assert.match(await (await app.request(`/storm/${day.reviewToken}`)).text(), /chose not to send anything/);

    clock = local("2026-05-20T07:45");
    hail.set("2026-05-19", { 2: 40 });
    await checkStorms(deps);
    const later = store.storm.stormDayFor(client.id, "2026-05-19")!;
    clock += 73 * 60 * 60 * 1000;
    store.storm.expireDays(clock);
    assert.equal(store.storm.stormDay(later.id)?.status, "expired");
    const res = await app.request(`/storm/${later.reviewToken}`, { method: "POST", body: new URLSearchParams({ action: "send" }) });
    assert.equal(res.status, 303);
    assert.equal(store.storm.hits(later.id)[0]?.emailStatus, null, "an expired link can't send");
  });

  it("uses shadow mode for storm emails and the summary", async () => {
    await importAndLocate();
    store.saveSettings(client.id, { ...store.client(client.id)!.settings, shadowEmail: "cris@infusionmedia.example" });
    const day = await stormMorning({ 1: 38 });
    assert.equal(mailer.sent.at(-1)!.to, "cris@infusionmedia.example");
    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams([["hit", String(store.storm.hits(day.id)[0]!.id)], ["action", "send"]]) });
    clock = local("2026-05-13T09:30");
    await sendStormDue(deps);
    assert.equal(mailer.sent.at(-1)!.to, "cris@infusionmedia.example");
    assert.match(mailer.sent.at(-1)!.subject, /^\[Shadow for linda@example.com\] Hail near your home/);
  });

  it("retries failed sends for an hour, then gives up", async () => {
    await importAndLocate();
    const day = await stormMorning({ 1: 38 });
    await app.request(`/storm/${day.reviewToken}`, { method: "POST", body: new URLSearchParams([["hit", String(store.storm.hits(day.id)[0]!.id)], ["action", "send"]]) });
    const flaky = { ...deps, mailer: new FlakyMailer() };
    clock = local("2026-05-13T09:30");
    await sendStormDue(flaky);
    const hit = store.storm.hits(day.id)[0]!;
    assert.equal(hit.emailStatus, "queued");
    assert.match(hit.emailReason ?? "", /Retrying: Resend is down/);
    clock += 61 * 60 * 1000;
    await sendStormDue(flaky);
    assert.equal(store.storm.hits(day.id)[0]!.emailStatus, "failed");
  });

  it("replays past storms for the report, a few days at a time", async () => {
    await importAndLocate();
    hail.set("2026-04-02", { 1: 30, 2: 45 });
    hail.set("2026-04-20", { 2: 26 });
    hail.set("2026-04-21", { 4: 12 });
    for (const date of ["2026-04-01", "2026-04-03", "2026-04-19", "2026-04-22"]) hail.set(date, {});
    const report = store.storm.createReport(client.id, "2026-04-01", "2026-04-22", 1, clock);
    await runReports(deps, 15);
    assert.equal(store.storm.report(report.id)?.status, "running");
    await runReports(deps, 15);
    const done = store.storm.report(report.id)!;
    assert.equal(done.status, "done");
    assert.equal(done.daysChecked, 22);
    assert.equal(done.daysMissing, 15);
    assert.deepEqual(done.result.map((d) => [d.stormDate, d.hits.map((h) => h.name)]), [
      ["2026-04-02", ["Ray Diaz", "Linda Smith"]],
      ["2026-04-20", ["Ray Diaz"]],
    ]);
    const page = await (await app.request(`/storm-reports/${report.id}`, { headers: AUTH })).text();
    assert.match(page, /Hail hit 2 of Sandhill Roofing's past customers on 2 different days/);
  });

  it("saves storm settings from the dashboard and shows the storm section", async () => {
    const form = new URLSearchParams({
      businessName: "Sandhill Roofing", senderName: "Dusty", phone: "(555) 010-0199", fromAddress: "dusty@sandhillroofing.example",
      replyTo: "dusty@gmail.example", timezone: zone, delayMinutes: "120", quietStart: "20:00", quietEnd: "07:30", estimateTurnaroundDays: "2",
      keywords: "inspection = inspection", stormEnabled: "on", stormThresholdInches: "1.25", stormSendStart: "08:30", stormSendEnd: "17:00",
      stormNotifyEmail: "dusty@sandhillroofing.example", businessAddress: "PO Box 12, Abilene, TX 79601", postcardOrderEmail: "", postcardCost: "0.9",
    });
    const res = await app.request(`/clients/${client.id}/settings`, { method: "POST", headers: FROM_DASHBOARD, body: form });
    assert.equal(res.status, 303);
    const s = store.client(client.id)!.settings;
    assert.equal(s.stormThresholdInches, 1.25);
    assert.equal(s.stormSendStart, "08:30");
    assert.equal(s.postcardsEnabled, false);
    assert.equal(s.postcardCost, 0.9);
    const page = await (await app.request(`/clients/${client.id}`, { headers: AUTH })).text();
    assert.match(page, /Storm alerts/);
    assert.match(page, /at 1.25″ or more/);
  });

  it("rejects a bad review or unsubscribe link", async () => {
    assert.equal((await app.request("/storm/not-a-token")).status, 404);
    assert.equal((await app.request("/u/not-a-token", { method: "POST" })).status, 404);
  });
});

describe("migration to storm alerts", () => {
  it("keeps existing sends when the sends table is rebuilt", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(MIGRATIONS[0]!);
    db.exec("PRAGMA user_version = 1");
    db.exec(`INSERT INTO clients (id, name, slug, lead_api_key, connect_token, created_at) VALUES (1, 'A', 'a', 'k', 't', 0);
      INSERT INTO appointments (id, client_id, event_id, title, type, start_at, end_at, send_at, status, created_at, updated_at)
        VALUES (7, 1, 'e', 'Inspection', 'inspection', 0, 0, 0, 'sent', 0, 0);
      INSERT INTO sends (appointment_id, provider_id, to_address, subject, body, dry_run, sent_at) VALUES (7, 'p', 'x@example.com', 's', 'b', 0, 5);`);
    migrate(db);
    const row = db.prepare("SELECT appointment_id, storm_hit_id, to_address FROM sends").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { appointment_id: 7, storm_hit_id: null, to_address: "x@example.com" });
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  });
});
