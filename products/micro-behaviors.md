# Micro-behaviors: the long list and the first ten

Brainstorm for tiny apps under Kieran Flanagan's micro-behavior method from Marketing Against the Grain: list narrowly defined behaviors inside a niche, keep the ones that are repeated, costly or annoying, pick one, prototype it. The appointment follow-up (`appointment-follow-up/`) is #1.

Started 2026-11-15. Niches: contractors, real estate agents, financial advisers and planners, writers and authors. Each app should work two ways, as a standalone product for strangers and as an add-on for existing Infusionmedia clients.

## The format

Every behavior is written as: *a [specific role] who means to [action] when [trigger], but doesn't because [reason].* If the trigger can't be read from something the person already uses (calendar, inbox, web form, invoicing, a date in a spreadsheet), it isn't a tiny app yet.

## Filters

1. Happens at least weekly for one person, or at least weekly across their client list.
2. Missing it costs money or makes them look disorganized.
3. The trigger lives in data we can read.
4. The output is one thing: an email, a text, a reminder, a short report.
5. Today it's done by memory, a sticky note, or not at all, or it was lost when they left a bigger tool like Thryv.
6. Cris can name three people who'd pay $20–$50 a month for it.

## The review-ask thesis

Cris's thesis: asking for a review gets a higher star rating than waiting for one. The research mostly backs it, with one caveat worth building around.

- An e-retailer study in Management Science (2021) found solicitations made rating distributions more representative of the real customer base. It also found solicited and unsolicited reviews both overstate the average experience compared with private ratings.
- Separate work found customers who post solicited reviews give higher ratings than organic reviewers. PowerReviews data with Northwestern's Spiegel Center put verified-buyer reviews at 4.34 stars against 3.89 for anonymous ones.
- The mechanism is self-selection. Without an ask, the people who bother are the furious and the delighted. Asking brings in the quietly satisfied majority, and they pull the average up.

The design consequence is that the app should ask everyone. Google's review policy bans selectively soliciting positive reviews (“review gating”), and the FTC's Consumer Reviews and Testimonials rule (16 CFR 465, effective 2024-10-21) covers suppressing negative ones. If the thesis is right, gating isn't needed anyway: asking every customer is what raises the average. No “were you happy? if yes, review us” filter step.

Niche-specific rules:

- For financial advisers, a solicited Google review may be a testimonial under the SEC Marketing Rule. Practitioner guidance (Kitces, Wealthtender, Stark & Stark) says to ask all clients, not cherry-pick, carry testimonial disclosures, and run it past compliance. The SEC hasn't formally ruled on solicited Google reviews. Advisers who are also FINRA-registered need their broker-dealer's sign-off too. Build a compliance mode or skip this niche for reviews.
- For authors, Amazon bans paying or trading for reviews and bans reviews from family and close friends. Free advance copies (ARCs) with no requirement of a positive review are the accepted route, so the review ask does apply to authors, as an ARC follow-up.

## Long list

### Contractors

1. A contractor who means to email the homeowner after an appointment, but is in the truck heading to the next one. *(Appointment follow-up, built)*
2. A roofer who means to ask for a Google review when the final invoice is paid, but is on the next roof by then. Trigger: invoice paid (QuickBooks, Xero, Stripe) or the “Install final” calendar event. *(Review ask when the job's paid)*
3. A contractor who means to check in a week after an estimate goes out, but worries about seeming pushy and then forgets. Trigger: “Estimate” calendar event plus N days, skipped if the homeowner already replied. Already listed as “not in v1” in the appointment spec. *(Estimate check-in)*
4. A roofer who means to contact past customers after hail hits their ZIP code, but doesn't have the list handy when it matters. Trigger: a hail report from the NWS Storm Prediction Center matched to customer ZIPs in `contacts`. *(Storm alert to past customers)*
5. An owner who means to get before-and-after photos of every job for marketing, but the crew forgets. Trigger: install event ends, so text the crew lead “send three photos,” which go into a shared folder. These photos feed Infusionmedia's own content work for the client. *(Crew photo request)*
6. A contractor who means to offer a free one-year inspection, but has no record of who's due. Trigger: install date plus 11 months. *(One-year warranty check-in)*
7. A roofer who means to ask the homeowner whether the insurance check arrived, but loses track between the adjuster meeting and the payment. Trigger: adjuster event plus 14 days. *(Insurance check nudge)*
8. A roofer who means to warn customers when rain pushes an install, but they call first to ask. Trigger: rain forecast for a scheduled install date. *(Weather delay notice)*
9. A contractor who means to ask happy customers for referrals a month after the job, but never circles back. Trigger: paid invoice plus 30 days. *(Referral ask)*
10. A contractor who misses calls on the roof and means to call back, but the lead has called the next roofer by then. Needs SMS, so A2P 10DLC registration. The market is crowded. *(Missed-call text-back)*

### Real estate agents

1. An agent who means to send past clients a note on the anniversary of their closing, but has 80 past clients and no system. Trigger: closing date. *(Home anniversary note)*
2. An agent who means to email every open-house visitor that evening, but gets home tired and sends it two days later, if at all. Trigger: the sign-in form. *(Open house follow-up the same night)*
3. The contractor review app, triggered at closing plus seven days, with Zillow and Google links. *(Review ask after closing)*
4. A listing agent who means to send the seller a Friday update with showings and feedback, but only remembers when the seller calls annoyed. Trigger: Friday plus an active listing. The hard part is getting showing data without a ShowingTime integration. *(Weekly seller update)*
5. A listing agent who means to get feedback from every buyer's agent after a showing, but ends up texting them one by one. Trigger: “Showing” calendar event plus a few hours. *(Showing feedback chase)*
6. An agent who means to remind buyers before the option period, appraisal and financing deadlines, but is juggling six contracts. Trigger: dates typed into a form once per contract. *(Contract deadline reminders)*
7. An agent who means to remind new buyers to file their homestead exemption, but forgets once the deal closes. Trigger: closing date plus the state's filing window. Deadlines vary by state. *(Homestead exemption reminder)*
8. An agent who means to ask for referrals once clients have settled in, but moves on to the next deal. *(Referral ask at 90 days)*

### Financial advisers and planners

1. An adviser who means to reach out before clients hit planning ages, but notices only after the window has passed. Trigger: date of birth. The ages: 50 (catch-up contributions), 59½ (penalty-free withdrawals), 60–63 (SECURE 2.0 super catch-up), 65 (Medicare's seven-month enrollment window opens three months before the birthday month), 73 (RMDs for people born 1951–59; 75 for 1960 and later). *(Milestone-age nudges)*
2. An adviser who means to book every client's annual review on schedule, but some slip to 18 months. Trigger: last review date plus 11 months. Email with a booking link. *(Annual review booking)*
3. An adviser who means to send a written recap within a day of a review meeting, but writes it Friday from memory. Trigger: meeting ends and notes exist. Crowded (Jump, Zocks and others do AI meeting notes for advisers). *(Meeting recap with action items)*
4. A planner who means to collect every client's tax return each spring, but is still chasing them in August. Trigger: mid-April, then a weekly reminder until the return is uploaded. *(Tax document chase)*
5. The proposal ladder (`routines/proposal-follow-up-ladder.md`), adapted for advisers. *(Prospect follow-up after an intro meeting)*
6. An adviser who means to review beneficiaries after a marriage, divorce, birth or death, but hears about it secondhand. No clean trigger: it depends on the client saying something. *(Beneficiary review after a life event)*
7. Possible, but only with a compliance mode (see above). *(Review ask)*

### Writers and authors

Author behaviors run on launch cycles, not weekly ones. That fails filter 1 for a monthly subscription but fits a one-time price per launch.

1. An author who sends advance copies to 50 readers and means to remind them to post a review on launch day, but loses track of who got one and who already posted. Trigger: launch date plus the ARC list. Output: reminders on launch week and a tracker of who's posted. *(ARC launch-week reminder)*
2. An author pitching podcasts for a launch who means to follow up after a week, but loses track at 30 pitches. Trigger: the sent pitch email. A clone of the proposal ladder. *(Podcast and guest-post pitch follow-up)*
3. An author who means to thank the bookstore and invite attendees to the newsletter after a reading, but drives home and doesn't. Trigger: “Reading” or “Signing” calendar event. Nearly a copy of the appointment app, but low frequency. *(Event follow-up)*
4. An author who means to send a monthly newsletter, but skips months without noticing. Trigger: days since the last send (Kit or Mailchimp API). Output: a nudge with three ideas pulled from their recent posts. *(Newsletter streak)*
5. An author asking other authors for blurbs on a deadline, who means to follow up politely, but feels awkward and waits too long. *(Blurb request follow-up)*

## First ten

Picked for filter fit, how much of the appointment app they reuse (calendar polling, Resend, the SQLite store, the dashboard), and whether they sell to strangers as well as to existing clients.

| # | App | Niche | Trigger | Reuse | Sells as | Risk |
|---|---|---|---|---|---|---|
| 1 | Appointment follow-up | Contractors | Calendar event ends | Built | Both | Proving it beats Thryv's version |
| 2 | Review ask | Contractors, then agents | Invoice paid or final event | High | Standalone first | Many competitors (Podium, Birdeye, NiceJob), so price and simplicity have to be the pitch |
| 3 | Estimate check-in | Contractors | Estimate event plus N days | High | Both | Needs reply detection so it doesn't nudge after a yes |
| 4 | Storm alert | Roofers | NWS hail report by ZIP | Medium | Both | Storm data accuracy; must stay with past customers, not cold storm-chasing |
| 5 | Crew photo request | Contractors | Install event ends | Medium (needs SMS or a crew email) | Add-on | Crews ignoring it |
| 6 | Home anniversary | Agents | Closing date | High | Standalone | CRMs like Follow Up Boss already do this; the pitch is for agents without one |
| 7 | Open house same-night | Agents | Sign-in form | Medium | Standalone | Seasonal; depends on the agent using our form |
| 8 | Milestone-age nudges | Advisers | Date of birth | Medium | Standalone | Getting DOBs out of their CRM; compliance review of the message copy |
| 9 | ARC launch reminder | Authors | Launch date plus ARC list | Low | One-time price per launch | Low frequency; small market per customer |
| 10 | Weekly seller update | Agents | Friday plus an active listing | Low | Standalone | Showing data is the hard part |

Cut for now: missed-call text-back (crowded, needs SMS), meeting recaps (crowded), beneficiary review (no trigger), annual review booking (adviser CRMs mostly do it).

## Open questions for Cris

- Which of the ten do clients already complain about? Rank by what you've heard, not what sounds good.
- For #2, which of Infusionmedia's clients would be the first five users, and do they invoice through something we can read?
- Do any adviser clients have a compliance officer who'd review a milestone-age or review-ask template?
- For authors, is a one-time launch-kit price workable, or does that niche stay add-on only?

## Sources

- [Solicited vs. organic reviews, Management Science (2021)](https://pubsonline.informs.org/doi/pdf/10.1287/mnsc.2020.3758)
- [Self-motivated vs. prompted reviews, Spiegel Research Center](https://spiegel.medill.northwestern.edu/self-motivated-vs-prompted-reviews)
- [How reviewer self-selection affects star ratings, PowerReviews](https://powerreviews.com/?p=10814)
- [FTC Consumer Reviews and Testimonials final rule](https://www.ftc.gov/system/files/ftc_gov/pdf/r311003consumerreviewstestimonialsfinalrulefrn.pdf)
- [Is review gating allowed on Google?, ReviewTrackers](https://www.reviewtrackers.com/review-gating-google/)
- [SEC Marketing Rule, asking for testimonials, Wealthtender](https://wealthtender.com/advisors/sec-marketing-rule/asking-for-testimonials/)
- [Marketing Rule slides, Kitces (August 2023)](https://kitces.com/wp-content/uploads/2023/08/Slides-Marketing-Rule-Chris-Stanley-Kitces-August-2023.pdf)
