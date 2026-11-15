# Storm alert: app spec

The morning after hail, a roofer gets one email: “Hail hit 43 of your past customers last night.” One click sends each of those homeowners a short, personal note offering to check their roof. It's built first as an add-on to the appointment follow-up app for Dusty at Sandhill Roofing, then sold on its own to roofers who aren't Infusionmedia clients.

Drafted 2026-11-15. Comes from `../micro-behaviors.md` (#4 in the first ten).

**Status (2026-11-15):** v1 is built into the appointment follow-up app, including postcards through Smartpress. Setup and operating notes are in `../appointment-follow-up/app/README.md` under “Storm alerts.” Where the build differs from the first draft of this spec, the sections below have been updated.

## The behavior

A roofer who means to contact past customers after hail hits their neighborhood, but doesn't have the list handy when it matters, and by the time he thinks of it the storm chasers have knocked on every door.

Past customers are the cheapest jobs a roofer will ever win. They already trust him, he already has their email, and a hail claim is often a full replacement. What he lacks is knowing, the next morning, exactly which of his customers were under the hail.

## What already exists

There's a real competitor, so the pitch has to be specific.

| Product | What it does for past customers | Price (third-party figures, unverified) |
|---|---|---|
| HailWATCH / HailMONITOR | Watches the roofer's address list and sends him a list of addresses that hail hit | Reported from $25 a month, $65–$119 for HailWATCH |
| HailTrace | Hail maps plus past-customer prospecting from CRM and historical data | Reported around $94 a month, otherwise quote-based |
| Interactive Hail Maps | Real-time hail alerts and storm tracking, mostly for canvassing | Not found |
| AccuLynx, JobNimbus and similar | Full roofing CRMs, some with hail map integrations | Hundreds a month |

These tools tell the roofer who got hit. The micro-behavior is *contacting* them, and that step is still manual: export the list, write an email, mail-merge it, hope it doesn't land in spam. Storm alert closes that loop. It sends the note from the roofer's own name, to his own customers, the morning after. v1 skips canvassing maps, door-knocking routes and new-lead prospecting, which is where the competitors spend their effort. Neighborhood mail comes later as a separate product (see “Channels”).

## What v1 does

Every morning the app checks overnight radar hail estimates against the address of every past customer. If any were hit at or above the client's threshold, it emails the contractor a summary with a review link. He opens it on his phone, removes anyone he wants, and presses Send. The link works without a login, because the dashboard is agency-only, and it expires with the storm day. Each homeowner gets one plain-text email from the contractor, with replies going to his inbox. If postcards are on, the same screen offers a postcard for each customer.

v1 asks before sending. The appointment follow-up sends by default because one wrong email costs little. A storm alert goes to dozens of homeowners at once, and the radar estimate can be wrong. One bad batch would teach the contractor to distrust it. Auto-send becomes a setting after a season of clean runs.

### Not in v1

- Wind damage. Radar-based wind estimates are much weaker than hail estimates, and wind reports are sparse.
- Text messages (A2P 10DLC registration, same reason as the appointment app)
- Postcards to whole neighborhoods. Phase 2, possibly with Andy (see “Channels”).
- Cold email to neighborhoods. Not planned (see “Channels”).
- Leads who never became customers. A setting for open estimates may come later.
- Canvassing maps
- Self-serve signup and billing. The first strangers are onboarded by hand (see “Standalone version”).

## Where the hail data comes from

All free, all public, no API keys.

### Radar: NOAA MRMS MESH

MESH (Maximum Estimated Size of Hail) is a radar-derived grid from NOAA's Multi-Radar Multi-Sensor system. It's the same family of data the commercial hail-map vendors build on.

- NOAA publishes it on AWS Open Data in the `noaa-mrms-pds` bucket: `CONUS/MESH_Max_1440min_00.50/YYYYMMDD/MRMS_MESH_Max_1440min_00.50_YYYYMMDD-HHMMSS.grib2.gz`. Each file holds the largest estimate for every grid cell over the previous 24 hours.
- New files arrive every 30 minutes. Shorter windows also exist (30, 60, 120, 240 and 360 minutes).
- The archive goes back to at least October 2020. That's checked as far back as 2020-10-15.
- Checked on 2026-11-15 against the file for 12:00 UTC on 2025-04-11: a regular 0.01° latitude-longitude grid (7,000 × 3,500 cells, about 1.1 km per cell) covering the continental US from 20° to 55° N, values in millimeters, about 375 KB uncompressed. Zero or negative values mean no hail or no data.
- In that file, 942 cells nationwide were at 1″ or more. A connected swath in south Texas peaked at 7.7″. Values that large are physically possible and also exactly where MESH tends to run high. NWS training material says MESH also *underestimates* in some storm types (highly tilted storms in strong shear, left-moving supercells). It's an estimate, not a measurement, so the contractor sees a size band, and a person approves every batch.

### Ground reports: NWS Storm Prediction Center

SPC publishes daily storm reports as CSV, with filtered and unfiltered versions, for 12:00 UTC to 11:59 UTC the next day. Columns are time, size in hundredths of an inch, location, county, state, latitude, longitude and comments. They're spotter and public reports, so they're accurate where they exist but sparse.

v1 uses them as corroboration, not a trigger. The contractor's alert says, for example, “Two ground reports of 1.25″ hail within 5 miles.” A radar hit with a nearby ground report is the strongest case.

The cloud session that wrote this spec couldn't reach `www.spc.noaa.gov`. Confirm the CSV file names from a daily report page before building.

### Addresses: US Census Geocoder

Contacts have street, city, state and ZIP but no coordinates. The Census Bureau's free geocoder converts US addresses to latitude and longitude, one at a time or in batches. Every contact is geocoded once on import or creation and again when the address changes. Addresses that don't match go on a “couldn't locate” list in the dashboard. ZIP-code centroids are no use here, because a ZIP is far wider than a hail swath.

## How it works

1. **Locate.** Geocode every contact marked as a customer and store its latitude, longitude and match quality.
2. **Fetch.** Once a day, after the 12:00 UTC MESH file posts (about 7:00–8:00 AM Central), download that file. One file serves every client.
3. **Check.** For each located customer, read the largest MESH value in the 3 × 3 cells around the address (about 1 km each way). The neighborhood allows for geocoding error and the grid's coarseness.
4. **Decide.** A customer is a hit when that value is at or above the client's threshold. The default is 1″, roughly quarter-size and the usual rule of thumb for possible asphalt shingle damage. Confirm with Dusty.
5. **Corroborate.** Attach SPC hail reports within 10 miles of each hit.
6. **Alert the contractor.** If there's at least one hit, create a storm day, email the contractor a summary and show it in the dashboard.
7. **Review and send.** The contractor removes anyone he wants and presses Send. Emails go out at once if it's between 9:00 AM and 6:00 PM in his time zone, otherwise at 9:00 the next morning. An unreviewed storm day expires after 72 hours, because a week-old storm note reads as opportunistic.
8. **Record.** Every hit, skip, send and failure is logged with a reason, as in the appointment app.

## Rules

### Who gets an email

A contact is included when all of these are true:

- they're marked as a customer (a past job), not only a lead
- they have an email address
- their address geocoded with a reliable match
- they haven't unsubscribed
- they haven't had a storm alert from this contractor in the last 30 days, so a week of repeated storms produces one email
- the contractor didn't remove them from this batch

A contractor with two customers at the same address (a couple, say) sends one email to the first listed.

### What the contractor sees

The summary email and the dashboard both show, for each storm day: the count of customers hit, a list with name, street, size band and any nearby ground reports, the largest estimate, and a link to review and send.

Size bands use the NWS hail-size names, as radar estimates: “about 1″ (quarter),” “about 1.75″ (golf ball).” Values above 4″ show as “4″ or larger (radar estimate, check ground reports).”

### What the homeowner email says

Plain text, short, from the contractor by name, no tracking. The homeowner version doesn't quote a hail size, because a radar estimate printed to a homeowner reads as a claim about their roof.

> **Subject:** Hail near your home on Tuesday
>
> Hi {first_name},
>
> Weather radar showed hail passing near {street} on Tuesday night. Hail can damage shingles without leaving anything you'd notice from the ground.
>
> If you'd like us to take a look, reply to this email or call {phone} and we'll set up a time. There's no charge to check.
>
> {sender_name}
> {business_name}
>
> {business_address} · Don't want storm alerts? {unsubscribe_link}

Copy rules, enforced in the template editor's guidance and in review:

- No mention of deductibles. Texas, Colorado and Oklahoma (at least) prohibit roofers from waiving or rebating them, and the topic invites trouble anywhere.
- No promises about insurance (“your insurance will pay for a new roof”).
- Never imply the contractor acts as a public adjuster. Colorado law bars contractors who solicit roofing work from claiming to be one.
- No urgency or fear (“act now before it leaks”).
- Confirm that a no-charge inspection offer is fine under Dusty's state rules, as with the insurance template in the appointment app.

### Commercial email rules

The appointment follow-up is a transactional message about a job the homeowner booked. A storm alert is marketing, so CAN-SPAM applies: an honest subject line, the business's physical postal address, and a working unsubscribe link honored within 10 business days. The app honors it immediately. Each email gets a one-click unsubscribe link and a `List-Unsubscribe` header.

CAN-SPAM also expects commercial email to say clearly that it's an advertisement, unless the recipient gave affirmative consent. The website form's consent line should cover storm alerts (“We'll email you about your appointment and occasional storm alerts”). For older customers imported from a list, check with whoever handles Infusionmedia's legal questions whether the past business relationship plus a clear unsubscribe is enough, or whether the footer needs an ad disclosure.

## Channels

Andy (a developer Infusionmedia works with, maker of SuccessHD, with a background in neighborhood-level targeting for political campaign mail) has pitched this idea before in three forms: postcards or email alerts to existing customers, and cold email alerts to whole neighborhoods. Here's how those fit, from easiest to hardest.

| Channel | Who | Speed after the storm | Cost per piece | Status |
|---|---|---|---|---|
| Email | Past customers with an email on file | Next morning | Close to zero (Resend) | v1 |
| Addressed postcard | Past customers, including those with no email | About a week (proof, print and mailing through Smartpress) | Smartpress pricing to be confirmed. API printers like Lob list roughly $0.62–$0.91 for a 4×6 First Class card, print and postage included, which is a useful ceiling. | v1, through Smartpress |
| Neighborhood postcard | Every home in the hail swath, customer or not | 1–2 weeks (print, then a drop at the post office or a mail house) | USPS Every Door Direct Mail (EDDM) retail postage is $0.260 a piece as of 2026-07-12 per vendor guides citing USPS Notice 123, plus printing. Full-service quotes run about $0.50–$1.00 a piece. | Phase 2, a separate product, possibly with Andy |
| Cold email | Every home in the swath | Next morning, in theory | Purchased email data | Not planned |

Mail prices come from vendor and third-party pages that disagree, so check Smartpress's and USPS's live rates before pricing anything. The app's cost-per-card setting (default $0.85) is a placeholder until then.

### Postcards to past customers (v1, through Smartpress)

This is the easy one, as Andy said. The addresses are already in the app, mail doesn't fall under CAN-SPAM, there's no unsubscribe or deliverability to manage, and it reaches older customers who never gave an email address. It's slower than email but it lasts. A card on the fridge a week after the storm, following the email, is a good second touch.

Infusionmedia already prints through Smartpress, so v1 uses it rather than an API printer. Smartpress has no public API that we could find. Its direct mail workflow is to upload the art and a mailing list (CSV, each field in its own column) at checkout, after which it prints, addresses each piece from the list and mails it. So the hand-off is a file and one manual upload per storm:

- The review screen has a second checkbox: “Also mail each one a postcard,” with the estimated total. Customers with no email only get something this way.
- Approving creates a postcard batch and emails Infusionmedia (the postcard order address) a link to it.
- The batch page downloads a Smartpress mailing list: `FirstName, LastName, Address1, City, State, Zip, Headline, Message, Street, StormDate`.
- The wording is standardized in one editable “Storm alert postcard” template with the same placeholders as the email (`{{first_name}}`, `{{street}}`, `{{storm_date}}`, `{{phone}}` and so on). The app renders each card's whole back into `Message`, so the art needs one variable text box under the headline, and the copy rules are enforced in one place. Art that keeps its own fixed wording can merge `FirstName`, `Street` and `StormDate` instead.
- Someone reorders the client's saved 4×6 storm postcard on Smartpress, uploads the CSV, approves the proof, and marks the batch ordered with the Smartpress order number.
- Mail is a real per-storm cost (43 customers at about $0.85 is roughly $37), so it's billed to the contractor as a pass-through with a markup.

If Smartpress turns out to have a partner API or a “reorder with a new list” shortcut, the batch page is where it would plug in.

### Neighborhood postcards (phase 2)

This is a different behavior, and Kieran's method says to keep them apart. Contacting past customers is retention: cheap, warm and fast. Mailing a whole swath is lead generation from strangers, with a budget in the thousands. A swath covering ten carrier routes could be 5,000 pieces, or $2,500–$5,000 at full-service rates. It's still worth building, and it's exactly Andy's expertise.

- The trigger is the same daily MESH check. The app already has the swath, because it's just the grid cells above the threshold. Phase 2 turns those cells into a polygon and picks the USPS carrier routes that fall inside it.
- EDDM needs no names or address list. It goes to every address on each chosen route, with a 200-piece minimum, and retail drops are capped at 5,000 pieces per ZIP code per day.
- The contractor approves a budget, not a list.
- The copy rules above apply, and they matter more here: mail to strangers after a storm is what regulators picture when they write storm-chaser laws. Check the contractor's state rules for post-storm solicitation before the first drop.

The natural split is that storm alert supplies the trigger and the swath, and Andy's system handles route selection, print and mail. That depends on what SuccessHD actually does (see open questions).

### Cold email to neighborhoods (not planned)

Not planned, for three reasons:

- There's no list. It would mean buying emails appended to the swath's street addresses from a data broker.
- Resend's acceptable use policy prohibits unsolicited messages, including cold outreach and purchased or scraped lists. Other reputable sending services take the same position, and breaking it gets the account suspended. That account also carries every client's appointment follow-ups.
- Cold blasts would burn the contractor's own domain, which his appointment and storm emails depend on.

CAN-SPAM doesn't ban cold commercial email outright, but it's the sending services and inbox providers that make this unworkable. If neighborhoods are the goal, postcards do it legally and reliably.

## Fit with the appointment follow-up app

Storm alert is a module in the same codebase and the same container, switched on per client. That's what lets one build serve Dusty as an add-on and strangers as a standalone product.

| Piece | Shared with the appointment app | New for storm alert |
|---|---|---|
| Clients and settings | Yes. Adds a storm-alert switch, threshold, send window and business postal address | |
| Contacts | Yes. The same records Dusty's website form and follow-ups already create | Customer flag, job date, coordinates, geocode status |
| Sending | Resend, verified sender, reply-to, retries | Unsubscribe link and header |
| Scheduler | The same in-process job runner | A daily MESH job and a geocoding job |
| Dashboard | Same admin | Storm days, review and send, couldn't-locate list, customer import |
| Google Calendar | Appointment app only | Not needed. A storm-only client never connects Google. |

### Data

Added to `contacts`: `is_customer`, `job_date`, `storm_opt_out`, `lat`, `lon`, `geocode_status`, `geocode_note`, `geocoded_at`.

New tables:

- `storm_runs`: one row per storm date checked, since one MESH file serves every client
- `storm_days`: client, storm date (the 12:00 UTC to 12:00 UTC day, matching SPC), MESH file key, largest estimate, status (`pending_review`, `approved`, `dismissed`, `expired`), review token, whether postcards were ordered, reviewed and notified times
- `storm_hits`: storm day, contact, a copy of the name and address, MESH estimate in millimeters, nearest ground report and its distance, review status (`pending`, `skipped`, `removed`, `approved`) with a reason, email status (`queued`, `sent`, `failed`) with retries, postcard batch, unsubscribe token
- `postcard_batches`: client, storm day, piece count, status (`needs_order`, `ordered`, `cancelled`), Smartpress order number
- `unsubscribes`: client, email, time, source
- `storm_reports`: queued and finished replays for the past-storms report, saved as they progress

`sends` currently requires an appointment. Make `appointment_id` nullable and add `storm_hit_id`, so every outgoing email stays in one history.

Raw MESH grids aren't stored. Only the values at customer addresses are, with the file key, so any hit can be rechecked against the source.

### Decoding

MRMS files use PNG packing (GRIB2 template 5.41), which turned out to be simple enough to read directly. The app has a small TypeScript GRIB2 and PNG reader (`src/storm/grib2.ts`, `src/storm/png.ts`), so the container stays Node-only with no Python. It was checked cell by cell against ECMWF's eccodes on two real NOAA files and matched exactly. A full day downloads and decodes in under a second and takes about 50 MB of memory while it's held.

### Network

The server needs to reach `noaa-mrms-pds.s3.amazonaws.com`, `www.spc.noaa.gov` and `geocoding.geo.census.gov`, plus Resend as before.

## Importing past customers

Dusty's past jobs aren't in the app yet. The `contacts` table only fills from the new website form and from appointments. v1 needs a CSV import with first name, last name, email, phone, street, city, state, ZIP and job date (optional). Rows match existing contacts by email or phone and are marked as customers.

Sources for Dusty: a customer export from Thryv, if he can still get one, or his invoicing records. For strangers, whatever their CRM or QuickBooks exports.

## The demo that sells it

The archive goes back to 2020, so the app can answer “how many of your customers did hail hit in the last 12 months?” before anyone pays. Upload a customer list and get a count, a list of storm days and the customers on each. For Dusty, it's also the test: replay last season against his list and see whether the hits match storms he remembers.

The same report is the standalone product's sales pitch: “Last year, hail hit 112 of your past customers on 9 different days. Did you reach out to them?”

## Standalone version

The same app, with storm alert on and calendar features off.

- Onboard the first five to ten by hand: import their list, set up sending, run the 12-month report, and take payment by a Stripe payment link. Build self-serve signup only after that works.
- Sending from the roofer's own domain is the best option and the hardest ask for a stranger, since it means DNS records. Offer a shared sending domain with the roofer's name in the from field and his inbox as reply-to (for example, “Mike at Ridgeline Roofing” from a shared alerts address). Shared-domain reputation suffers if one customer's list draws spam complaints, so cap batch sizes and watch complaint rates.
- Price: HailWATCH reportedly charges $25–$119 a month for a list. A note that goes out by itself, plus the 12-month report, supports one plan around $49 a month. To be decided after the first five.
- For Infusionmedia clients, fold it into the upkeep fee or add a small monthly charge.

## Testing and launch

1. **Replay.** Run last season's MESH files against a test list built from addresses under known 2025 storms. Check hits against SPC ground reports.
2. **Dusty, replay.** Import his customer list and run the 12-month report. Does he recognize the storm days?
3. **Dusty, shadow mode.** For a few weeks of the 2027 hail season, send the contractor summary to Infusionmedia only. Check every hit before anything reaches him.
4. **Dusty, live.** Summaries go to him, and homeowner emails go out on his approval, with Infusionmedia BCC'd for the first few storm days.
5. **First strangers,** after Dusty has had at least one real storm go out clean.

Hail season in the southern and central Plains peaks in spring and early summer, so build over the winter and run the replay tests before March.

## Open questions

For Dusty:

- Where do his past customers live today? Can he still export them from Thryv?
- What hail size makes him want to check a roof? Is 1″ right for the shingles in his area?
- Does he already contact customers after storms, and how?
- Is a no-charge inspection offer what he'd say, and does his state allow it in a mailed or emailed offer?

For Cris:

- What does SuccessHD do today: targeting only, or print and mail fulfillment too? Does it already work with carrier routes or EDDM?
- Is Andy a partner on phase 2 (he does neighborhood mail, we supply the trigger and swath), or is he building his own storm product? Talk to him before pricing the standalone version, since a competing product changes the plan.
- Is a shared sending domain acceptable for standalone customers, or should every customer verify their own domain?
- Who answers the CAN-SPAM consent question for imported past customers?

For Smartpress:

- Is there a partner API, or a way to reorder a saved postcard with a new mailing list without going through checkout each time?
- What's the minimum quantity and price for a mailed 4×6 postcard with variable data, and the usual turnaround from upload to mail?
- Can a variable text box take a multi-line `Message` field, or does the art need separate merge fields?

## Sources

- [NOAA MRMS on AWS Open Data (bucket listing)](https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=CONUS/&delimiter=/)
- [Operational MRMS GRIB2 tables, NSSL](https://nssl.noaa.gov/projects/mrms/operational/tables.php)
- [Maximum Estimated Size of Hail, NWS Warning Decision Training Division](https://vlab.noaa.gov/web/wdtd/-/maximum-estimated-size-of-hail-mes-2)
- [SPC storm reports](https://spc.noaa.gov/climo/reports/index.html)
- [Hail tracking for roofers, Roofing Contractor (HailWATCH and HailMONITOR)](https://www.roofingcontractor.com/articles/87631-hailmonitor)
- [Making hail apps work for insurance restoration contractors, AccuLynx](https://acculynx.com/making-hail-apps-work-better-for-insurance-restoration-contractors/)
- [Roofing software comparison, AskWonder](https://askwonder.com/research/roofing-software-us-ccyihftq3)
- [Colorado C.R.S. 6-22-105, deductible waivers](https://colorado.public.law/statutes/crs_6-22-105)
- [Texas deductible-waiver ban, Insurance Journal](https://www.insurancejournal.com/news/southcentral/2019/10/30/547048.htm)
- [Oklahoma deductible-waiver ban, Roofing Contractor](https://www.roofingcontractor.com/articles/97659-new-oklahoma-law-restricts-roofing-contractors-from-waiving-deductibles)
- [Lob pricing details](https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details)
- [PostGrid print and mail pricing](https://www.postgrid.com/pricing-print-mail/)
- [EDDM pricing in 2026, 4over4](https://v2.4over4.com/guide/eddm-pricing-explained)
- [EDDM postage rates, MailPro](https://www.mailpro.org/post/eddm-postage-rates/)
- [Resend acceptable use policy](https://resend.com/legal/acceptable-use)
