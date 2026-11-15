# Appointment follow-up app

Emails a contractor's customer a set time after an appointment on their Google Calendar ends, thanking them and telling them what happens next. Built for Sandhill Roofing first, multi-client from the start. The spec and email templates are one folder up, in `spec.md` and `templates.md`.

**Status (2026-11-15):** v1 is built and tested against a fake calendar and a fake mailer. It has not yet run against real Google or Resend accounts, so the first deploy should start in dry-run mode.

Storm alerts (spec in `../../storm-alert/spec.md`) are built into the same app and switched on per client. 108 tests cover both. The hail decoder was checked against ECMWF's eccodes on real NOAA files, and a live replay downloaded and read real NOAA data correctly. The Census geocoder and SPC ground reports were written to their published formats but couldn't be reached from the build environment, so watch the first imports and storm days in the logs.

## How it works

- Every 5 minutes, the app reads each connected Google Calendar for events from the last 24 hours and the next 48.
- An event counts as an appointment when its title starts with one of that client's keywords, like “Inspection Smith.” Everything else is ignored and listed under “Not recognized.”
- Each appointment gets a send time: two hours after it ends (adjustable), held until morning if that lands in quiet hours.
- Right before sending, the app reads the event again. If it was deleted, retitled with “cancel” or “no-show,” declined by the homeowner, or moved later, it skips or waits.
- It sends a plain-text email through Resend from the client's own domain, with replies going to the client's inbox. Every send and skip is recorded with a reason.
- The website form posts leads to `/api/leads`. Those contacts are matched to calendar events by email or phone.

Code map: `src/rules.ts` holds the decisions (pure functions, most of the tests), `src/jobs.ts` the polling and sending, `src/store.ts` the database, `src/web/app.ts` the dashboard and public routes, `src/templates.ts` the default emails. Storm alerts live in `src/storm/` (`rules.ts` decisions, `jobs.ts` background work, `grib2.ts` and `png.ts` the NOAA file reader, `sources.ts` the outside data, `store.ts` the tables) and `src/web/storm.ts`.

## Run it locally

```sh
npm install
cp .env.example .env    # fill in at least TOKEN_KEY, ADMIN_USER, ADMIN_PASSWORD, APP_URL=http://localhost:3000
npm run dev             # dashboard at http://localhost:3000
npm test
npm run typecheck
```

Needs Node 22.18 or newer, which runs the TypeScript directly with no build step. SQLite is built into Node.

## One-time setup

### 1. Google Cloud (the calendar connection)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, for example “Infusionmedia Follow-ups.”
2. Under APIs & Services → Library, enable the **Google Calendar API**.
3. Under OAuth consent screen, choose **External**. Fill in the app name, a support email and a privacy policy link. Add these scopes: `openid`, `email`, and `.../auth/calendar.events.readonly`.
4. **Publish the app** (move it from Testing to In production). While an External app is in Testing, Google expires its refresh tokens after 7 days, which would quietly disconnect every client each week. Published but unverified, it works for up to 100 users, and they see an “unverified app” warning when connecting. The connect page tells contractors to expect that.
5. Under Credentials, create an **OAuth client ID** of type “Web application.” Add the authorized redirect URI `https://YOUR-SUBDOMAIN/oauth/google/callback`, matching `APP_URL` exactly.
6. Copy the client ID and secret into `.env`.

### 2. Resend (sending)

1. In Resend, add and verify each client's domain, for example `sandhillroofing.com`. Resend lists the DNS records to add, so do this as part of the site rebuild.
2. Turn **off** open and click tracking for that domain. These should read like a personal note.
3. Create an API key with sending access, and put it in `.env`.
4. Check how many domains your Resend plan allows before adding a second client. Each client sends from their own domain.

### 3. The VPS

1. Point a subdomain, for example `followup.yourdomain.com`, at the VPS.
2. Copy this folder onto the VPS and set it up:

   ```sh
   cd appointment-follow-up/app
   mkdir -p data && sudo chown 1000:1000 data   # the container runs as user 1000
   cp .env.example .env && nano .env            # fill everything in. Leave DRY_RUN=true for now
   docker compose up -d --build
   curl -s http://127.0.0.1:3010/healthz        # should print ok
   ```

3. Point the reverse proxy that already serves Invoice Ninja at it, with HTTPS. Google sign-in requires HTTPS on a real domain. With Caddy:

   ```
   followup.yourdomain.com {
     reverse_proxy 127.0.0.1:3010
   }
   ```

   With nginx, a server block for the subdomain with `proxy_pass http://127.0.0.1:3010;`, `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, plus a certificate from Certbot.

   If Invoice Ninja's proxy runs in Docker (Traefik, or nginx-proxy-manager, for example), attach this service to the proxy's Docker network in `docker-compose.yml`, remove the `ports` line, and point the proxy at `followup:3000`.

4. To update later: replace the files, then `docker compose up -d --build`.

### 4. Backups

The whole app lives in `data/app.db`. Losing it means every client has to reconnect Google. A nightly cron entry on the VPS:

```sh
15 3 * * * cd /path/to/appointment-follow-up/app && rm -f data/backup.db && docker compose exec -T followup node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('data/app.db').exec(\"VACUUM INTO 'data/backup.db'\")" && cp data/backup.db /path/to/offsite-sync/followup-$(date +\%F).db
```

Copy `/path/to/offsite-sync` off the server with whatever you already use (rclone, or the host's backup service). Keep a copy of `.env` somewhere safe too. Without `TOKEN_KEY`, the backup's Google tokens can't be read.

## Onboarding a client

1. **Add the client** in the dashboard and fill in Settings: sender name, phone, from address (on their verified domain), reply-to, time zone, estimate turnaround, review link, keywords, and their own email addresses.
2. **Turn on shadow mode:** set the shadow address to your own inbox.
3. **Send the connect link** from the client page. The contractor opens it, signs in with the Google account that holds their appointments, and approves read-only calendar access. The link works once, then changes, so check that the account shown on the client page is really theirs.
4. **Watch for a week** with `DRY_RUN=true`. Check that “Upcoming” shows their real appointments with the right homeowner and send times, and that “Not recognized” doesn't hide real appointments. Open any appointment to preview its email.
5. **Go live for real, still to you:** set `DRY_RUN=false` in `.env` and run `docker compose up -d`. With shadow mode still on, every email lands in your inbox, marked with who it would have gone to.
6. **Go live for homeowners:** clear the shadow address and set a BCC address for the first two weeks.

`DRY_RUN` covers every client at once. Shadow mode covers one client, so a new client can start in shadow mode while existing clients keep sending.

## What the contractor needs to do on their calendar

- **Start each appointment's title with its type:** “Inspection Smith,” “Estimate Jones,” “Adjuster 123 Oak,” “Repair Lee,” “Install Garcia final.” The keywords can match whatever words they already use.
- **Put the homeowner's email on the event.** Either add them as a guest (Google asks whether to send an invitation; “Don't send” is fine) or type it in the description. A `Name: Linda` line in the description sets the greeting. Leads from the website form are matched automatically by email or phone.
- **To stop a follow-up,** delete the event or add “cancel” or “no-show” to the title before the send time.
- **For multi-day installs,** add “final” to the last day's title. One long event spanning the whole job works too.

## Website form

Post from the client's site to `/api/leads` with the client's key (shown on the client page) in an `X-Api-Key` header or an `api_key` field:

```html
<form method="post" action="https://followup.yourdomain.com/api/leads">
  <input type="hidden" name="api_key" value="CLIENT_LEAD_KEY">
  <input type="hidden" name="redirect" value="https://sandhillroofing.com/thanks">
  <input name="first_name" required> <input name="last_name" required>
  <input name="email" type="email" required> <input name="phone" type="tel" required>
  <input name="street" required> <input name="city" required> <input name="state" required> <input name="zip" required>
  <select name="service" required>
    <option>Inspection</option><option>Repair</option><option>Replacement</option>
    <option>Storm or insurance damage</option><option>Other</option>
  </select>
  <select name="insurance_claim"><option value="">Insurance claim?</option><option>yes</option><option>no</option><option>not sure</option></select>
  <textarea name="notes"></textarea>
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button>Request an inspection</button>
</form>
```

The hidden `website` field catches bots. The `redirect` must start with the client's website origin from Settings. JSON posts get a JSON reply instead. The key only allows adding leads, and submissions are rate-limited.

## Storm alerts

The morning after hail, the contractor gets one email: “Hail hit 4 of your customers on Tuesday,” with a link. He opens it on his phone, unticks anyone he doesn't want to contact, and presses Send. Each homeowner gets a short plain-text note from him offering to check the roof. Nothing goes out without that press.

### How it works

- **Customers.** Only contacts marked as customers are checked. Import past customers as CSV from the client page (“Import customers”), or mark contacts as customers on the contacts page. Columns: `first_name, last_name, email, phone, street, city, state, zip, job_date`. Common export headers like “Address” and “Zip Code” work too.
- **Locating.** Each customer's address is looked up once with the free US Census geocoder, about 25 every 10 minutes. Addresses it can't find are listed on the client page. Changing an address looks it up again.
- **The morning check.** After NOAA posts the day's file (12:20 UTC), the app downloads NOAA's radar hail estimate (MRMS MESH, the 24 hours ending 12:00 UTC) from NOAA's public bucket on AWS. That's one file for every client. It reads the largest estimate within about 1 km of each customer. A customer at or above the client's threshold (default 1″) is a hit. Nearby SPC ground reports are attached as corroboration.
- **Who's left out.** Unsubscribed customers, anyone who got a storm alert from this contractor in the last 30 days, and a second person at the same address or email.
- **Review.** The summary email goes to the storm summary address (or reply-to). The review link works without a login, so treat it like a password. It expires after 72 hours, because week-old storm notes read as opportunistic.
- **Sending.** Approved emails go out between the client's storm send hours (default 9:00 AM to 6:00 PM local). Every email gets a footer with the business postal address and an unsubscribe link, plus one-click unsubscribe headers. The footer can't be edited out, because storm alerts are marketing and CAN-SPAM requires both. Shadow mode, BCC and `DRY_RUN` work the same as for follow-ups.
- **Wording.** “Storm alert email” and “Storm alert postcard” are editable templates. Placeholders: `{{first_name}}`, `{{street}}`, `{{storm_day}}` (“Tuesday”), `{{storm_date}}` (“Tuesday, May 12”, for postcards that arrive days later), `{{sender_name}}`, `{{business_name}}` and `{{phone}}`. Keep to the copy rules in the spec: no deductibles, no insurance promises, no public-adjuster claims, no urgency, and no hail size.

### Postcards through Smartpress

Smartpress has no public API, so the hand-off is a mailing list file:

1. With postcards on in Settings, the review page offers “Also mail each one a postcard” with an estimated cost. Customers without an email only get something this way.
2. When the contractor ticks it, the app creates a postcard batch and emails the postcard order address a link to it.
3. The batch page has the Smartpress mailing list as CSV: `FirstName, LastName, Address1, City, State, Zip, Headline, Message, Street, StormDate`. `Message` is each card's whole back, personalized from the postcard template, so the art needs one variable text box under the headline. Art with its own fixed wording can merge `FirstName`, `Street` and `StormDate` instead.
4. Reorder the client's storm postcard on Smartpress with variable data addressing, upload the CSV as the mailing list, approve the proof, and mark the batch ordered with the Smartpress order number.

Before the first batch, set up the client's 4×6 storm postcard on Smartpress once, with the variable text box for `Message`, and save it for reorders.

### Past storms report

“Run report” on the client page replays NOAA's archive (back to late 2020) against the client's located customers: which storm days hit which customers, at the client's threshold. A year takes a few minutes and runs in the background. It's the sales demo (“hail hit 112 of your customers on 9 days last year”) and the first test with a new client's real list.

### Turning it on for a client

1. Import their past customers and wait for them to be located. Check the “Couldn't locate” list.
2. Run a 12-month report and go over it with the contractor. Do the storm days match storms he remembers?
3. In Settings, fill in the business postal address and the storm summary address, set the threshold, and set the shadow address to your inbox. Then tick “Check customers' addresses for hail every morning.”
4. Through the first storms, everything goes to the shadow address. Clear it when the hits look right.

The server must be able to reach `noaa-mrms-pds.s3.amazonaws.com`, `www.spc.noaa.gov` and `geocoding.geo.census.gov`, plus Resend.

## Not built yet

- A login for contractors. The dashboard is agency-only for now.
- Text messages, multi-step sequences, the CRM screens and pipeline beyond the contacts list (see the CRM path in `spec.md`).
- Choosing a calendar other than the account's main one.
- Google's app verification, needed past 100 connected users or to remove the warning screen.
- Storm alerts: automatic Smartpress ordering (no public API found; ask Smartpress), neighborhood postcards (phase 2), wind damage, text messages, and self-serve signup for roofers who aren't clients.
