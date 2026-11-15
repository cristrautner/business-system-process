// Database reads and writes. Everything that touches SQL lives here.

import type { Db } from "./db.ts";
import { randomToken } from "./crypto.ts";
import type { ContactLookup, ContactMatch } from "./rules.ts";
import { defaultSettings, parseSettings, type ClientSettings, type TemplateType } from "./settings.ts";
import { DEFAULT_TEMPLATES, type Template } from "./templates.ts";

export interface Client {
  id: number;
  name: string;
  slug: string;
  settings: ClientSettings;
  leadApiKey: string;
  connectToken: string;
  paused: boolean;
  createdAt: number;
}

export interface Connection {
  clientId: number;
  googleEmail: string | null;
  calendarId: string;
  refreshTokenEnc: string;
  lastPollAt: number | null;
  lastError: string | null;
  connectedAt: number;
}

export type AppointmentStatus = "scheduled" | "sent" | "skipped" | "failed";

export interface Appointment {
  id: number;
  clientId: number;
  contactId: number | null;
  eventId: string;
  title: string;
  type: string;
  recipient: string | null;
  firstName: string | null;
  startAt: number;
  endAt: number;
  sendAt: number;
  status: AppointmentStatus;
  reason: string | null;
  attempts: number;
  firstAttemptAt: number | null;
  updatedAt: number;
}

export interface Contact {
  id: number;
  clientId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  service: string | null;
  insuranceClaim: string | null;
  notes: string | null;
  source: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

function toClient(row: Row): Client {
  return {
    id: row.id as number,
    name: row.name as string,
    slug: row.slug as string,
    settings: parseSettings(row.settings as string, row.name as string),
    leadApiKey: row.lead_api_key as string,
    connectToken: row.connect_token as string,
    paused: row.paused === 1,
    createdAt: row.created_at as number,
  };
}

function toAppointment(row: Row): Appointment {
  return {
    id: row.id as number,
    clientId: row.client_id as number,
    contactId: (row.contact_id as number | null) ?? null,
    eventId: row.event_id as string,
    title: row.title as string,
    type: row.type as string,
    recipient: (row.recipient as string | null) ?? null,
    firstName: (row.first_name as string | null) ?? null,
    startAt: row.start_at as number,
    endAt: row.end_at as number,
    sendAt: row.send_at as number,
    status: row.status as AppointmentStatus,
    reason: (row.reason as string | null) ?? null,
    attempts: row.attempts as number,
    firstAttemptAt: (row.first_attempt_at as number | null) ?? null,
    updatedAt: row.updated_at as number,
  };
}

function toContact(row: Row): Contact {
  return {
    id: row.id as number,
    clientId: row.client_id as number,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    street: (row.street as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    state: (row.state as string | null) ?? null,
    zip: (row.zip as string | null) ?? null,
    service: (row.service as string | null) ?? null,
    insuranceClaim: (row.insurance_claim as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    source: row.source as string,
    createdAt: row.created_at as number,
  };
}

export class Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Clients

  createClient(name: string, slug: string, now: number): Client {
    const result = this.db
      .prepare(
        `INSERT INTO clients (name, slug, settings, lead_api_key, connect_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, slug, JSON.stringify(defaultSettings(name)), randomToken(), randomToken(), now);
    return this.client(Number(result.lastInsertRowid))!;
  }

  client(id: number): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Row | undefined;
    return row ? toClient(row) : undefined;
  }

  clientByConnectToken(token: string): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE connect_token = ?").get(token) as Row | undefined;
    return row ? toClient(row) : undefined;
  }

  clientByLeadKey(key: string): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE lead_api_key = ?").get(key) as Row | undefined;
    return row ? toClient(row) : undefined;
  }

  clients(): Client[] {
    return (this.db.prepare("SELECT * FROM clients ORDER BY name").all() as Row[]).map(toClient);
  }

  saveSettings(clientId: number, settings: ClientSettings): void {
    this.db.prepare("UPDATE clients SET name = ?, settings = ? WHERE id = ?").run(settings.businessName, JSON.stringify(settings), clientId);
  }

  setPaused(clientId: number, paused: boolean): void {
    this.db.prepare("UPDATE clients SET paused = ? WHERE id = ?").run(paused ? 1 : 0, clientId);
  }

  rotateLeadKey(clientId: number): void {
    this.db.prepare("UPDATE clients SET lead_api_key = ? WHERE id = ?").run(randomToken(), clientId);
  }

  rotateConnectToken(clientId: number): void {
    this.db.prepare("UPDATE clients SET connect_token = ? WHERE id = ?").run(randomToken(), clientId);
  }

  // Google connections

  saveConnection(clientId: number, refreshTokenEnc: string, googleEmail: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO google_connections (client_id, google_email, refresh_token_enc, connected_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET
           google_email = excluded.google_email,
           refresh_token_enc = excluded.refresh_token_enc,
           connected_at = excluded.connected_at,
           last_error = NULL`,
      )
      .run(clientId, googleEmail, refreshTokenEnc, now);
  }

  connection(clientId: number): Connection | undefined {
    const row = this.db.prepare("SELECT * FROM google_connections WHERE client_id = ?").get(clientId) as Row | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id as number,
      googleEmail: (row.google_email as string | null) ?? null,
      calendarId: row.calendar_id as string,
      refreshTokenEnc: row.refresh_token_enc as string,
      lastPollAt: (row.last_poll_at as number | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      connectedAt: row.connected_at as number,
    };
  }

  deleteConnection(clientId: number): void {
    this.db.prepare("DELETE FROM google_connections WHERE client_id = ?").run(clientId);
  }

  recordPoll(clientId: number, now: number, error: string | null): void {
    if (error) {
      this.db.prepare("UPDATE google_connections SET last_error = ? WHERE client_id = ?").run(error, clientId);
    } else {
      this.db.prepare("UPDATE google_connections SET last_poll_at = ?, last_error = NULL WHERE client_id = ?").run(now, clientId);
    }
  }

  // Templates

  template(clientId: number, type: TemplateType): Template & { custom: boolean } {
    const row = this.db.prepare("SELECT subject, body FROM templates WHERE client_id = ? AND type = ?").get(clientId, type) as
      | { subject: string; body: string }
      | undefined;
    return row ? { ...row, custom: true } : { ...DEFAULT_TEMPLATES[type], custom: false };
  }

  saveTemplate(clientId: number, type: TemplateType, template: Template, now: number): void {
    this.db
      .prepare(
        `INSERT INTO templates (client_id, type, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id, type) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(clientId, type, template.subject, template.body, now);
  }

  resetTemplate(clientId: number, type: TemplateType): void {
    this.db.prepare("DELETE FROM templates WHERE client_id = ? AND type = ?").run(clientId, type);
  }

  // Contacts

  contactLookup(clientId: number): ContactLookup {
    const match = (row: Row | undefined): ContactMatch | undefined =>
      row ? { id: row.id as number, firstName: row.first_name as string, email: (row.email as string | null) ?? null } : undefined;
    const byEmail = this.db.prepare(
      "SELECT id, first_name, email FROM contacts WHERE client_id = ? AND email = ? ORDER BY updated_at DESC LIMIT 1",
    );
    const byPhone = this.db.prepare(
      "SELECT id, first_name, email FROM contacts WHERE client_id = ? AND phone_digits = ? ORDER BY updated_at DESC LIMIT 1",
    );
    return {
      byEmail: (email) => match(byEmail.get(clientId, email.toLowerCase()) as Row | undefined),
      byPhone: (digits) => match(byPhone.get(clientId, digits) as Row | undefined),
    };
  }

  /** Adds a contact, or updates the existing one with the same email. Returns its id. */
  upsertContact(clientId: number, c: Omit<Contact, "id" | "clientId" | "createdAt">, phoneDigits: string, now: number): number {
    const email = c.email?.toLowerCase() ?? null;
    const existing = email
      ? (this.db.prepare("SELECT id FROM contacts WHERE client_id = ? AND email = ?").get(clientId, email) as { id: number } | undefined)
      : undefined;
    const values = [c.firstName, c.lastName, email, c.phone, phoneDigits || null, c.street, c.city, c.state, c.zip, c.service, c.insuranceClaim, c.notes];
    if (existing) {
      this.db
        .prepare(
          `UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, phone_digits = ?, street = ?, city = ?,
             state = ?, zip = ?, service = ?, insurance_claim = ?, notes = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...values, now, existing.id);
      return existing.id;
    }
    const result = this.db
      .prepare(
        `INSERT INTO contacts (first_name, last_name, email, phone, phone_digits, street, city, state, zip, service,
           insurance_claim, notes, client_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values, clientId, c.source, now, now);
    return Number(result.lastInsertRowid);
  }

  contacts(clientId: number, limit = 200): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts WHERE client_id = ? ORDER BY created_at DESC LIMIT ?").all(clientId, limit) as Row[]).map(
      toContact,
    );
  }

  // Appointments

  appointment(id: number): Appointment | undefined {
    const row = this.db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) as Row | undefined;
    return row ? toAppointment(row) : undefined;
  }

  appointmentByEvent(clientId: number, eventId: string): Appointment | undefined {
    const row = this.db.prepare("SELECT * FROM appointments WHERE client_id = ? AND event_id = ?").get(clientId, eventId) as Row | undefined;
    return row ? toAppointment(row) : undefined;
  }

  /** Inserts a new appointment, or refreshes one that's still scheduled. Sent and skipped ones are left alone. */
  upsertScheduled(
    a: Pick<Appointment, "clientId" | "contactId" | "eventId" | "title" | "type" | "recipient" | "firstName" | "startAt" | "endAt" | "sendAt" | "reason">,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO appointments (client_id, contact_id, event_id, title, type, recipient, first_name, start_at, end_at, send_at,
           status, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
         ON CONFLICT (client_id, event_id) DO UPDATE SET
           contact_id = excluded.contact_id, title = excluded.title, type = excluded.type, recipient = excluded.recipient,
           first_name = excluded.first_name, start_at = excluded.start_at, end_at = excluded.end_at,
           send_at = excluded.send_at, reason = excluded.reason, updated_at = excluded.updated_at
         WHERE appointments.status = 'scheduled' AND appointments.attempts = 0`,
      )
      .run(a.clientId, a.contactId, a.eventId, a.title, a.type, a.recipient, a.firstName, a.startAt, a.endAt, a.sendAt, a.reason, now, now);
  }

  due(now: number): Appointment[] {
    return (this.db.prepare("SELECT * FROM appointments WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at").all(now) as Row[]).map(
      toAppointment,
    );
  }

  reschedule(id: number, endAt: number, sendAt: number, now: number): void {
    this.db.prepare("UPDATE appointments SET end_at = ?, send_at = ?, updated_at = ? WHERE id = ?").run(endAt, sendAt, now, id);
  }

  markSkipped(id: number, reason: string, now: number): void {
    this.db
      .prepare("UPDATE appointments SET status = 'skipped', reason = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .run(reason, now, id);
  }

  markRetry(id: number, error: string, nextAt: number, now: number): void {
    this.db
      .prepare(
        `UPDATE appointments SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), send_at = ?,
           reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, nextAt, `Retrying: ${error}`, now, id);
  }

  markFailed(id: number, error: string, now: number): void {
    this.db
      .prepare("UPDATE appointments SET status = 'failed', attempts = attempts + 1, reason = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
  }

  markSent(
    a: Appointment,
    send: { providerId: string; to: string; subject: string; body: string; dryRun: boolean; recipient: string; firstName: string | null },
    now: number,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE appointments SET status = 'sent', reason = ?, recipient = ?, first_name = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(send.dryRun ? "Dry run: not actually sent" : null, send.recipient, send.firstName, now, a.id);
      this.db
        .prepare("INSERT INTO sends (appointment_id, provider_id, to_address, subject, body, dry_run, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(a.id, send.providerId, send.to, send.subject, send.body, send.dryRun ? 1 : 0, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upcoming(clientId: number, until: number): Appointment[] {
    return (
      this.db
        .prepare("SELECT * FROM appointments WHERE client_id = ? AND status = 'scheduled' AND send_at <= ? ORDER BY send_at")
        .all(clientId, until) as Row[]
    ).map(toAppointment);
  }

  history(clientId: number, limit = 50): Appointment[] {
    return (
      this.db
        .prepare("SELECT * FROM appointments WHERE client_id = ? AND status != 'scheduled' ORDER BY updated_at DESC LIMIT ?")
        .all(clientId, limit) as Row[]
    ).map(toAppointment);
  }

  sendFor(appointmentId: number): { to: string; subject: string; body: string; dryRun: boolean; sentAt: number } | undefined {
    const row = this.db
      .prepare("SELECT to_address, subject, body, dry_run, sent_at FROM sends WHERE appointment_id = ? ORDER BY id DESC LIMIT 1")
      .get(appointmentId) as Row | undefined;
    return row
      ? { to: row.to_address as string, subject: row.subject as string, body: row.body as string, dryRun: row.dry_run === 1, sentAt: row.sent_at as number }
      : undefined;
  }

  countScheduled(clientId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE client_id = ? AND status = 'scheduled'").get(clientId) as { n: number };
    return row.n;
  }

  // Unrecognized events

  recordUnrecognized(clientId: number, eventId: string, title: string, startAt: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO unrecognized_events (client_id, event_id, title, start_at, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id, event_id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at, seen_at = excluded.seen_at`,
      )
      .run(clientId, eventId, title, startAt, now);
  }

  forgetRecognized(clientId: number, eventId: string): void {
    this.db.prepare("DELETE FROM unrecognized_events WHERE client_id = ? AND event_id = ?").run(clientId, eventId);
  }

  unrecognized(clientId: number, limit = 50): { title: string; startAt: number }[] {
    return (
      this.db
        .prepare("SELECT title, start_at FROM unrecognized_events WHERE client_id = ? ORDER BY start_at DESC LIMIT ?")
        .all(clientId, limit) as Row[]
    ).map((row) => ({ title: row.title as string, startAt: row.start_at as number }));
  }

  pruneUnrecognized(olderThan: number): void {
    this.db.prepare("DELETE FROM unrecognized_events WHERE seen_at < ?").run(olderThan);
  }
}
