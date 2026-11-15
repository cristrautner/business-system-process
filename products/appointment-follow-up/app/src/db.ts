// SQLite storage. One file, migrated forward with PRAGMA user_version.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
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
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
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
