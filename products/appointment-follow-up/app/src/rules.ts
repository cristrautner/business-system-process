// The decisions: which calendar events are client appointments, who gets the email,
// when it goes out, and when it must not. Pure functions, no I/O, fully tested.

import { DateTime } from "luxon";
import type { AppointmentType, ClientSettings, TemplateType } from "./settings.ts";
import { templateFor } from "./settings.ts";

export interface EventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface Attendee {
  email?: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

/** The fields we use from a Google Calendar event. */
export interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
}

export interface ContactMatch {
  id: number;
  firstName: string;
  email: string | null;
}

export interface ContactLookup {
  byEmail(email: string): ContactMatch | undefined;
  byPhone(digits: string): ContactMatch | undefined;
}

export type Decision =
  | { action: "unrecognized" }
  | { action: "skip"; type: AppointmentType; reason: string }
  | {
      action: "send";
      type: AppointmentType;
      template: TemplateType;
      recipient: string;
      firstName: string | null;
      contactId: number | null;
    };

const CANCEL_MARKER = /\b(cancel|canceled|cancelled|no[\s-]?show)\b/i;
const FINAL_MARKER = /\b(final|complete|completed|done)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const NAME_LINE = /^\s*name\s*:\s*([A-Za-z][A-Za-z'-]*)/im;

/** Picks the appointment type from the first word of the title, or null if it isn't one. */
export function classifyTitle(title: string, keywords: Record<string, AppointmentType>): AppointmentType | null {
  const firstWord = title.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (!firstWord) return null;
  if (keywords[firstWord]) return keywords[firstWord]!;
  for (const [keyword, type] of Object.entries(keywords)) {
    // Accept abbreviations ("insp") and plurals ("inspections"), not unrelated short words.
    if (firstWord.length >= 4 && keyword.startsWith(firstWord)) return type;
    if (firstWord.startsWith(keyword) && firstWord.length - keyword.length <= 2) return type;
  }
  return null;
}

export function isAllDay(event: CalendarEvent): boolean {
  return Boolean(event.start?.date && !event.start?.dateTime);
}

export function eventTimes(event: CalendarEvent): { start: number; end: number } | null {
  const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
  const end = event.end?.dateTime ? Date.parse(event.end.dateTime) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

export function hasCancelMarker(event: CalendarEvent): boolean {
  return CANCEL_MARKER.test(event.summary ?? "") || CANCEL_MARKER.test(event.description ?? "");
}

export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function cleanFirstName(value: string | undefined | null): string | null {
  if (!value || value.includes("@")) return null;
  const word = value.trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
  if (word.length < 2) return null;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface Recipient {
  email: string;
  firstName: string | null;
  contactId: number | null;
  declined: boolean;
}

/**
 * Finds the homeowner. A matched website-form contact wins, then the first guest who isn't
 * the contractor, then an email address written in the description.
 */
export function findRecipient(event: CalendarEvent, settings: ClientSettings, contacts: ContactLookup): Recipient | null {
  const own = new Set(settings.ownEmails.map((e) => e.toLowerCase()));
  const ignored = settings.ignoreDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
  const isOwn = (email: string) => {
    const lower = email.toLowerCase();
    return own.has(lower) || ignored.some((domain) => lower.endsWith(`@${domain}`));
  };

  const guests = (event.attendees ?? []).filter((a) => a.email && !a.self && !a.resource && !isOwn(a.email));
  const description = event.description ?? "";
  const descriptionEmails = [...description.matchAll(EMAIL)].map((m) => m[0]).filter((e) => !isOwn(e));
  const descriptionPhones = [...description.matchAll(PHONE)].map((m) => phoneDigits(m[0])).filter(Boolean);
  const nameLine = cleanFirstName(description.match(NAME_LINE)?.[1]);

  const guest = guests[0];
  const declined = guest?.responseStatus === "declined";

  // A website-form contact matched by email or phone wins over everything else.
  for (const email of [...guests.map((g) => g.email!), ...descriptionEmails]) {
    const contact = contacts.byEmail(email.toLowerCase());
    if (contact?.email) return { email: contact.email, firstName: cleanFirstName(contact.firstName), contactId: contact.id, declined };
  }
  for (const digits of descriptionPhones) {
    const contact = contacts.byPhone(digits);
    if (contact?.email) return { email: contact.email, firstName: cleanFirstName(contact.firstName), contactId: contact.id, declined };
  }

  if (guest?.email) {
    return { email: guest.email, firstName: cleanFirstName(guest.displayName) ?? nameLine, contactId: null, declined };
  }
  const fromDescription = descriptionEmails[0];
  if (fromDescription) return { email: fromDescription, firstName: nameLine, contactId: null, declined: false };
  return null;
}

/** Decides what to do with one calendar event right now. */
export function evaluate(event: CalendarEvent, settings: ClientSettings, contacts: ContactLookup): Decision {
  const type = classifyTitle(event.summary ?? "", settings.keywords);
  if (!type) return { action: "unrecognized" };

  if (isAllDay(event)) return { action: "skip", type, reason: "All-day event" };
  if (event.status === "cancelled") return { action: "skip", type, reason: "Event was cancelled or deleted" };
  if (hasCancelMarker(event)) return { action: "skip", type, reason: "Marked cancelled or no-show" };

  if (type === "install" && settings.installRequiresFinal) {
    const times = eventTimes(event);
    const longEvent = times !== null && times.end - times.start >= 20 * 60 * 60 * 1000;
    if (!longEvent && !FINAL_MARKER.test(event.summary ?? "")) {
      return { action: "skip", type, reason: "Install not marked final (add “final” to the last day's title)" };
    }
  }

  const recipient = findRecipient(event, settings, contacts);
  if (!recipient) return { action: "skip", type, reason: "No homeowner email on the event" };
  if (recipient.declined) return { action: "skip", type, reason: "Homeowner declined the invite" };

  return {
    action: "send",
    type,
    template: templateFor(type),
    recipient: recipient.email,
    firstName: recipient.firstName,
    contactId: recipient.contactId,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** End of the appointment plus the delay, moved out of quiet hours in the client's time zone. */
export function computeSendAt(endMs: number, settings: ClientSettings): number {
  const candidate = DateTime.fromMillis(endMs + settings.delayMinutes * 60_000, { zone: settings.timezone });
  const start = minutesOf(settings.quietStart);
  const end = minutesOf(settings.quietEnd);
  if (start === end) return candidate.toMillis();

  const now = candidate.hour * 60 + candidate.minute;
  const crossesMidnight = start > end;
  const quiet = crossesMidnight ? now >= start || now < end : now >= start && now < end;
  if (!quiet) return candidate.toMillis();

  let release = candidate.set({ hour: Math.floor(end / 60), minute: end % 60, second: 0, millisecond: 0 });
  if (crossesMidnight && now >= start) release = release.plus({ days: 1 });
  return release.toMillis();
}

/** The appointment date plus the estimate turnaround in business days, e.g. "Thursday, November 20". */
export function estimateDue(startMs: number, settings: ClientSettings): string {
  let day = DateTime.fromMillis(startMs, { zone: settings.timezone }).setLocale("en-US").startOf("day");
  let remaining = Math.max(0, Math.round(settings.estimateTurnaroundDays));
  while (remaining > 0) {
    day = day.plus({ days: 1 });
    if (day.weekday <= 5) remaining--;
  }
  return day.toFormat("cccc, LLLL d");
}

/** Sends never go out more than this long after the appointment ends. */
export const LATEST_SEND_AFTER_END_MS = 24 * 60 * 60 * 1000;
