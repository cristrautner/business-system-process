// Storm alert background work: locate customers, check last night's hail every morning,
// tell the contractor, send approved emails, and replay past storms for reports.

import { fromHeader, type Mailer } from "../mailer.ts";
import { stormReadinessProblems } from "../settings.ts";
import type { Client, Store } from "../store.ts";
import { render, type Template } from "../templates.ts";
import { when } from "../web/html.ts";
import { toCsv } from "./csv.ts";
import {
  decideHits,
  latestStormDate,
  meshKey,
  MM_PER_INCH,
  nearestReport,
  REVIEW_WINDOW_MS,
  sizeBand,
  stormDateLong,
  stormDatesBetween,
  stormDay,
  type GroundReport,
} from "./rules.ts";
import type { Geocoder, HailSource, ReportSource } from "./sources.ts";
import type { PostcardBatch, StormDay, StormHit, StormReportDay } from "./store.ts";

export interface StormDeps {
  store: Store;
  mailer: Mailer;
  hail: HailSource;
  reports: ReportSource;
  geocoder: Geocoder;
  appUrl: string;
  now: () => number;
  log: (message: string) => void;
}

const HOUR = 60 * 60 * 1000;
const RETRY_WINDOW_MS = HOUR;

export function stormClients(store: Store): Client[] {
  return store.clients().filter((c) => c.settings.stormEnabled && !c.paused && stormReadinessProblems(c.settings).length === 0);
}

// Locating customers

export async function geocodePending(deps: Pick<StormDeps, "store" | "geocoder" | "now" | "log">, limit = 25): Promise<number> {
  let done = 0;
  for (const task of deps.store.storm.geocodeQueue(limit)) {
    try {
      const result = await deps.geocoder.locate(task);
      deps.store.storm.saveGeocode(task.id, result, deps.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.store.storm.saveGeocode(task.id, { status: "error", note: message }, deps.now());
      deps.log(`geocoding contact ${task.id} failed: ${message}`);
    }
    done++;
  }
  return done;
}

// The morning check

export async function checkStorms(deps: StormDeps): Promise<void> {
  const { store, now, log } = deps;
  const stormDate = latestStormDate(now());
  // Retry notifications that failed earlier, whatever day they were for.
  for (const day of store.storm.unnotifiedDays()) {
    const client = store.client(day.clientId);
    if (client) await notifyStormDay(deps, client, day).catch((e) => log(`storm summary for day ${day.id} failed again: ${String(e)}`));
  }

  if (store.storm.run(stormDate)?.status === "done") return;
  const clients = stormClients(store);
  if (clients.length === 0) return;

  const key = meshKey(stormDate);
  try {
    const found = await deps.hail.grid(stormDate);
    if (!found) return; // Not posted yet. The next tick tries again.
    const reports = await deps.reports.hailReports(stormDate).catch((error) => {
      log(`SPC reports for ${stormDate} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [] as GroundReport[];
    });

    let maxMm = 0;
    for (const client of clients) {
      const candidates = store.storm.candidates(client.id);
      const decisions = decideHits(candidates, (lat, lon) => found.grid.maxNear(lat, lon), client.settings.stormThresholdInches, now());
      if (!decisions.some((d) => !d.skipReason)) continue;
      const withReports = decisions.map((d) => ({ ...d, report: nearestReport(d.candidate.lat, d.candidate.lon, reports) }));
      maxMm = Math.max(maxMm, ...decisions.map((d) => d.mm));
      const day = store.storm.createStormDay(client.id, stormDate, found.key, withReports, now(), now() + REVIEW_WINDOW_MS);
      if (!day) continue;
      log(`storm day ${stormDate} for ${client.slug}: ${decisions.filter((d) => !d.skipReason).length} customers hit`);
      await notifyStormDay(deps, client, day).catch((e) => log(`storm summary for ${client.slug} failed: ${String(e)}`));
    }
    store.storm.recordRun({ stormDate, fileKey: found.key, status: "done", error: null, maxMm: maxMm || null, reportCount: reports.length, checkedAt: now() });
    // A new day is a good time to give addresses that failed on a network error another try.
    store.storm.retryGeocodeErrors();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.storm.recordRun({ stormDate, fileKey: key, status: "error", error: message, maxMm: null, reportCount: null, checkedAt: now() });
    log(`storm check for ${stormDate} failed: ${message}`);
  }
}

export function reviewUrl(appUrl: string, day: StormDay): string {
  return `${appUrl}/storm/${day.reviewToken}`;
}

function summaryRecipient(client: Client): string {
  const s = client.settings;
  return s.shadowEmail.trim() || s.stormNotifyEmail || s.replyTo;
}

export function hitLine(hit: StormHit): string {
  const report = hit.reportLocation && hit.reportSize
    ? `; ground report of ${hit.reportSize.toFixed(2)}″ ${hit.reportMiles} mi away (${hit.reportLocation})`
    : "";
  return `${hit.firstName} ${hit.lastName}, ${hit.street}: ${sizeBand(hit.meshMm)}${hit.email ? "" : ", no email on file"}${report}`;
}

export async function notifyStormDay(deps: Pick<StormDeps, "store" | "mailer" | "appUrl" | "now" | "log">, client: Client, day: StormDay): Promise<void> {
  const s = client.settings;
  const hits = deps.store.storm.hits(day.id);
  const included = hits.filter((h) => h.status === "pending");
  const skipped = hits.filter((h) => h.status === "skipped");
  const count = included.length;
  const subject = `Hail hit ${count} of your customers on ${stormDay(day.stormDate)}`;
  const lines = [
    `Weather radar shows hail at or above ${s.stormThresholdInches}″ near ${count === 1 ? "1 of your past customers" : `${count} of your past customers`} on ${stormDateLong(day.stormDate)}. The largest estimate was ${sizeBand(day.maxMm)}.`,
    ``,
    `Review the list and send them a note:`,
    reviewUrl(deps.appUrl, day),
    ``,
    `Nothing goes out until you press Send. The link expires ${when(day.expiresAt, s.timezone)}.`,
    ``,
    ...included.slice(0, 25).map(hitLine),
    included.length > 25 ? `…and ${included.length - 25} more on the review page.` : null,
    skipped.length ? `\n${skipped.length} more were hit but are left out (recent alert, unsubscribed, or same household).` : null,
    ``,
    `Sizes are radar estimates, not measurements.`,
  ].filter((line) => line !== null);
  await deps.mailer.send({
    from: fromHeader("Storm alert", s.businessName, s.fromAddress),
    to: summaryRecipient(client),
    bcc: s.bccEmail || undefined,
    subject,
    text: lines.join("\n"),
    idempotencyKey: `storm-day-${day.id}-summary`,
  });
  deps.store.storm.markNotified(day.id, deps.now());
}

// What homeowners get

export function stormValues(client: Client, hit: Pick<StormHit, "firstName" | "street">, stormDate: string) {
  const s = client.settings;
  return {
    first_name: hit.firstName,
    sender_name: s.senderName,
    business_name: s.businessName,
    phone: s.phone,
    street: hit.street,
    storm_day: stormDay(stormDate),
    storm_date: stormDateLong(stormDate),
  };
}

export function unsubscribeUrl(appUrl: string, hit: Pick<StormHit, "unsubToken">): string {
  return `${appUrl}/u/${hit.unsubToken}`;
}

/** The storm email, with the footer the law requires. The footer isn't part of the editable template. */
export function renderStormEmail(store: Store, client: Client, hit: Pick<StormHit, "firstName" | "street" | "unsubToken">, stormDate: string, appUrl: string): Template {
  const email = render(store.template(client.id, "storm_email"), stormValues(client, hit, stormDate));
  const footer = `--\n${client.settings.businessName} · ${client.settings.businessAddress}\nDon't want storm alerts? ${unsubscribeUrl(appUrl, hit)}`;
  return { subject: email.subject, body: `${email.body}\n\n${footer}` };
}

export function renderPostcard(store: Store, client: Client, hit: Pick<StormHit, "firstName" | "street">, stormDate: string): Template {
  return render(store.template(client.id, "storm_postcard"), stormValues(client, hit, stormDate));
}

export async function sendStormDue(deps: Pick<StormDeps, "store" | "mailer" | "appUrl" | "now" | "log">): Promise<void> {
  for (const hit of deps.store.storm.dueEmails(deps.now())) {
    await sendStormEmail(deps, hit);
  }
}

async function sendStormEmail(deps: Pick<StormDeps, "store" | "mailer" | "appUrl" | "now" | "log">, hit: StormHit): Promise<void> {
  const { store, mailer, now, log } = deps;
  const at = now();
  const fail = (reason: string) => {
    store.storm.markEmailFailed(hit.id, reason, at);
    log(`storm email ${hit.id} not sent: ${reason}`);
  };
  const client = store.client(hit.clientId);
  const day = store.storm.stormDay(hit.stormDayId);
  if (!client || !day) return fail("Client or storm day no longer exists");
  if (client.paused) return fail("Client paused");
  const problems = stormReadinessProblems(client.settings);
  if (problems.length) return fail(`Client not set up: ${problems.join(" ")}`);
  if (!hit.email) return fail("No email address");
  if (store.storm.isUnsubscribed(client.id, hit.email)) return fail("Unsubscribed");

  const s = client.settings;
  const email = renderStormEmail(store, client, hit, day.stormDate, deps.appUrl);
  const shadow = s.shadowEmail.trim();
  const to = shadow || hit.email;
  const subject = shadow ? `[Shadow for ${hit.email}] ${email.subject}` : email.subject;
  const unsubscribe = unsubscribeUrl(deps.appUrl, hit);
  try {
    const result = await mailer.send({
      from: fromHeader(s.senderName, s.businessName, s.fromAddress),
      to,
      replyTo: s.replyTo || undefined,
      bcc: s.bccEmail || undefined,
      subject,
      text: email.body,
      idempotencyKey: `storm-hit-${hit.id}`,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    store.storm.markEmailSent(hit, { providerId: result.id, to, subject, body: email.body, dryRun: mailer.dryRun }, at);
    log(`${mailer.dryRun ? "[dry run] " : ""}sent storm email ${hit.id} to ${to}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const firstAttempt = hit.firstAttemptAt ?? at;
    if (at - firstAttempt >= RETRY_WINDOW_MS) return fail(message);
    const backoffMinutes = Math.min(5 * 2 ** hit.attempts, 20);
    store.storm.markEmailRetry(hit.id, message, at + backoffMinutes * 60_000, at);
    log(`will retry storm email ${hit.id} in ${backoffMinutes} minutes: ${message}`);
  }
}

// Postcards (Smartpress)

/**
 * A Smartpress mailing list: one row per postcard, each field in its own column. Message is the whole
 * personalized back of the card, rendered from the standard postcard template, so the art file needs
 * one variable text box. FirstName, Street and StormDate are there too for art that keeps its own copy.
 */
export function postcardCsv(store: Store, client: Client, batch: PostcardBatch): string {
  const day = store.storm.stormDay(batch.stormDayId);
  const stormDate = day?.stormDate ?? "";
  const rows: (string | number | null)[][] = [["FirstName", "LastName", "Address1", "City", "State", "Zip", "Headline", "Message", "Street", "StormDate"]];
  for (const hit of store.storm.batchHits(batch.id)) {
    const card = renderPostcard(store, client, hit, stormDate);
    rows.push([hit.firstName, hit.lastName, hit.street, hit.city, hit.state, hit.zip, card.subject, card.body, hit.street, stormDateLong(stormDate)]);
  }
  return toCsv(rows);
}

export async function notifyPostcardBatch(deps: Pick<StormDeps, "store" | "mailer" | "appUrl">, client: Client, batch: PostcardBatch): Promise<void> {
  const s = client.settings;
  if (!s.postcardOrderEmail) return;
  const day = deps.store.storm.stormDay(batch.stormDayId);
  await deps.mailer.send({
    from: fromHeader("Storm alert", s.businessName, s.fromAddress),
    to: s.postcardOrderEmail,
    subject: `Postcards to order: ${batch.pieceCount} for ${client.name}`,
    text: [
      `${client.name} approved ${batch.pieceCount} storm postcards for ${day ? stormDateLong(day.stormDate) : "a storm"}.`,
      ``,
      `Download the Smartpress mailing list and mark the batch ordered here:`,
      `${deps.appUrl}/postcard-batches/${batch.id}`,
      ``,
      `Estimated cost at $${s.postcardCost.toFixed(2)} a card: $${(batch.pieceCount * s.postcardCost).toFixed(2)}.`,
    ].join("\n"),
    idempotencyKey: `postcard-batch-${batch.id}`,
  });
}

// Replay reports

/** Works through a queued report a few days at a time, saving progress so a restart picks up where it left off. */
export async function runReports(deps: Pick<StormDeps, "store" | "hail" | "now" | "log">, daysPerTick = 15): Promise<void> {
  const report = deps.store.storm.nextReport();
  if (!report) return;
  const candidates = deps.store.storm.candidates(report.clientId);
  const thresholdMm = report.thresholdInches * MM_PER_INCH;
  const remaining = stormDatesBetween(report.nextDate, report.toDate);
  const batch = remaining.slice(0, daysPerTick);
  const result: StormReportDay[] = [...report.result];
  let { daysChecked, daysMissing } = report;
  try {
    for (const date of batch) {
      const found = await deps.hail.grid(date);
      daysChecked++;
      if (!found) {
        daysMissing++;
        continue;
      }
      const hits = candidates
        .map((c) => ({ c, mm: found.grid.maxNear(c.lat, c.lon) }))
        .filter((h) => h.mm >= thresholdMm)
        .sort((a, b) => b.mm - a.mm);
      if (hits.length) {
        result.push({
          stormDate: date,
          maxMm: hits[0]!.mm,
          hits: hits.map((h) => ({ name: `${h.c.firstName} ${h.c.lastName}`.trim(), street: h.c.street, mm: Math.round(h.mm * 10) / 10 })),
        });
      }
    }
    const done = batch.length === remaining.length;
    const next = done ? report.toDate : remaining[batch.length]!;
    deps.store.storm.saveReportProgress(
      report.id,
      { nextDate: next, daysChecked, daysMissing, customersChecked: candidates.length, result, done },
      deps.now(),
    );
    if (done) deps.log(`storm report ${report.id} done: ${result.length} days with hits`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.store.storm.failReport(report.id, message, deps.now());
    deps.log(`storm report ${report.id} failed: ${message}`);
  }
}

export function reportSummary(report: { result: StormReportDay[] }): { days: number; customers: number; contacts: number } {
  const people = new Set<string>();
  let contacts = 0;
  for (const day of report.result) {
    for (const hit of day.hits) {
      people.add(`${hit.name}|${hit.street}`);
      contacts++;
    }
  }
  return { days: report.result.length, customers: people.size, contacts };
}

export function startStormScheduler(deps: StormDeps, intervalSeconds: number, reportSeconds = 20): () => void {
  let running = false;
  let reporting = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await geocodePending(deps);
      await checkStorms(deps);
      const expired = deps.store.storm.expireDays(deps.now());
      if (expired) deps.log(`${expired} storm day(s) expired without review`);
      await sendStormDue(deps);
    } catch (error) {
      deps.log(`storm job crashed: ${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      running = false;
    }
  };
  const report = async () => {
    if (reporting) return;
    reporting = true;
    try {
      await runReports(deps);
    } catch (error) {
      deps.log(`storm report job crashed: ${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      reporting = false;
    }
  };
  void tick();
  const timers = [setInterval(tick, intervalSeconds * 1000), setInterval(report, reportSeconds * 1000)];
  return () => timers.forEach(clearInterval);
}
