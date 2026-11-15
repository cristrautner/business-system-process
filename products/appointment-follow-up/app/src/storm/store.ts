// Database reads and writes for storm alerts.

import { randomToken } from "../crypto.ts";
import type { Db } from "../db.ts";
import type { Candidate, HitDecision, GroundReport } from "./rules.ts";

type Row = Record<string, unknown>;

export type StormDayStatus = "pending_review" | "approved" | "dismissed" | "expired";
export type HitStatus = "pending" | "skipped" | "removed" | "approved";
export type EmailStatus = "queued" | "sent" | "failed";

export interface StormRun {
  stormDate: string;
  fileKey: string;
  status: "done" | "error";
  error: string | null;
  maxMm: number | null;
  reportCount: number | null;
  checkedAt: number;
}

export interface StormDay {
  id: number;
  clientId: number;
  stormDate: string;
  fileKey: string;
  maxMm: number;
  status: StormDayStatus;
  reviewToken: string;
  postcards: boolean;
  createdAt: number;
  expiresAt: number;
  reviewedAt: number | null;
  notifiedAt: number | null;
}

export interface StormHit {
  id: number;
  stormDayId: number;
  clientId: number;
  contactId: number | null;
  firstName: string;
  lastName: string;
  email: string | null;
  street: string;
  city: string;
  state: string;
  zip: string;
  meshMm: number;
  reportMiles: number | null;
  reportSize: number | null;
  reportLocation: string | null;
  status: HitStatus;
  reason: string | null;
  emailStatus: EmailStatus | null;
  sendAt: number | null;
  attempts: number;
  firstAttemptAt: number | null;
  emailReason: string | null;
  postcardBatchId: number | null;
  unsubToken: string;
}

export interface PostcardBatch {
  id: number;
  clientId: number;
  stormDayId: number;
  status: "needs_order" | "ordered" | "cancelled";
  pieceCount: number;
  orderRef: string | null;
  createdAt: number;
  orderedAt: number | null;
}

export interface StormReportDay {
  stormDate: string;
  maxMm: number;
  hits: { name: string; street: string; mm: number }[];
}

export interface StormReport {
  id: number;
  clientId: number;
  fromDate: string;
  toDate: string;
  thresholdInches: number;
  status: "queued" | "running" | "done" | "error";
  nextDate: string;
  daysChecked: number;
  daysMissing: number;
  customersChecked: number;
  result: StormReportDay[];
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface GeocodeTask {
  id: number;
  clientId: number;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface CustomerCounts {
  customers: number;
  located: number;
  notFound: number;
  waiting: number;
  withEmail: number;
}

const num = (value: unknown) => (value === null || value === undefined ? null : (value as number));
const str = (value: unknown) => (value === null || value === undefined ? null : (value as string));

function toDay(row: Row): StormDay {
  return {
    id: row.id as number,
    clientId: row.client_id as number,
    stormDate: row.storm_date as string,
    fileKey: row.file_key as string,
    maxMm: row.max_mm as number,
    status: row.status as StormDayStatus,
    reviewToken: row.review_token as string,
    postcards: row.postcards === 1,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    reviewedAt: num(row.reviewed_at),
    notifiedAt: num(row.notified_at),
  };
}

function toHit(row: Row): StormHit {
  return {
    id: row.id as number,
    stormDayId: row.storm_day_id as number,
    clientId: row.client_id as number,
    contactId: num(row.contact_id),
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: str(row.email),
    street: row.street as string,
    city: row.city as string,
    state: row.state as string,
    zip: row.zip as string,
    meshMm: row.mesh_mm as number,
    reportMiles: num(row.report_miles),
    reportSize: num(row.report_size),
    reportLocation: str(row.report_location),
    status: row.status as HitStatus,
    reason: str(row.reason),
    emailStatus: str(row.email_status) as EmailStatus | null,
    sendAt: num(row.send_at),
    attempts: row.attempts as number,
    firstAttemptAt: num(row.first_attempt_at),
    emailReason: str(row.email_reason),
    postcardBatchId: num(row.postcard_batch_id),
    unsubToken: row.unsub_token as string,
  };
}

function toBatch(row: Row): PostcardBatch {
  return {
    id: row.id as number,
    clientId: row.client_id as number,
    stormDayId: row.storm_day_id as number,
    status: row.status as PostcardBatch["status"],
    pieceCount: row.piece_count as number,
    orderRef: str(row.order_ref),
    createdAt: row.created_at as number,
    orderedAt: num(row.ordered_at),
  };
}

function toReport(row: Row): StormReport {
  return {
    id: row.id as number,
    clientId: row.client_id as number,
    fromDate: row.from_date as string,
    toDate: row.to_date as string,
    thresholdInches: row.threshold_inches as number,
    status: row.status as StormReport["status"],
    nextDate: row.next_date as string,
    daysChecked: row.days_checked as number,
    daysMissing: row.days_missing as number,
    customersChecked: row.customers_checked as number,
    result: JSON.parse(row.result as string) as StormReportDay[],
    error: str(row.error),
    createdAt: row.created_at as number,
    finishedAt: num(row.finished_at),
  };
}

export class StormStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Customers and geocoding

  /** Contacts with an address that haven't been located yet. */
  geocodeQueue(limit: number): GeocodeTask[] {
    return (
      this.db
        .prepare(
          `SELECT id, client_id, street, city, state, zip FROM contacts
           WHERE geocode_status IS NULL AND street IS NOT NULL AND street != '' AND zip IS NOT NULL AND zip != ''
           ORDER BY is_customer DESC, id LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((row) => ({
      id: row.id as number,
      clientId: row.client_id as number,
      street: row.street as string,
      city: (row.city as string | null) ?? "",
      state: (row.state as string | null) ?? "",
      zip: row.zip as string,
    }));
  }

  saveGeocode(contactId: number, result: { status: "matched" | "not_found" | "error"; lat?: number; lon?: number; note?: string }, now: number): void {
    this.db
      .prepare("UPDATE contacts SET geocode_status = ?, lat = ?, lon = ?, geocode_note = ?, geocoded_at = ? WHERE id = ?")
      .run(result.status, result.lat ?? null, result.lon ?? null, result.note ?? null, now, contactId);
  }

  /** Lets a failed lookup be tried again, for example after the address is fixed. */
  retryGeocode(contactId: number): void {
    this.db.prepare("UPDATE contacts SET geocode_status = NULL, geocode_note = NULL WHERE id = ?").run(contactId);
  }

  retryGeocodeErrors(): void {
    this.db.prepare("UPDATE contacts SET geocode_status = NULL WHERE geocode_status = 'error'").run();
  }

  setCustomer(contactId: number, isCustomer: boolean): void {
    this.db.prepare("UPDATE contacts SET is_customer = ? WHERE id = ?").run(isCustomer ? 1 : 0, contactId);
  }

  customerCounts(clientId: number): CustomerCounts {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS customers,
           SUM(geocode_status = 'matched') AS located,
           SUM(geocode_status IN ('not_found', 'error')) AS not_found,
           SUM(geocode_status IS NULL) AS waiting,
           SUM(email IS NOT NULL AND email != '') AS with_email
         FROM contacts WHERE client_id = ? AND is_customer = 1`,
      )
      .get(clientId) as Row;
    return {
      customers: (row.customers as number) ?? 0,
      located: (row.located as number | null) ?? 0,
      notFound: (row.not_found as number | null) ?? 0,
      waiting: (row.waiting as number | null) ?? 0,
      withEmail: (row.with_email as number | null) ?? 0,
    };
  }

  unlocated(clientId: number, limit = 100): { id: number; name: string; address: string; note: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT id, first_name, last_name, street, city, state, zip, geocode_note FROM contacts
           WHERE client_id = ? AND is_customer = 1 AND geocode_status IN ('not_found', 'error') ORDER BY last_name LIMIT ?`,
        )
        .all(clientId, limit) as Row[]
    ).map((row) => ({
      id: row.id as number,
      name: `${row.first_name} ${row.last_name}`.trim(),
      address: [row.street, row.city, row.state, row.zip].filter(Boolean).join(", "),
      note: str(row.geocode_note),
    }));
  }

  /** Located customers of a client, with what the rules need to decide who gets an alert. */
  candidates(clientId: number): Candidate[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.first_name, c.last_name, c.email, c.street, c.city, c.state, c.zip, c.lat, c.lon,
             (c.storm_opt_out = 1 OR (c.email IS NOT NULL AND EXISTS (
               SELECT 1 FROM unsubscribes u WHERE u.client_id = c.client_id AND u.email = c.email))) AS opted_out,
             (SELECT MAX(h.created_at) FROM storm_hits h
               WHERE h.contact_id = c.id AND h.status = 'approved'
                 AND (h.email_status IN ('queued', 'sent') OR h.postcard_batch_id IS NOT NULL)) AS last_alert
           FROM contacts c
           WHERE c.client_id = ? AND c.is_customer = 1 AND c.geocode_status = 'matched' AND c.lat IS NOT NULL
           ORDER BY c.id`,
        )
        .all(clientId) as Row[]
    ).map((row) => ({
      contactId: row.id as number,
      firstName: row.first_name as string,
      lastName: row.last_name as string,
      email: str(row.email),
      street: (row.street as string | null) ?? "",
      city: (row.city as string | null) ?? "",
      state: (row.state as string | null) ?? "",
      zip: (row.zip as string | null) ?? "",
      lat: row.lat as number,
      lon: row.lon as number,
      optedOut: row.opted_out === 1,
      lastAlertAt: num(row.last_alert),
    }));
  }

  // Runs

  run(stormDate: string): StormRun | undefined {
    const row = this.db.prepare("SELECT * FROM storm_runs WHERE storm_date = ?").get(stormDate) as Row | undefined;
    if (!row) return undefined;
    return {
      stormDate: row.storm_date as string,
      fileKey: row.file_key as string,
      status: row.status as StormRun["status"],
      error: str(row.error),
      maxMm: num(row.max_mm),
      reportCount: num(row.report_count),
      checkedAt: row.checked_at as number,
    };
  }

  latestRun(): StormRun | undefined {
    const row = this.db.prepare("SELECT storm_date FROM storm_runs ORDER BY storm_date DESC LIMIT 1").get() as Row | undefined;
    return row ? this.run(row.storm_date as string) : undefined;
  }

  recordRun(run: StormRun): void {
    this.db
      .prepare(
        `INSERT INTO storm_runs (storm_date, file_key, status, error, max_mm, report_count, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (storm_date) DO UPDATE SET file_key = excluded.file_key, status = excluded.status, error = excluded.error,
           max_mm = excluded.max_mm, report_count = excluded.report_count, checked_at = excluded.checked_at`,
      )
      .run(run.stormDate, run.fileKey, run.status, run.error, run.maxMm, run.reportCount, run.checkedAt);
  }

  // Storm days and hits

  /** Records a storm day and its hits. Returns undefined if this client already has one for that date. */
  createStormDay(
    clientId: number,
    stormDate: string,
    fileKey: string,
    decisions: (HitDecision & { report: { report: GroundReport; miles: number } | null })[],
    now: number,
    expiresAt: number,
  ): StormDay | undefined {
    if (this.stormDayFor(clientId, stormDate)) return undefined;
    return this.transaction(() => {
      const maxMm = Math.max(0, ...decisions.map((d) => d.mm));
      const result = this.db
        .prepare(
          `INSERT INTO storm_days (client_id, storm_date, file_key, max_mm, status, review_token, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending_review', ?, ?, ?)`,
        )
        .run(clientId, stormDate, fileKey, maxMm, randomToken(), now, expiresAt);
      const dayId = Number(result.lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT INTO storm_hits (storm_day_id, client_id, contact_id, first_name, last_name, email, street, city, state, zip,
           mesh_mm, report_miles, report_size, report_location, status, reason, unsub_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of decisions) {
        const c = d.candidate;
        const location = d.report ? `${d.report.report.location}, ${d.report.report.state}` : null;
        insert.run(
          dayId, clientId, c.contactId, c.firstName, c.lastName, c.email, c.street, c.city, c.state, c.zip,
          d.mm, d.report ? Math.round(d.report.miles * 10) / 10 : null, d.report?.report.size ?? null, location,
          d.skipReason ? "skipped" : "pending", d.skipReason, randomToken(), now, now,
        );
      }
      return this.stormDay(dayId)!;
    });
  }

  stormDay(id: number): StormDay | undefined {
    const row = this.db.prepare("SELECT * FROM storm_days WHERE id = ?").get(id) as Row | undefined;
    return row ? toDay(row) : undefined;
  }

  stormDayFor(clientId: number, stormDate: string): StormDay | undefined {
    const row = this.db.prepare("SELECT * FROM storm_days WHERE client_id = ? AND storm_date = ?").get(clientId, stormDate) as Row | undefined;
    return row ? toDay(row) : undefined;
  }

  stormDayByToken(token: string): StormDay | undefined {
    const row = this.db.prepare("SELECT * FROM storm_days WHERE review_token = ?").get(token) as Row | undefined;
    return row ? toDay(row) : undefined;
  }

  stormDays(clientId: number, limit = 20): StormDay[] {
    return (this.db.prepare("SELECT * FROM storm_days WHERE client_id = ? ORDER BY storm_date DESC LIMIT ?").all(clientId, limit) as Row[]).map(toDay);
  }

  markNotified(dayId: number, now: number): void {
    this.db.prepare("UPDATE storm_days SET notified_at = ? WHERE id = ?").run(now, dayId);
  }

  unnotifiedDays(): StormDay[] {
    return (this.db.prepare("SELECT * FROM storm_days WHERE notified_at IS NULL AND status = 'pending_review'").all() as Row[]).map(toDay);
  }

  hits(dayId: number): StormHit[] {
    return (this.db.prepare("SELECT * FROM storm_hits WHERE storm_day_id = ? ORDER BY mesh_mm DESC, id").all(dayId) as Row[]).map(toHit);
  }

  hit(id: number): StormHit | undefined {
    const row = this.db.prepare("SELECT * FROM storm_hits WHERE id = ?").get(id) as Row | undefined;
    return row ? toHit(row) : undefined;
  }

  hitByUnsubToken(token: string): StormHit | undefined {
    const row = this.db.prepare("SELECT * FROM storm_hits WHERE unsub_token = ?").get(token) as Row | undefined;
    return row ? toHit(row) : undefined;
  }

  /**
   * The contractor's decision. Ticked pending hits are approved (and queued for email when they have
   * one); unticked ones are removed. Optionally creates a postcard batch for the approved hits.
   */
  approve(dayId: number, approvedIds: Set<number>, sendAt: number, postcards: boolean, now: number): { approved: number; emails: number; batch: PostcardBatch | null } {
    return this.transaction(() => {
      const day = this.stormDay(dayId);
      if (!day || day.status !== "pending_review") return { approved: 0, emails: 0, batch: null };
      let approved = 0;
      let emails = 0;
      const approvedHits: StormHit[] = [];
      for (const hit of this.hits(dayId)) {
        if (hit.status !== "pending") continue;
        if (approvedIds.has(hit.id) && !hit.email && !postcards) {
          this.db
            .prepare("UPDATE storm_hits SET status = 'skipped', reason = 'No email on file, and no postcard was ordered', updated_at = ? WHERE id = ?")
            .run(now, hit.id);
        } else if (approvedIds.has(hit.id)) {
          const queue = Boolean(hit.email);
          this.db
            .prepare("UPDATE storm_hits SET status = 'approved', email_status = ?, send_at = ?, updated_at = ? WHERE id = ?")
            .run(queue ? "queued" : null, queue ? sendAt : null, now, hit.id);
          approved++;
          if (queue) emails++;
          approvedHits.push(hit);
        } else {
          this.db.prepare("UPDATE storm_hits SET status = 'removed', reason = 'Removed in review', updated_at = ? WHERE id = ?").run(now, hit.id);
        }
      }
      let batch: PostcardBatch | null = null;
      if (postcards && approvedHits.length > 0) {
        const result = this.db
          .prepare("INSERT INTO postcard_batches (client_id, storm_day_id, status, piece_count, created_at) VALUES (?, ?, 'needs_order', ?, ?)")
          .run(day.clientId, dayId, approvedHits.length, now);
        const batchId = Number(result.lastInsertRowid);
        const link = this.db.prepare("UPDATE storm_hits SET postcard_batch_id = ? WHERE id = ?");
        for (const hit of approvedHits) link.run(batchId, hit.id);
        batch = this.batch(batchId)!;
      }
      this.db
        .prepare("UPDATE storm_days SET status = 'approved', postcards = ?, reviewed_at = ? WHERE id = ?")
        .run(batch ? 1 : 0, now, dayId);
      return { approved, emails, batch };
    });
  }

  dismiss(dayId: number, now: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE storm_days SET status = 'dismissed', reviewed_at = ? WHERE id = ? AND status = 'pending_review'").run(now, dayId);
      this.db
        .prepare("UPDATE storm_hits SET status = 'removed', reason = 'Storm day dismissed', updated_at = ? WHERE storm_day_id = ? AND status = 'pending'")
        .run(now, dayId);
    });
  }

  expireDays(now: number): number {
    return this.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM storm_days WHERE status = 'pending_review' AND expires_at <= ?").all(now) as Row[]).map(
        (row) => row.id as number,
      );
      for (const id of ids) {
        this.db.prepare("UPDATE storm_days SET status = 'expired' WHERE id = ?").run(id);
        this.db
          .prepare("UPDATE storm_hits SET status = 'removed', reason = 'Not reviewed in time', updated_at = ? WHERE storm_day_id = ? AND status = 'pending'")
          .run(now, id);
      }
      return ids.length;
    });
  }

  dueEmails(now: number): StormHit[] {
    return (
      this.db.prepare("SELECT * FROM storm_hits WHERE email_status = 'queued' AND send_at <= ? ORDER BY send_at, id").all(now) as Row[]
    ).map(toHit);
  }

  markEmailSent(hit: StormHit, send: { providerId: string; to: string; subject: string; body: string; dryRun: boolean }, now: number): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE storm_hits SET email_status = 'sent', email_reason = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(send.dryRun ? "Dry run: not actually sent" : null, now, hit.id);
      this.db
        .prepare("INSERT INTO sends (storm_hit_id, provider_id, to_address, subject, body, dry_run, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(hit.id, send.providerId, send.to, send.subject, send.body, send.dryRun ? 1 : 0, now);
    });
  }

  markEmailRetry(id: number, error: string, nextAt: number, now: number): void {
    this.db
      .prepare(
        `UPDATE storm_hits SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), send_at = ?,
           email_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, nextAt, `Retrying: ${error}`, now, id);
  }

  markEmailFailed(id: number, reason: string, now: number): void {
    this.db.prepare("UPDATE storm_hits SET email_status = 'failed', email_reason = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(reason, now, id);
  }

  sendForHit(hitId: number): { to: string; subject: string; body: string; dryRun: boolean; sentAt: number } | undefined {
    const row = this.db
      .prepare("SELECT to_address, subject, body, dry_run, sent_at FROM sends WHERE storm_hit_id = ? ORDER BY id DESC LIMIT 1")
      .get(hitId) as Row | undefined;
    return row
      ? { to: row.to_address as string, subject: row.subject as string, body: row.body as string, dryRun: row.dry_run === 1, sentAt: row.sent_at as number }
      : undefined;
  }

  // Unsubscribes

  unsubscribe(clientId: number, email: string, source: string, now: number): void {
    const address = email.toLowerCase();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO unsubscribes (client_id, email, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(clientId, address, source, now);
      this.db.prepare("UPDATE contacts SET storm_opt_out = 1 WHERE client_id = ? AND email = ?").run(clientId, address);
      // Anything still waiting to go to this address stops too.
      this.db
        .prepare(
          `UPDATE storm_hits SET email_status = 'failed', email_reason = 'Unsubscribed', updated_at = ?
           WHERE client_id = ? AND email = ? AND email_status = 'queued'`,
        )
        .run(now, clientId, address);
    });
  }

  isUnsubscribed(clientId: number, email: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM unsubscribes WHERE client_id = ? AND email = ?").get(clientId, email.toLowerCase()));
  }

  // Postcards

  batch(id: number): PostcardBatch | undefined {
    const row = this.db.prepare("SELECT * FROM postcard_batches WHERE id = ?").get(id) as Row | undefined;
    return row ? toBatch(row) : undefined;
  }

  batches(clientId: number, limit = 20): PostcardBatch[] {
    return (this.db.prepare("SELECT * FROM postcard_batches WHERE client_id = ? ORDER BY id DESC LIMIT ?").all(clientId, limit) as Row[]).map(toBatch);
  }

  batchHits(batchId: number): StormHit[] {
    return (this.db.prepare("SELECT * FROM storm_hits WHERE postcard_batch_id = ? ORDER BY last_name, first_name").all(batchId) as Row[]).map(toHit);
  }

  markBatchOrdered(batchId: number, orderRef: string, now: number): void {
    this.db.prepare("UPDATE postcard_batches SET status = 'ordered', order_ref = ?, ordered_at = ? WHERE id = ?").run(orderRef || null, now, batchId);
  }

  cancelBatch(batchId: number): void {
    this.db.prepare("UPDATE postcard_batches SET status = 'cancelled' WHERE id = ? AND status = 'needs_order'").run(batchId);
  }

  // Replay reports

  createReport(clientId: number, fromDate: string, toDate: string, thresholdInches: number, now: number): StormReport {
    const result = this.db
      .prepare(
        `INSERT INTO storm_reports (client_id, from_date, to_date, threshold_inches, status, next_date, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(clientId, fromDate, toDate, thresholdInches, fromDate, now);
    return this.report(Number(result.lastInsertRowid))!;
  }

  report(id: number): StormReport | undefined {
    const row = this.db.prepare("SELECT * FROM storm_reports WHERE id = ?").get(id) as Row | undefined;
    return row ? toReport(row) : undefined;
  }

  reports(clientId: number, limit = 10): StormReport[] {
    return (this.db.prepare("SELECT * FROM storm_reports WHERE client_id = ? ORDER BY id DESC LIMIT ?").all(clientId, limit) as Row[]).map(toReport);
  }

  nextReport(): StormReport | undefined {
    const row = this.db.prepare("SELECT * FROM storm_reports WHERE status IN ('queued', 'running') ORDER BY id LIMIT 1").get() as Row | undefined;
    return row ? toReport(row) : undefined;
  }

  saveReportProgress(
    id: number,
    progress: { nextDate: string; daysChecked: number; daysMissing: number; customersChecked: number; result: StormReportDay[]; done: boolean },
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE storm_reports SET status = ?, next_date = ?, days_checked = ?, days_missing = ?, customers_checked = ?, result = ?,
           finished_at = ? WHERE id = ?`,
      )
      .run(
        progress.done ? "done" : "running", progress.nextDate, progress.daysChecked, progress.daysMissing, progress.customersChecked,
        JSON.stringify(progress.result), progress.done ? now : null, id,
      );
  }

  failReport(id: number, error: string, now: number): void {
    this.db.prepare("UPDATE storm_reports SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(error, now, id);
  }
}
