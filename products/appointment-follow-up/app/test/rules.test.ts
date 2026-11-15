import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  classifyTitle,
  computeSendAt,
  estimateDue,
  evaluate,
  findRecipient,
  type CalendarEvent,
  type ContactLookup,
} from "../src/rules.ts";
import { DEFAULT_KEYWORDS, defaultSettings, parseKeywordLines, type ClientSettings } from "../src/settings.ts";

const settings = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...defaultSettings("Sandhill Roofing"),
  ownEmails: ["dusty@sandhillroofing.com"],
  ...overrides,
});

const noContacts: ContactLookup = { byEmail: () => undefined, byPhone: () => undefined };

const at = (iso: string) => ({ dateTime: iso });

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt1",
    status: "confirmed",
    summary: "Inspection Smith",
    start: at("2026-11-16T14:00:00-06:00"),
    end: at("2026-11-16T15:00:00-06:00"),
    attendees: [
      { email: "dusty@sandhillroofing.com", self: true, organizer: true, responseStatus: "accepted" },
      { email: "linda.smith@example.com", displayName: "Linda Smith", responseStatus: "needsAction" },
    ],
    ...overrides,
  };
}

describe("classifyTitle", () => {
  it("matches the first word, ignoring case and punctuation", () => {
    assert.equal(classifyTitle("Inspection Smith", DEFAULT_KEYWORDS), "inspection");
    assert.equal(classifyTitle("ESTIMATE: Jones", DEFAULT_KEYWORDS), "estimate");
    assert.equal(classifyTitle("  adjuster - 123 Oak St", DEFAULT_KEYWORDS), "adjuster");
  });

  it("accepts abbreviations of four letters or more, and plurals", () => {
    assert.equal(classifyTitle("Insp Smith", DEFAULT_KEYWORDS), "inspection");
    assert.equal(classifyTitle("Inspections block", DEFAULT_KEYWORDS), "inspection");
  });

  it("ignores everything else on the calendar", () => {
    assert.equal(classifyTitle("Dentist", DEFAULT_KEYWORDS), null);
    assert.equal(classifyTitle("In office", DEFAULT_KEYWORDS), null);
    assert.equal(classifyTitle("Smith inspection", DEFAULT_KEYWORDS), null);
    assert.equal(classifyTitle("", DEFAULT_KEYWORDS), null);
  });
});

describe("findRecipient", () => {
  it("uses the first guest who isn't the contractor", () => {
    const r = findRecipient(event(), settings(), noContacts);
    assert.equal(r?.email, "linda.smith@example.com");
    assert.equal(r?.firstName, "Linda");
  });

  it("skips ignored domains", () => {
    const e = event({
      attendees: [
        { email: "office@sandhillhelp.com" },
        { email: "linda.smith@example.com", displayName: "Linda Smith" },
      ],
    });
    assert.equal(findRecipient(e, settings({ ignoreDomains: ["sandhillhelp.com"] }), noContacts)?.email, "linda.smith@example.com");
  });

  it("falls back to an email and a Name line in the description", () => {
    const e = event({ attendees: undefined, description: "Name: linda\nEmail: linda@example.com\n555-010-0199" });
    const r = findRecipient(e, settings(), noContacts);
    assert.equal(r?.email, "linda@example.com");
    assert.equal(r?.firstName, "Linda");
  });

  it("prefers a website-form contact matched by phone", () => {
    const contacts: ContactLookup = {
      byEmail: () => undefined,
      byPhone: (digits) => (digits === "5550100199" ? { id: 7, firstName: "Linda", email: "linda@form.example" } : undefined),
    };
    const e = event({ attendees: undefined, description: "Call (555) 010-0199 first" });
    const r = findRecipient(e, settings(), contacts);
    assert.deepEqual(r, { email: "linda@form.example", firstName: "Linda", contactId: 7, declined: false });
  });

  it("never uses the title for a first name", () => {
    const e = event({ attendees: [{ email: "lsmith@example.com" }] });
    assert.equal(findRecipient(e, settings(), noContacts)?.firstName, null);
  });

  it("returns null when there's nobody to email", () => {
    assert.equal(findRecipient(event({ attendees: [{ email: "dusty@sandhillroofing.com", self: true }] }), settings(), noContacts), null);
  });
});

describe("evaluate", () => {
  it("sends for a normal appointment", () => {
    const d = evaluate(event(), settings(), noContacts);
    assert.equal(d.action, "send");
    if (d.action === "send") {
      assert.equal(d.template, "inspection");
      assert.equal(d.recipient, "linda.smith@example.com");
    }
  });

  it("reports events that aren't appointments as unrecognized", () => {
    assert.deepEqual(evaluate(event({ summary: "Lunch" }), settings(), noContacts), { action: "unrecognized" });
  });

  const skipReason = (e: CalendarEvent, s = settings()) => {
    const d = evaluate(e, s, noContacts);
    return d.action === "skip" ? d.reason : d.action;
  };

  it("skips cancelled and deleted events", () => {
    assert.match(skipReason(event({ status: "cancelled" })), /cancelled or deleted/);
  });

  it("skips cancel and no-show markers in the title or description", () => {
    for (const summary of ["Inspection Smith CANCELED", "Inspection Smith - no show", "Inspection Smith noshow", "Inspection Smith (cancelled)"]) {
      assert.match(skipReason(event({ summary })), /no-show/, summary);
    }
    assert.match(skipReason(event({ description: "Customer was a no-show" })), /no-show/);
  });

  it("doesn't treat “cancellation” in boilerplate as a cancel", () => {
    assert.equal(skipReason(event({ description: "Our cancellation policy: 24 hours notice" })), "send");
  });

  it("skips all-day events", () => {
    assert.match(skipReason(event({ start: { date: "2026-11-16" }, end: { date: "2026-11-17" } })), /All-day/);
  });

  it("skips when the homeowner declined", () => {
    const e = event({ attendees: [{ email: "linda@example.com", responseStatus: "declined" }] });
    assert.match(skipReason(e), /declined/);
  });

  it("skips when there's no homeowner email", () => {
    assert.match(skipReason(event({ attendees: [] })), /No homeowner email/);
  });

  it("holds the job-complete email until the final install day", () => {
    assert.match(skipReason(event({ summary: "Install Smith day 1" })), /not marked final/);
    assert.equal(skipReason(event({ summary: "Install Smith final" })), "send");
    assert.equal(skipReason(event({ summary: "Install Smith day 1" }), settings({ installRequiresFinal: false })), "send");
  });

  it("sends after a single long install event", () => {
    const e = event({ summary: "Install Smith", start: at("2026-11-16T08:00:00-06:00"), end: at("2026-11-18T17:00:00-06:00") });
    assert.equal(skipReason(e), "send");
  });

  it("sends repairs without a final marker, using the job-complete template", () => {
    const d = evaluate(event({ summary: "Repair Smith" }), settings(), noContacts);
    assert.equal(d.action === "send" && d.template, "job_complete");
  });
});

describe("computeSendAt", () => {
  const chicago = (iso: string) => DateTime.fromISO(iso, { zone: "America/Chicago" }).toMillis();
  const show = (ms: number) => DateTime.fromMillis(ms, { zone: "America/Chicago" }).toFormat("yyyy-MM-dd HH:mm");

  it("adds the delay", () => {
    assert.equal(show(computeSendAt(chicago("2026-11-16T15:00"), settings())), "2026-11-16 17:00");
  });

  it("holds evening sends until the morning", () => {
    assert.equal(show(computeSendAt(chicago("2026-11-16T18:30"), settings())), "2026-11-17 07:30");
  });

  it("holds sends that land after midnight until the same morning", () => {
    assert.equal(show(computeSendAt(chicago("2026-11-16T23:30"), settings())), "2026-11-17 07:30");
  });

  it("handles quiet hours that don't cross midnight", () => {
    const s = settings({ quietStart: "12:00", quietEnd: "13:00", delayMinutes: 0 });
    assert.equal(show(computeSendAt(chicago("2026-11-16T12:15"), s)), "2026-11-16 13:00");
  });

  it("can turn quiet hours off", () => {
    const s = settings({ quietStart: "00:00", quietEnd: "00:00" });
    assert.equal(show(computeSendAt(chicago("2026-11-16T22:00"), s)), "2026-11-17 00:00");
  });

  it("uses the client's time zone, across a daylight-saving change", () => {
    const s = settings({ timezone: "America/Denver" });
    const end = DateTime.fromISO("2026-11-01T00:30", { zone: "America/Denver" }).toMillis();
    const sendAt = DateTime.fromMillis(computeSendAt(end, s), { zone: "America/Denver" });
    assert.equal(sendAt.toFormat("yyyy-MM-dd HH:mm"), "2026-11-01 07:30");
  });
});

describe("estimateDue", () => {
  const chicago = (iso: string) => DateTime.fromISO(iso, { zone: "America/Chicago" }).toMillis();

  it("counts business days", () => {
    assert.equal(estimateDue(chicago("2026-11-16T14:00"), settings({ estimateTurnaroundDays: 3 })), "Thursday, November 19");
  });

  it("skips the weekend", () => {
    assert.equal(estimateDue(chicago("2026-11-20T14:00"), settings({ estimateTurnaroundDays: 2 })), "Tuesday, November 24");
  });
});

describe("parseKeywordLines", () => {
  it("reads keyword lines and reports bad ones", () => {
    const { keywords, errors } = parseKeywordLines("Insp = inspection\nquote = estimate\nbad line\nfoo = bar");
    assert.deepEqual(keywords, { insp: "inspection", quote: "estimate" });
    assert.equal(errors.length, 2);
  });
});
