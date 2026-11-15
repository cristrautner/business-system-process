// The two background jobs: poll calendars for appointments, and send follow-ups that are due.

import { decrypt } from "./crypto.ts";
import { GoogleAuthError, type CalendarApi } from "./google.ts";
import { fromHeader, type Mailer } from "./mailer.ts";
import { computeSendAt, estimateDue, evaluate, eventTimes, isAllDay, LATEST_SEND_AFTER_END_MS } from "./rules.ts";
import { readinessProblems, type TemplateType } from "./settings.ts";
import type { Appointment, Client, Store } from "./store.ts";
import { render, type Template } from "./templates.ts";

export interface JobDeps {
  store: Store;
  calendar: CalendarApi;
  mailer: Mailer;
  tokenKey: Buffer;
  now: () => number;
  log: (message: string) => void;
}

const HOUR = 60 * 60 * 1000;
/** How far back and ahead each poll looks. */
const POLL_BACK_MS = 24 * HOUR;
const POLL_AHEAD_MS = 48 * HOUR;
/** Give up on a send that keeps failing after this long. */
const RETRY_WINDOW_MS = HOUR;

export async function pollAll(deps: JobDeps): Promise<void> {
  for (const client of deps.store.clients()) {
    await pollClient(deps, client);
  }
  deps.store.pruneUnrecognized(deps.now() - 7 * 24 * HOUR);
}

export async function pollClient(deps: JobDeps, client: Client): Promise<void> {
  const { store, calendar, now, log } = deps;
  const connection = store.connection(client.id);
  if (!connection) return;

  const startedAt = now();
  try {
    const refreshToken = decrypt(connection.refreshTokenEnc, deps.tokenKey);
    const events = await calendar.listEvents(refreshToken, connection.calendarId, startedAt - POLL_BACK_MS, startedAt + POLL_AHEAD_MS);
    const contacts = store.contactLookup(client.id);

    for (const event of events) {
      const times = eventTimes(event);
      if (!times || isAllDay(event)) continue;

      const decision = evaluate(event, client.settings, contacts);
      if (decision.action === "unrecognized") {
        if (event.status !== "cancelled") store.recordUnrecognized(client.id, event.id, event.summary ?? "(no title)", times.start, startedAt);
        continue;
      }
      store.forgetRecognized(client.id, event.id);

      // Don't create brand-new appointments for events that ended too long ago to send.
      if (!store.appointmentByEvent(client.id, event.id) && startedAt > times.end + LATEST_SEND_AFTER_END_MS) continue;

      store.upsertScheduled(
        {
          clientId: client.id,
          contactId: decision.action === "send" ? decision.contactId : null,
          eventId: event.id,
          title: event.summary ?? "",
          type: decision.type,
          recipient: decision.action === "send" ? decision.recipient : null,
          firstName: decision.action === "send" ? decision.firstName : null,
          startAt: times.start,
          endAt: times.end,
          sendAt: computeSendAt(times.end, client.settings),
          // The final call happens at send time; this is a preview for the dashboard.
          reason: decision.action === "skip" ? `Will skip unless fixed: ${decision.reason}` : null,
        },
        startedAt,
      );
    }
    store.recordPoll(client.id, startedAt, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.recordPoll(client.id, startedAt, message);
    log(`poll failed for ${client.slug}: ${message}`);
  }
}

export async function sendDue(deps: JobDeps): Promise<void> {
  for (const appointment of deps.store.due(deps.now())) {
    await sendOne(deps, appointment);
  }
}

export function templateValues(client: Client, firstName: string | null, startAt: number) {
  const s = client.settings;
  return {
    first_name: firstName ?? "",
    sender_name: s.senderName,
    business_name: s.businessName,
    phone: s.phone,
    estimate_due: estimateDue(startAt, s),
    review_link: s.reviewLink,
    warranty_note: s.warrantyNote,
    estimate_photos: s.estimatePhotos,
  };
}

export function renderFor(store: Store, client: Client, template: TemplateType, firstName: string | null, startAt: number): Template {
  return render(store.template(client.id, template), templateValues(client, firstName, startAt));
}

async function sendOne(deps: JobDeps, appointment: Appointment): Promise<void> {
  const { store, calendar, mailer, now, log } = deps;
  const at = now();
  const skip = (reason: string) => {
    store.markSkipped(appointment.id, reason, at);
    log(`skipped appointment ${appointment.id}: ${reason}`);
  };

  const client = store.client(appointment.clientId);
  if (!client) return skip("Client no longer exists");
  if (at > appointment.endAt + LATEST_SEND_AFTER_END_MS) return skip("Too late: more than 24 hours after the appointment");
  if (client.paused) return skip("Client paused");
  const problems = readinessProblems(client.settings);
  if (problems.length > 0) return skip(`Client not set up: ${problems.join(" ")}`);
  const connection = store.connection(client.id);
  if (!connection) return skip("Google Calendar not connected");

  try {
    // Re-read the event right before sending, so a late cancel or no-show still stops it.
    const refreshToken = decrypt(connection.refreshTokenEnc, deps.tokenKey);
    const event = await calendar.getEvent(refreshToken, connection.calendarId, appointment.eventId);
    if (!event) return skip("Event was deleted");

    const decision = evaluate(event, client.settings, store.contactLookup(client.id));
    if (decision.action === "unrecognized") return skip("Title no longer starts with an appointment keyword");
    if (decision.action === "skip") return skip(decision.reason);

    const times = eventTimes(event);
    if (!times) return skip("Event has no start and end time");
    const sendAt = computeSendAt(times.end, client.settings);
    if (sendAt > at + 60_000) {
      // The appointment was moved later. Wait for the new time.
      store.reschedule(appointment.id, times.end, sendAt, at);
      return;
    }

    const email = renderFor(store, client, decision.template, decision.firstName, times.start);
    const shadow = client.settings.shadowEmail.trim();
    const to = shadow || decision.recipient;
    const subject = shadow ? `[Shadow for ${decision.recipient}] ${email.subject}` : email.subject;

    const result = await mailer.send({
      from: fromHeader(client.settings.senderName, client.settings.businessName, client.settings.fromAddress),
      to,
      replyTo: client.settings.replyTo || undefined,
      bcc: client.settings.bccEmail || undefined,
      subject,
      text: email.body,
      idempotencyKey: `appointment-${appointment.id}`,
    });
    store.markSent(
      appointment,
      { providerId: result.id, to, subject, body: email.body, dryRun: mailer.dryRun, recipient: decision.recipient, firstName: decision.firstName },
      at,
    );
    log(`${mailer.dryRun ? "[dry run] " : ""}sent appointment ${appointment.id} to ${to}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GoogleAuthError) return skip(message);
    const firstAttempt = appointment.firstAttemptAt ?? at;
    if (at - firstAttempt >= RETRY_WINDOW_MS) {
      store.markFailed(appointment.id, message, at);
      log(`failed appointment ${appointment.id}: ${message}`);
      return;
    }
    const backoffMinutes = Math.min(5 * 2 ** appointment.attempts, 20);
    store.markRetry(appointment.id, message, at + backoffMinutes * 60_000, at);
    log(`will retry appointment ${appointment.id} in ${backoffMinutes} minutes: ${message}`);
  }
}

export function startScheduler(deps: JobDeps, pollSeconds: number, sendSeconds: number): () => void {
  let polling = false;
  let sending = false;
  const guard = (flag: "poll" | "send", job: () => Promise<void>) => async () => {
    if (flag === "poll" ? polling : sending) return;
    if (flag === "poll") polling = true;
    else sending = true;
    try {
      await job();
    } catch (error) {
      deps.log(`${flag} job crashed: ${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      if (flag === "poll") polling = false;
      else sending = false;
    }
  };
  const poll = guard("poll", () => pollAll(deps));
  const send = guard("send", () => sendDue(deps));
  void poll().then(send);
  const timers = [setInterval(poll, pollSeconds * 1000), setInterval(send, sendSeconds * 1000)];
  return () => timers.forEach(clearInterval);
}
