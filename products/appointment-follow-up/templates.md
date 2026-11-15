# Appointment follow-up: email templates

First drafts of the emails the app sends after a roofing appointment, written for Dusty at Sandhill Roofing and reusable for any contractor client by swapping the settings. The app picks the template by appointment type. See `spec.md` in this folder for how that works.

Drafted 2026-11-15. Not yet reviewed by Dusty.

## What we're improving on

Thryv sent Dusty one email for every appointment: its branded template wrapped around a single free-text message. Thryv's suggested content for that box was a thank-you, a Facebook follow, a Google review link and business news. Its default delay is 30 minutes, so someone set Dusty's to two hours on purpose. Varying the email by service meant editing template code, which a roofer almost certainly never did. (Source: the settings screenshot in Thryv's help article “How To Edit Booking and Post Appointment Auto Reminders/Messages,” step 9.)

Dusty says homeowners mentioned the email, it made him look “together,” and he'd never remember to send one himself. These templates keep what worked and fix three things:

1. Each appointment type gets its own message.
2. Every email tells the homeowner what happens next, and when.
3. The review request moves to the end of the job. Asking for a Google review after a free inspection, before any work is done, reads as premature.

## Writing rules

These apply to any edit, for Dusty or for later clients.

- Write as the roofer, first person singular, the way he'd talk to a homeowner on the driveway. No “our team is committed to excellence.”
- Keep it under about 120 words. These should read like a note he typed on his phone, not a newsletter.
- Plain text only, with no logo, banner or buttons. A plain email looks personal and lands in the inbox more reliably.
- No time words like “today” or “this afternoon.” Quiet hours can push a send to the next morning (see `spec.md`), so the email has to read correctly whenever it arrives.
- One clear next step per email.
- No promotions or discounts. These are relationship emails following an appointment the homeowner booked, and keeping them free of offers keeps them clearly out of marketing-email territory.
- Never promise a price, a date the roofer hasn't set in settings, or anything about the insurance claim's outcome.

## Variables

Settings are per client. Appointment values come from the calendar event or a matched website-form contact.

| Variable | Source | Example |
|---|---|---|
| `{{first_name}}` | Homeowner's first name from a matched website-form contact, the guest name on the event, or the event title. If none is found, the greeting becomes “Hi there,” | Linda |
| `{{sender_name}}` | Client setting | Dusty |
| `{{business_name}}` | Client setting | Sandhill Roofing |
| `{{phone}}` | Client setting, the number homeowners should call or text | (555) 010-0199 |
| `{{estimate_due}}` | Appointment date plus the client's estimate turnaround in business days, written as a weekday and date | Thursday, November 20 |
| `{{review_link}}` | Client setting, the Google review link | g.page/r/... |
| `{{warranty_note}}` | Optional client setting. The line is left out if empty | Your warranty paperwork will come by email within a week. |

Lines marked `[optional]` are on or off per client.

## 1. Inspection

Calendar keyword: `Inspection`. Sent after a roof inspection, before any estimate exists.

```
Subject: Your roof inspection with {{business_name}}

Hi {{first_name}},

Thanks for having me out to look at your roof. I appreciate you making the time.

Here's what happens next: I'll put together your written estimate and have it to you by {{estimate_due}}. [optional] It'll include photos of what I found, so you can see what I saw up there.

If any questions come up before then, just reply to this email or call me at {{phone}}.

Thanks again,
{{sender_name}}
{{business_name}}
{{phone}}
```

## 2. Estimate review

Calendar keyword: `Estimate`. Sent after he walks the homeowner through the estimate in person.

```
Subject: Thanks for going over the estimate with me

Hi {{first_name}},

Thanks for sitting down with me to go over your estimate. A new roof is a big decision, and I don't want you to feel rushed.

If anything in the estimate isn't clear, reply here or call me at {{phone}} and I'll walk through it again. When you're ready to move forward, same thing: let me know and we'll get you on the schedule.

Thanks,
{{sender_name}}
{{business_name}}
{{phone}}
```

## 3. Adjuster meeting

Calendar keyword: `Adjuster`. Sent after he meets the insurance adjuster at the homeowner's house.

```
Subject: Next steps after the adjuster visit

Hi {{first_name}},

Thanks for having me there when the adjuster came out.

The next step is on the insurance side. Your insurance company will send you a written summary of what they're covering. When it arrives, forward it to me or text a photo of it to {{phone}}, and I'll go over it with you so you know exactly what it means for your roof.

Thanks,
{{sender_name}}
{{business_name}}
{{phone}}
```

Some states restrict what a contractor can say or do on a homeowner's claim. This template stays on the safe side of that: it offers to explain the paperwork, not to negotiate with the insurer. Confirm with Dusty that it matches how he works and what his state allows before turning it on.

## 4. Job complete

Calendar keyword: `Install` or `Repair`. Sent after the last day of the job. This is where the review request belongs.

```
Subject: Thanks for trusting us with your roof

Hi {{first_name}},

Thanks for trusting {{business_name}} with your roof. We should be all wrapped up, but if you spot anything we missed during cleanup, a stray nail or anything else, call me at {{phone}} and we'll come back out.

[optional] {{warranty_note}}

If you're happy with the work, a quick Google review helps a small local company like ours more than you'd think: {{review_link}}

Thanks again,
{{sender_name}}
{{business_name}}
{{phone}}
```

Multi-day installs need care: the email should go out after the final day, not after day one. See the open questions in `spec.md`.

## 5. General appointment

Calendar keyword: `Appointment`. For client appointments that don't fit the types above.

```
Subject: Thanks for your time

Hi {{first_name}},

Thanks for having me out. If any questions come up, just reply to this email or call me at {{phone}}.

Thanks,
{{sender_name}}
{{business_name}}
{{phone}}
```

## Rendered example

The inspection email as a homeowner would see it, with sample values (Linda is made up, and the estimate turnaround is set to three business days from a Monday appointment):

> **From:** Dusty at Sandhill Roofing
> **Subject:** Your roof inspection with Sandhill Roofing
>
> Hi Linda,
>
> Thanks for having me out to look at your roof. I appreciate you making the time.
>
> Here's what happens next: I'll put together your written estimate and have it to you by Thursday, November 20. It'll include photos of what I found, so you can see what I saw up there.
>
> If any questions come up before then, just reply to this email or call me at (555) 010-0199.
>
> Thanks again,
> Dusty
> Sandhill Roofing
> (555) 010-0199

## For Dusty to confirm

- Do these sound like him? Change any wording that doesn't.
- Are these the right appointment types, and what does he actually call them on his calendar?
- What's his realistic estimate turnaround in business days?
- Does he include photos with estimates?
- Does he want the adjuster template at all?
- What's his Google review link, and does he have warranty paperwork to mention?
