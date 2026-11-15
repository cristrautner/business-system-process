# Appointment follow-up: app spec

A small app that emails a contractor's customer a set time after an appointment ends, thanking them and telling them what happens next. It's built first for Dusty at Sandhill Roofing, then reused for other Infusionmedia contractor clients.

Drafted 2026-11-15. Templates are in `templates.md` in this folder.

## Why this exists

When Infusionmedia moved Dusty off Thryv, one of his first requests was the two-hour appointment follow-up he'd lost. He says homeowners mentioned it, it made him look “together,” and he'd never remember to send one himself. He has no CRM now, so nothing replaced it.

Thryv's version, from its help center:

- One email per appointment: Thryv's branded template plus a single free-text message.
- The default delay is 30 minutes after the appointment. Dusty's was set to two hours.
- An appointment counts as completed once its end time passes. Marking it a no-show cancels the email.
- Varying the email by service meant editing template code, so in practice every appointment got the same message.

This sits under the micro-behaviour formula from Kieran Flanagan's Marketing Against the Grain episode: a small contractor who means to follow up after appointments but never does. It's priced as a practical add-on for existing clients, not as a standalone software business.

## What v1 does

Two hours after a client appointment on the contractor's Google Calendar ends, the app sends the homeowner the email for that appointment type. It sends from the contractor's own domain, and replies go to the contractor's inbox. It sends by default, like Thryv did. The contractor stops a send by deleting the event, marking it cancelled or a no-show, or pressing Skip in the dashboard.

### Not in v1

- Text messages (US business texting means A2P 10DLC registration, which isn't worth it until email proves out)
- Multi-step sequences, like a nudge after the estimate goes out
- Review management beyond the link in the job-complete template
- Writing to the calendar
- CRM screens. v1 stores contacts, and the screens come later (see “CRM path and rebuild requirements”)

## How it works

1. **Connect.** The contractor signs in with Google once and grants read-only calendar access. The app stores the refresh token encrypted.
2. **Poll.** Every 5 minutes a scheduled job lists each connected calendar's events that ended recently or end soon.
3. **Recognize.** An event counts as a client appointment only when its title starts with one of that client's type keywords (see below). Everything else on the calendar is ignored.
4. **Find the recipient.** See “Recipient” below. An event with no homeowner email is recorded as skipped, not sent.
5. **Schedule.** Send time is the event's end plus the client's delay (default 120 minutes), pushed out of quiet hours.
6. **Recheck, then send.** At send time the app re-reads the event. If it's been deleted, moved, or marked cancelled or no-show, it doesn't send. Otherwise it renders the template and sends through Resend.
7. **Record.** Every send, skip and failure is logged with a reason and shown in the dashboard.

## Rules

### Appointment types

Each client has a keyword list. The first word of the event title, ignoring case, picks the template.

| Keyword | Template |
|---|---|
| `Inspection` | Inspection |
| `Estimate` | Estimate review |
| `Adjuster` | Adjuster meeting |
| `Install`, `Repair` | Job complete |
| `Appointment` | General appointment |

Keywords are client settings, so they match what each contractor already types. The app should accept a little variation, such as “Insp” or a trailing colon, and the dashboard should list recent events it didn't recognize, so keywords can be adjusted.

### Recipient

In order of preference:

1. **Event guests,** excluding the contractor's own addresses and any domain on the client's ignore list.
2. **An email address in the event description.**
3. **A matched contact from the website form:** when an event's guest email or a phone number in its description matches a `contacts` record, that contact's email and first name win over both of the above. See “CRM path and rebuild requirements.”

v1 sends to one recipient. If several qualify, it uses the first guest and lists the others in the log.

The first name comes from the guest's display name, a “Name:” line in the description, or the word after the keyword in the title (as in “Inspection Smith”). If none is found, the greeting falls back to “Hi there.”

### Don't send when

- the event is deleted or its status is cancelled
- the title or description contains “cancel,” “no-show,” “noshow” or “no show”
- the homeowner guest declined the invite
- it's an all-day event
- no recipient email was found
- the contractor pressed Skip in the dashboard
- this event already got a follow-up. That's tracked by event ID: a rescheduled event moves its send time rather than sending twice

### Timing

- The delay defaults to 120 minutes and is set per client.
- Quiet hours default to 8:00 PM to 7:30 AM in the client's time zone. A send that would land inside them waits until the end of quiet hours. Templates avoid words like “today” for this reason.
- The poll window covers events that ended up to 24 hours ago, so a server restart doesn't drop sends. Anything older than that is never sent late.

### Multi-day jobs

A four-day install shows up as four events or as one long event. v1 sends job-complete only after an event titled with the keyword plus “final” or “complete,” or after the single long event ends. This is an open question for Dusty.

## Sending

- Sent through Resend, the account Infusionmedia already uses, from a verified sender on the client's domain (for example `dusty@sandhillroofing.com`).
- The reply-to address is the contractor's real inbox. The from name is “Dusty at Sandhill Roofing.”
- Plain-text body, with no tracking pixels or click tracking. These should look like a personal note.
- Each client domain needs Resend's DNS records added. For Dusty, fold that into the site rebuild.
- Check the Resend plan's sending-domain limit before onboarding a second client. Every client sends from their own domain.
- If a send fails, retry with backoff for up to an hour. After that, mark it failed and show it in the dashboard.

## Dashboard

A simple internal admin, used by Infusionmedia and optionally by each contractor:

- **Upcoming:** scheduled sends for the next 24 hours, each with a Skip button
- **History:** sent, skipped and failed messages, with reasons and a preview of what went out
- **Unrecognized:** recent calendar events that didn't match a keyword
- **Templates:** an editor per appointment type, with a live preview using sample values
- **Settings:** delay, quiet hours, time zone, estimate turnaround, keywords, sender details, review link, and a pause switch for the whole client

## Data

SQLite, one file:

- `clients`: business details, settings, time zone, sender and reply-to addresses, pause flag
- `google_connections`: client, calendar ID, encrypted refresh token, last poll time
- `templates`: client, appointment type, subject, body
- `contacts`: client, first name, last name, email, phone, property address (street, city, state, ZIP), source (website form, phone, other), insurance claim (yes, no, not sure), created time. Insurance carrier and claim number are added later by the contractor, never asked on the public form. See “CRM path and rebuild requirements.”
- `appointments`: client, contact (when matched), event ID, title, type, recipient, first name, end time, send time, status (`scheduled`, `sent`, `skipped`, `failed`), reason
- `sends`: appointment, Resend message ID, rendered subject and body, sent time

v1 creates `contacts` rows even before the CRM screens exist, so every web lead and every follow-up is on record from the first day.

## Deployment

- One Docker container on the Hostinger VPS, deployed the same way as Invoice Ninja, behind the existing reverse proxy, on its own subdomain with HTTPS. Google's sign-in won't redirect to a bare IP, so the subdomain is required.
- The scheduler runs inside the container. Nothing depends on platform cron limits.
- Secrets (the Google OAuth client, the Resend API key, the token-encryption key) live in an env file outside the repo.
- A nightly off-server backup of the SQLite file. Losing it means every client has to reconnect Google.
- Recommended stack: Node and TypeScript in a single process, with SQLite. Any stack with a reliable in-process scheduler works.

## Google access

- Scope: read-only calendar events access. No Gmail access is needed, because sending goes through Resend.
- An unverified Google app works for a small number of users but shows a warning screen at sign-in. That's acceptable for a handful of clients. Plan for Google's verification if this grows.

## Testing and launch

1. **Dry run.** Point the app at a test calendar, with every send redirected to an internal address.
2. **Dusty, shadow mode.** Connect his calendar for a week with sends going to Infusionmedia only. Check that it recognizes his real events, finds recipients and gets the timing right.
3. **Dusty, live.** For the first two weeks, BCC an Infusionmedia address on every send.
4. **Second client,** only after Dusty has run clean for a month.

## Pricing

Practical, not a subscription business: include setup in Dusty's site rebuild, then charge a small monthly upkeep fee. Later clients pay a setup fee plus the same upkeep. Numbers to be decided.

## CRM path and rebuild requirements

Thryv gave Dusty more than the follow-up email: a contact list, appointment history and a place to track jobs. The follow-up app already has to know who the homeowner is, what the appointment was and when it happened, so it can grow into a lightweight CRM without starting over. Sandhill's site rebuild is the time to lay the groundwork.

### Where it grows

| Stage | Adds | Depends on |
|---|---|---|
| v1 | Follow-up emails, plus a `contacts` record for every web lead and every appointment recipient | Google Calendar, Resend |
| CRM 1 | Contact pages showing details, appointment history, every email sent and free-text notes. Insurance carrier and claim number fields. | The website form posting into the app |
| CRM 2 | A short pipeline: new lead, inspected, estimate sent, won, lost. Stages move automatically where the app can tell (an `Inspection` appointment ends, so the lead moves to inspected) and by hand otherwise. | CRM 1 in daily use |
| Later, maybe | “Estimate sent” and “no decision yet” nudges. Possibly driven by quotes in Invoice Ninja, which already handles clients, quotes and invoices on the VPS. | Checking Invoice Ninja's API and webhooks, and whether Sandhill should live in Infusionmedia's Invoice Ninja at all |

Each stage ships only after the one before it is in regular use. Invoicing, payments, review management and a client portal are out of scope. Those are what turn a lightweight CRM into a Thryv replacement, and that's a much bigger commitment to support.

### Website form

Roofing jobs run through insurance adjusters, inspectors, permits and HOAs, so the contractor needs full contact details from the first touch.

Required fields:

- First name and last name, as separate fields
- Email
- Phone
- Property address as separate street, city, state and ZIP fields. That's the house with the roof, which can differ from the contact's mailing address.
- Service needed: inspection, repair, replacement, storm or insurance damage, or other

Optional fields:

- Is this an insurance claim? (Yes, no, not sure)
- Anything else we should know? (free text)

Leave insurance carrier, claim number and policy details off the public form. They make the form longer and scarier, and the contractor collects them once the job is real.

Keep every field separate and labeled. Free-text blobs like “Name and address” can't be matched to calendar events or searched later.

### Rebuild checklist

- **The form posts to the follow-up app** (and still notifies Dusty), so every web lead lands in `contacts` from launch day, even before the CRM screens exist.
- **Decide self-scheduling or callback.** Most roofers call the homeowner back to set a time. Either way, the app links the form submission to the calendar event Dusty creates by matching email or phone. If he books by phone without the email, he adds it to the event.
- **Set up Dusty's email on his own domain**, and add Resend's DNS records so the follow-ups send from it.
- **Add consent text by the submit button:** something like “We'll email you about your appointment.” Keep it accurate to what the app sends.
- **Update the privacy policy** to cover collecting contact and property details and sending appointment emails through a third-party service.
- **Add spam protection** (a honeypot field or a light CAPTCHA), so junk submissions don't become contacts or trigger emails.

## Open questions

For Dusty:

- Is he on Google Calendar? Is his email regular Gmail or Google Workspace on his own domain?
- How do appointments get booked today, and does the homeowner's email ever make it onto the event?
- What does he call each appointment type on his calendar?
- How does a multi-day install appear on his calendar?
- Can he find an old Thryv follow-up in his sent folder? That would be a bonus, not a blocker.

For Infusionmedia:

- Does the new Sandhill site offer self-scheduling, or a request form followed by a callback? The form requirements above work either way. Only self-scheduling, where the app creates calendar events itself, needs calendar write access.
- Who watches the dashboard's failed and unrecognized lists, and how often?

## Phase 2 candidates

- Self-scheduling on the new site, where the app creates calendar events (needs calendar write access)
- A nudge a few days after the estimate goes out, and a check-in if there's no decision
- A daily digest emailed to the contractor listing what was sent
- A text-message option
