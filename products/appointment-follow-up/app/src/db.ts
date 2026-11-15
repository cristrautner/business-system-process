// SQLite storage. One file, migrated forward with PRAGMA user_version.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    settings TEXT NOT NULL DEFAULT '{}',
    lead_api_key TEXT NOT NULL UNIQUE,
    connect_token TEXT NOT NULL UNIQUE,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE google_connections (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    google_email TEXT,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    refresh_token_enc TEXT NOT NULL,
    last_poll_at INTEGER,
    last_error TEXT,
    connected_at INTEGER NOT NULL
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (client_id, type)
  );

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    phone_digits TEXT,
    street TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    service TEXT,
    insurance_claim TEXT,
    notes TEXT,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX contacts_email ON contacts (client_id, email);
  CREATE INDEX contacts_phone ON contacts (client_id, phone_digits);

  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    recipient TEXT,
    first_name TEXT,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    send_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (client_id, event_id)
  );
  CREATE INDEX appointments_due ON appointments (status, send_at);

  CREATE TABLE sends (
    id INTEGER PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    provider_id TEXT,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    sent_at INTEGER NOT NULL
  );

  CREATE TABLE unrecognized_events (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    UNIQUE (client_id, event_id)
  );
  `,
  // 2: storm alerts. Contacts gain a customer flag and coordinates; sends can belong to a storm alert.
  `
  ALTER TABLE contacts ADD COLUMN is_customer INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE contacts ADD COLUMN job_date TEXT;
  ALTER TABLE contacts ADD COLUMN storm_opt_out INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE contacts ADD COLUMN lat REAL;
  ALTER TABLE contacts ADD COLUMN lon REAL;
  -- NULL means not tried yet. Otherwise 'matched', 'not_found' or 'error'.
  ALTER TABLE contacts ADD COLUMN geocode_status TEXT;
  ALTER TABLE contacts ADD COLUMN geocode_note TEXT;
  ALTER TABLE contacts ADD COLUMN geocoded_at INTEGER;
  CREATE INDEX contacts_geocode ON contacts (geocode_status);

  -- One row per storm date checked. One MESH file serves every client.
  CREATE TABLE storm_runs (
    storm_date TEXT PRIMARY KEY,
    file_key TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    max_mm REAL,
    report_count INTEGER,
    checked_at INTEGER NOT NULL
  );

  CREATE TABLE storm_days (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    storm_date TEXT NOT NULL,
    file_key TEXT NOT NULL,
    max_mm REAL NOT NULL,
    status TEXT NOT NULL,
    review_token TEXT NOT NULL UNIQUE,
    postcards INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    notified_at INTEGER,
    UNIQUE (client_id, storm_date)
  );

  CREATE TABLE storm_hits (
    id INTEGER PRIMARY KEY,
    storm_day_id INTEGER NOT NULL REFERENCES storm_days(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    street TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip TEXT NOT NULL,
    mesh_mm REAL NOT NULL,
    report_miles REAL,
    report_size REAL,
    report_location TEXT,
    -- pending (waiting for review), skipped (not eligible), removed (unticked), approved
    status TEXT NOT NULL,
    reason TEXT,
    -- NULL when there's no email or it wasn't approved; else queued, sent, failed
    email_status TEXT,
    send_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER,
    email_reason TEXT,
    postcard_batch_id INTEGER REFERENCES postcard_batches(id) ON DELETE SET NULL,
    unsub_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX storm_hits_day ON storm_hits (storm_day_id);
  CREATE INDEX storm_hits_due ON storm_hits (email_status, send_at);
  CREATE INDEX storm_hits_contact ON storm_hits (contact_id);

  CREATE TABLE postcard_batches (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    storm_day_id INTEGER NOT NULL REFERENCES storm_days(id) ON DELETE CASCADE,
    -- needs_order, ordered, cancelled
    status TEXT NOT NULL,
    piece_count INTEGER NOT NULL,
    order_ref TEXT,
    created_at INTEGER NOT NULL,
    ordered_at INTEGER
  );

  CREATE TABLE unsubscribes (
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, email)
  );

  CREATE TABLE sends_v2 (
    id INTEGER PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
    storm_hit_id INTEGER REFERENCES storm_hits(id) ON DELETE CASCADE,
    provider_id TEXT,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    sent_at INTEGER NOT NULL
  );
  INSERT INTO sends_v2 (id, appointment_id, provider_id, to_address, subject, body, dry_run, sent_at)
    SELECT id, appointment_id, provider_id, to_address, subject, body, dry_run, sent_at FROM sends;
  DROP TABLE sends;
  ALTER TABLE sends_v2 RENAME TO sends;
  CREATE INDEX sends_appointment ON sends (appointment_id);
  CREATE INDEX sends_storm_hit ON sends (storm_hit_id);

  -- Replays of past storm days against a client's customers, for the "how many were hit last year" report.
  CREATE TABLE storm_reports (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    threshold_inches REAL NOT NULL,
    -- queued, running, done, error
    status TEXT NOT NULL,
    next_date TEXT NOT NULL,
    days_checked INTEGER NOT NULL DEFAULT 0,
    days_missing INTEGER NOT NULL DEFAULT 0,
    customers_checked INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
