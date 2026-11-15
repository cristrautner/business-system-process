import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import { encrypt } from "../src/crypto.ts";
import { openDb } from "../src/db.ts";
import type { CalendarApi } from "../src/google.ts";
import { pollAll, sendDue, type JobDeps } from "../src/jobs.ts";
import { DryRunMailer, type Mailer, type OutgoingEmail } from "../src/mailer.ts";
import type { CalendarEvent } from "../src/rules.ts";
import { Store, type Client } from "../src/store.ts";

const zone = "America/Chicago";
const local = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();
const iso = (ms: number) => new Date(ms).toISOString();

class FakeCalendar implements CalendarApi {
  events = new Map<string, CalendarEvent>();
  failGet = false;

  put(event: CalendarEvent) {
    this.events.set(event.id, event);
  }
  async listEvents(): Promise<CalendarEvent[]> {
    return [...this.events.values()];
  }
  async getEvent(_t: string, _c: string, id: string): Promise<CalendarEvent | null> {
    if (this.failGet) throw new Error("network down");
    return this.events.get(id) ?? null;
  }
}

class FlakyMailer implements Mailer {
  readonly dryRun = false;
  calls = 0;
  async send(_email: OutgoingEmail): Promise<{ id: string }> {
    this.calls++;
    throw new Error("Resend is down");
  }
}

function appointmentEvent(id: string, summary: string, endIso: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const end = local(endIso);
  return {
    id,
    status: "confirmed",
    summary,
    start: { dateTime: iso(end - 60 * 60 * 1000) },
    end: { dateTime: iso(end) },
    attendees: [{ email: "linda@example.com", displayName: "Linda Smith" }],
    ...overrides,
  };
}

describe("poll and send", () => {
  let store: Store;
  let calendar: FakeCalendar;
  let mailer: DryRunMailer;
  let clock: number;
  let client: Client;
  let deps: JobDeps;
  const key = randomBytes(32);

  beforeEach(() => {
    store = new Store(openDb(":memory:"));
    calendar = new FakeCalendar();
    mailer = new DryRunMailer(() => {});
    clock = local("2026-11-16T12:00");
    client = store.createClient("Sandhill Roofing", "sandhill", clock);
    store.saveSettings(client.id, {
      ...client.settings,
      senderName: "Dusty",
      phone: "(555) 010-0199",
      fromAddress: "dusty@sandhillroofing.com",
      replyTo: "dusty@gmail.example",
      timezone: zone,
      ownEmails: ["dusty@sandhillroofing.com"],
    });
    store.saveConnection(client.id, encrypt("refresh", key), "dusty@gmail.example", clock);
    deps = { store, calendar, mailer, tokenKey: key, now: () => clock, log: () => {} };
  });

  it("sends two hours after the appointment ends, once", async () => {
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0, "nothing before send time");

    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 1);
    const email = mailer.sent[0]!;
    assert.equal(email.to, "linda@example.com");
    assert.equal(email.from, '"Dusty at Sandhill Roofing" <dusty@sandhillroofing.com>');
    assert.equal(email.replyTo, "dusty@gmail.example");
    assert.match(email.text, /^Hi Linda,/);
    assert.match(email.text, /by Wednesday, November 18/);

    await pollAll(deps);
    clock += 10 * 60 * 1000;
    await sendDue(deps);
    assert.equal(mailer.sent.length, 1, "never twice");
    const [sent] = store.history(client.id);
    assert.equal(sent?.status, "sent");
  });

  it("doesn't send when the event is cancelled after polling", async () => {
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    calendar.put(appointmentEvent("a", "Inspection Smith - no show", "2026-11-16T14:00"));
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0);
    assert.match(store.history(client.id)[0]?.reason ?? "", /no-show/);
  });

  it("doesn't send when the event is deleted", async () => {
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    calendar.events.clear();
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0);
    assert.equal(store.history(client.id)[0]?.reason, "Event was deleted");
  });

  it("waits when the appointment is moved later", async () => {
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T17:00"));
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0);
    clock = local("2026-11-16T19:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 1);
  });

  it("holds evening appointments until morning", async () => {
    calendar.put(appointmentEvent("a", "Estimate Smith", "2026-11-16T19:00"));
    await pollAll(deps);
    clock = local("2026-11-16T21:30");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0);
    clock = local("2026-11-17T07:30");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 1);
  });

  it("redirects everything in shadow mode", async () => {
    store.saveSettings(client.id, { ...store.client(client.id)!.settings, shadowEmail: "cris@agency.example" });
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent[0]?.to, "cris@agency.example");
    assert.match(mailer.sent[0]?.subject ?? "", /^\[Shadow for linda@example\.com\]/);
  });

  it("skips a paused client", async () => {
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    store.setPaused(client.id, true);
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent.length, 0);
    assert.equal(store.history(client.id)[0]?.reason, "Client paused");
  });

  it("skips a client that isn't set up", async () => {
    store.saveSettings(client.id, { ...store.client(client.id)!.settings, fromAddress: "" });
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.match(store.history(client.id)[0]?.reason ?? "", /not set up/);
  });

  it("records unrecognized events and ignores them", async () => {
    calendar.put(appointmentEvent("b", "Dentist", "2026-11-16T14:00"));
    await pollAll(deps);
    assert.deepEqual(store.unrecognized(client.id).map((u) => u.title), ["Dentist"]);
    assert.equal(store.countScheduled(client.id), 0);
  });

  it("doesn't pick up appointments that ended over a day ago", async () => {
    calendar.put(appointmentEvent("old", "Inspection Smith", "2026-11-14T14:00"));
    await pollAll(deps);
    assert.equal(store.countScheduled(client.id), 0);
  });

  it("uses a website-form contact's details", async () => {
    store.upsertContact(
      client.id,
      {
        firstName: "Linda", lastName: "Smith", email: "linda.form@example.com", phone: "(555) 222-3333",
        street: "1 Oak St", city: "Austin", state: "TX", zip: "78701", service: "inspection",
        insuranceClaim: "no", notes: null, source: "website",
      },
      "5552223333",
      clock,
    );
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00", { attendees: [], description: "call 555-222-3333" }));
    await pollAll(deps);
    clock = local("2026-11-16T16:00");
    await sendDue(deps);
    assert.equal(mailer.sent[0]?.to, "linda.form@example.com");
  });

  it("retries a failing send, then gives up after an hour", async () => {
    const flaky = new FlakyMailer();
    deps = { ...deps, mailer: flaky };
    calendar.put(appointmentEvent("a", "Inspection Smith", "2026-11-16T14:00"));
    await pollAll(deps);
    clock = local("2026-11-16T16:00");
    for (let i = 0; i < 20; i++) {
      await sendDue(deps);
      clock += 5 * 60 * 1000;
    }
    const [row] = store.history(client.id);
    assert.equal(row?.status, "failed");
    assert.match(row?.reason ?? "", /Resend is down/);
    assert.ok(flaky.calls >= 3 && flaky.calls <= 6, `tried ${flaky.calls} times`);
  });

  it("records a poll error on the connection", async () => {
    calendar.listEvents = async () => {
      throw new Error("Google is down");
    };
    await pollAll(deps);
    assert.equal(store.connection(client.id)?.lastError, "Google is down");
  });
});
