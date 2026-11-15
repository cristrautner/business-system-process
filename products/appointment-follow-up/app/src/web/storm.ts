// Storm alert pages: the contractor's review link and the homeowner's unsubscribe link (public),
// plus the agency's import, storm day, postcard batch and report pages (behind the login).

import type { Hono } from "hono";
import { html } from "hono/html";
import { phoneDigits } from "../rules.ts";
import { stormReadinessProblems } from "../settings.ts";
import type { Client } from "../store.ts";
import { parseCustomerCsv } from "../storm/csv.ts";
import { hitLine, notifyPostcardBatch, postcardCsv, renderPostcard, renderStormEmail, reportSummary, reviewUrl } from "../storm/jobs.ts";
import { latestStormDate, nextSendTime, sizeBand, stormDateLong } from "../storm/rules.ts";
import type { StormDay, StormHit } from "../storm/store.ts";
import type { WebDeps } from "./app.ts";
import { page, publicPage, when, type Html } from "./html.ts";

export const STORM_PUBLIC_PREFIXES = ["/storm/", "/u/"];

/** "18:00" as "6:00 PM". */
const clock12 = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const ids = (value: unknown): Set<number> => {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return new Set(list.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0));
};

function reportCell(hit: StormHit): Html {
  return hit.reportSize && hit.reportLocation
    ? html`${hit.reportSize.toFixed(2)}″, ${hit.reportMiles} mi<br /><span class="muted">${hit.reportLocation}</span>`
    : html`<span class="muted">none nearby</span>`;
}

function emailCell(hit: StormHit): Html {
  if (!hit.email) return html`<span class="muted">no email</span>`;
  if (!hit.emailStatus) return html`${hit.email}`;
  const cls = hit.emailStatus === "sent" ? "ok" : hit.emailStatus === "failed" ? "bad" : "muted";
  return html`${hit.email}<br /><span class="${cls}">${hit.emailStatus}</span>${hit.emailReason ? html` <span class="muted">(${hit.emailReason})</span>` : ""}`;
}

export function registerStormRoutes(app: Hono, deps: WebDeps): void {
  const { store, now } = deps;

  // The contractor's review page, from the link in the morning summary.

  app.get("/storm/:token", (c) => {
    const day = store.storm.stormDayByToken(c.req.param("token"));
    const client = day ? store.client(day.clientId) : undefined;
    if (!day || !client) return c.html(publicPage("Link not found", html`<p>This storm alert link isn't valid. Check the latest summary email.</p>`), 404);
    return c.html(publicPage(`Hail on ${stormDateLong(day.stormDate)}`, reviewPage(deps, client, day)));
  });

  app.post("/storm/:token", async (c) => {
    const day = store.storm.stormDayByToken(c.req.param("token"));
    const client = day ? store.client(day.clientId) : undefined;
    if (!day || !client) return c.html(publicPage("Link not found", html`<p>This storm alert link isn't valid.</p>`), 404);
    const back = `/storm/${day.reviewToken}`;
    if (day.status !== "pending_review" || day.expiresAt <= now()) return c.redirect(back, 303);
    const body = await c.req.parseBody({ all: true });
    if (body.action === "dismiss") {
      store.storm.dismiss(day.id, now());
      deps.log(`storm day ${day.id} dismissed by ${client.slug}`);
      return c.redirect(back, 303);
    }
    const postcards = client.settings.postcardsEnabled && body.postcards === "on";
    const result = store.storm.approve(day.id, ids(body.hit), nextSendTime(now(), client.settings), postcards, now());
    deps.log(`storm day ${day.id} approved by ${client.slug}: ${result.emails} emails${result.batch ? `, ${result.batch.pieceCount} postcards` : ""}`);
    if (result.batch) {
      await notifyPostcardBatch(deps, client, result.batch).catch((error) =>
        deps.log(`postcard order notice for batch ${result.batch!.id} failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return c.redirect(back, 303);
  });

  // Unsubscribe, from the footer of every storm email. POST also covers one-click unsubscribe (RFC 8058).

  app.get("/u/:token", (c) => {
    const hit = store.storm.hitByUnsubToken(c.req.param("token"));
    const client = hit ? store.client(hit.clientId) : undefined;
    if (!hit || !client || !hit.email) return c.html(publicPage("Link not found", html`<p>This unsubscribe link isn't valid.</p>`), 404);
    if (store.storm.isUnsubscribed(client.id, hit.email)) {
      return c.html(publicPage("You're unsubscribed", html`<p>${client.name} won't send storm alerts to ${hit.email}.</p>`));
    }
    return c.html(
      publicPage(
        "Stop storm alerts?",
        html`<p>${client.name} will stop sending storm alerts to <strong>${hit.email}</strong>.</p>
          <form method="post" action="/u/${hit.unsubToken}"><button>Unsubscribe</button></form>`,
      ),
    );
  });

  app.post("/u/:token", (c) => {
    const hit = store.storm.hitByUnsubToken(c.req.param("token"));
    const client = hit ? store.client(hit.clientId) : undefined;
    if (!hit || !client || !hit.email) return c.text("Not found", 404);
    store.storm.unsubscribe(client.id, hit.email, "link", now());
    deps.log(`${hit.email} unsubscribed from ${client.slug} storm alerts`);
    return c.html(publicPage("You're unsubscribed", html`<p>${client.name} won't send storm alerts to ${hit.email}.</p>`));
  });

  // Agency pages

  const clientFrom = (id: string) => store.client(Number(id));

  app.get("/clients/:id/import", (c) => {
    const client = clientFrom(c.req.param("id"));
    if (!client) return c.notFound();
    return c.html(page(`${client.name}: import customers`, importPage(client)));
  });

  app.post("/clients/:id/import", async (c) => {
    const client = clientFrom(c.req.param("id"));
    if (!client) return c.notFound();
    const body = await c.req.parseBody();
    const file = body.file;
    const text = file instanceof File && file.size > 0 ? await file.text() : typeof body.csv === "string" ? body.csv : "";
    const { customers, errors } = parseCustomerCsv(text);
    const result = customers.length
      ? store.importCustomers(client.id, customers.map((cu) => ({ ...cu, phoneDigits: cu.phone ? phoneDigits(cu.phone) : "" })), now())
      : { added: 0, updated: 0 };
    deps.log(`imported customers for ${client.slug}: ${result.added} added, ${result.updated} updated, ${errors.length} rows with problems`);
    return c.html(
      page(
        `${client.name}: import customers`,
        html`<section>
            <p class="${customers.length ? "ok" : "warn"}">Added ${result.added} and updated ${result.updated} customers.
              ${customers.length ? "They'll be located on the map over the next few minutes." : ""}</p>
            ${errors.length
              ? html`<p class="warn">${errors.length} ${errors.length === 1 ? "row was" : "rows were"} skipped:</p>
                  <ul>${errors.slice(0, 50).map((e) => html`<li>${e}</li>`)}</ul>`
              : ""}
          </section>
          ${importPage(client)}`,
      ),
    );
  });

  app.post("/contacts/:id/customer", async (c) => {
    const contact = store.contact(Number(c.req.param("id")));
    if (!contact) return c.notFound();
    const body = await c.req.parseBody();
    store.storm.setCustomer(contact.id, body.customer === "1");
    return c.redirect(`/clients/${contact.clientId}/contacts`, 303);
  });

  app.post("/contacts/:id/retry-location", (c) => {
    const contact = store.contact(Number(c.req.param("id")));
    if (!contact) return c.notFound();
    store.storm.retryGeocode(contact.id);
    return c.redirect(`/clients/${contact.clientId}?msg=${encodeURIComponent(`Will try to locate ${contact.firstName} ${contact.lastName} again.`)}#storm`, 303);
  });

  app.get("/storm-days/:id", (c) => {
    const day = store.storm.stormDay(Number(c.req.param("id")));
    const client = day ? store.client(day.clientId) : undefined;
    if (!day || !client) return c.notFound();
    const hits = store.storm.hits(day.id);
    const batch = store.storm.batches(client.id, 100).find((b) => b.stormDayId === day.id);
    return c.html(
      page(
        `${client.name}: hail on ${stormDateLong(day.stormDate)}`,
        html`<p><a href="/clients/${client.id}#storm">Back to ${client.name}</a></p>
          <section>
            <table>
              <tr><th>Status</th><td>${day.status.replace("_", " ")}${day.reviewedAt ? html` <span class="muted">${when(day.reviewedAt, client.settings.timezone)}</span>` : ""}</td></tr>
              <tr><th>Largest estimate</th><td>${sizeBand(day.maxMm)}</td></tr>
              <tr><th>Review link</th><td><a href="${reviewUrl(deps.appUrl, day)}">${reviewUrl(deps.appUrl, day)}</a>
                <br /><span class="muted">Expires ${when(day.expiresAt, client.settings.timezone)}. Anyone with the link can send, so share it only with the contractor.</span></td></tr>
              <tr><th>Summary emailed</th><td>${day.notifiedAt ? when(day.notifiedAt, client.settings.timezone) : html`<span class="warn">not yet</span>`}</td></tr>
              ${batch ? html`<tr><th>Postcards</th><td><a href="/postcard-batches/${batch.id}">${batch.pieceCount} postcards, ${batch.status.replace("_", " ")}</a></td></tr>` : ""}
              <tr><th>Radar file</th><td class="muted"><code>${day.fileKey}</code></td></tr>
            </table>
          </section>
          <section>
            <table>
              <tr><th>Customer</th><th>Radar estimate</th><th>Ground report</th><th>Status</th><th>Email</th></tr>
              ${hits.map(
                (h) => html`<tr>
                  <td>${h.firstName} ${h.lastName}<br /><span class="muted">${h.street}, ${h.city}</span></td>
                  <td>${sizeBand(h.meshMm)}</td>
                  <td>${reportCell(h)}</td>
                  <td>${h.status}${h.reason ? html`<br /><span class="muted">${h.reason}</span>` : ""}</td>
                  <td>${emailCell(h)}</td>
                </tr>`,
              )}
            </table>
          </section>`,
      ),
    );
  });

  app.get("/postcard-batches/:id", (c) => {
    const batch = store.storm.batch(Number(c.req.param("id")));
    const client = batch ? store.client(batch.clientId) : undefined;
    const day = batch ? store.storm.stormDay(batch.stormDayId) : undefined;
    if (!batch || !client || !day) return c.notFound();
    const hits = store.storm.batchHits(batch.id);
    const sample = hits[0] ? renderPostcard(store, client, hits[0], day.stormDate) : null;
    const zone = client.settings.timezone;
    return c.html(
      page(
        `${client.name}: ${batch.pieceCount} storm postcards`,
        html`<p><a href="/clients/${client.id}#storm">Back to ${client.name}</a></p>
          <section>
            <p>
              For hail on ${stormDateLong(day.stormDate)}. Approved ${when(batch.createdAt, zone)}.
              Status: <strong>${batch.status.replace("_", " ")}</strong>${batch.orderRef ? html`, Smartpress order ${batch.orderRef}` : ""}${batch.orderedAt ? html` (${when(batch.orderedAt, zone)})` : ""}.
            </p>
            <p>Estimated cost: $${(batch.pieceCount * client.settings.postcardCost).toFixed(2)} at $${client.settings.postcardCost.toFixed(2)} a card.</p>
            <p><a href="/postcard-batches/${batch.id}/mailing-list.csv"><button type="button">Download Smartpress mailing list (CSV)</button></a></p>
            <h2>Ordering on Smartpress</h2>
            <ol>
              <li>Reorder ${client.name}'s storm postcard (4×6) and choose mailing with variable data addressing.</li>
              <li>Upload this CSV as the mailing list. Each field is its own column, as Smartpress asks.</li>
              <li>The back of the card should use the <code>Message</code> column as one variable text box, with <code>Headline</code> above it. Art that keeps its own wording can use <code>FirstName</code>, <code>Street</code> and <code>StormDate</code> instead.</li>
              <li>Approve the proof, then mark the batch ordered below with the Smartpress order number.</li>
            </ol>
            ${batch.status === "needs_order"
              ? html`<form method="post" action="/postcard-batches/${batch.id}/ordered">
                    <label for="order_ref">Smartpress order number</label>
                    <input type="text" id="order_ref" name="order_ref" />
                    <p><button>Mark ordered</button></p>
                  </form>
                  <form method="post" action="/postcard-batches/${batch.id}/cancel"><button class="quiet">Cancel this batch</button></form>`
              : ""}
          </section>
          ${sample
            ? html`<section>
                <h2>First card</h2>
                <p><strong>${sample.subject}</strong></p>
                <pre class="email">${sample.body}</pre>
                <p class="help">Edit the wording in the client's “Storm alert postcard” template. Every card in the batch uses it.</p>
              </section>`
            : ""}
          <section>
            <table>
              <tr><th>Name</th><th>Address</th></tr>
              ${hits.map((h) => html`<tr><td>${h.firstName} ${h.lastName}</td><td>${h.street}, ${h.city}, ${h.state} ${h.zip}</td></tr>`)}
            </table>
          </section>`,
        c.req.query("msg"),
      ),
    );
  });

  app.get("/postcard-batches/:id/mailing-list.csv", (c) => {
    const batch = store.storm.batch(Number(c.req.param("id")));
    const client = batch ? store.client(batch.clientId) : undefined;
    if (!batch || !client) return c.notFound();
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${client.slug}-storm-postcards-${batch.id}.csv"`);
    return c.body(postcardCsv(store, client, batch));
  });

  app.post("/postcard-batches/:id/ordered", async (c) => {
    const batch = store.storm.batch(Number(c.req.param("id")));
    if (!batch) return c.notFound();
    const body = await c.req.parseBody();
    store.storm.markBatchOrdered(batch.id, typeof body.order_ref === "string" ? body.order_ref.trim() : "", now());
    return c.redirect(`/postcard-batches/${batch.id}?msg=Marked+ordered.`, 303);
  });

  app.post("/postcard-batches/:id/cancel", (c) => {
    const batch = store.storm.batch(Number(c.req.param("id")));
    if (!batch) return c.notFound();
    store.storm.cancelBatch(batch.id);
    return c.redirect(`/postcard-batches/${batch.id}?msg=Cancelled.`, 303);
  });

  app.post("/clients/:id/storm-reports", async (c) => {
    const client = clientFrom(c.req.param("id"));
    if (!client) return c.notFound();
    const body = await c.req.parseBody();
    const months = Math.min(Math.max(Number(body.months) || 12, 1), 60);
    const to = latestStormDate(now());
    const from = new Date(Date.parse(`${to}T00:00:00Z`));
    from.setUTCMonth(from.getUTCMonth() - months);
    from.setUTCDate(from.getUTCDate() + 1);
    const report = store.storm.createReport(client.id, from.toISOString().slice(0, 10), to, client.settings.stormThresholdInches, now());
    return c.redirect(`/storm-reports/${report.id}`, 303);
  });

  app.get("/storm-reports/:id", (c) => {
    const report = store.storm.report(Number(c.req.param("id")));
    const client = report ? store.client(report.clientId) : undefined;
    if (!report || !client) return c.notFound();
    const summary = reportSummary(report);
    const total = Math.round((Date.parse(report.toDate) - Date.parse(report.fromDate)) / 86_400_000) + 1;
    return c.html(
      page(
        `${client.name}: storm report`,
        html`<p><a href="/clients/${client.id}#storm">Back to ${client.name}</a></p>
          <section>
            <p>${stormDateLong(report.fromDate)}, ${report.fromDate.slice(0, 4)} to ${stormDateLong(report.toDate)}, ${report.toDate.slice(0, 4)}.
              Hail of ${report.thresholdInches}″ or more by radar estimate, checked against ${report.customersChecked || "the client's"} located customers.</p>
            ${report.status === "done"
              ? html`<p><strong>Hail hit ${summary.customers} of ${client.name}'s past customers on ${summary.days} different days.</strong>
                  ${summary.contacts > summary.customers ? html` Counting repeat hits, that's ${summary.contacts} times a customer was under hail.` : ""}</p>`
              : report.status === "error"
                ? html`<p class="bad">Stopped: ${report.error}</p>`
                : html`<p class="warn">Working: ${report.daysChecked} of ${total} days checked. Reload in a minute.</p>`}
            ${report.daysMissing ? html`<p class="muted">${report.daysMissing} days had no radar file and were skipped.</p>` : ""}
          </section>
          <section>
            <table>
              <tr><th>Storm day</th><th>Customers hit</th><th>Largest</th><th>Who</th></tr>
              ${report.result.length
                ? [...report.result].reverse().map(
                    (d) => html`<tr>
                      <td>${stormDateLong(d.stormDate)}, ${d.stormDate.slice(0, 4)}</td>
                      <td>${d.hits.length}</td>
                      <td>${sizeBand(d.maxMm)}</td>
                      <td class="muted">${d.hits.slice(0, 8).map((h) => `${h.name} (${h.street})`).join("; ")}${d.hits.length > 8 ? `; and ${d.hits.length - 8} more` : ""}</td>
                    </tr>`,
                  )
                : html`<tr><td colspan="4" class="muted">No hits${report.status === "done" ? "" : " yet"}.</td></tr>`}
            </table>
          </section>`,
      ),
    );
  });
}

function reviewPage(deps: WebDeps, client: Client, day: StormDay): Html {
  const { store, now } = deps;
  const s = client.settings;
  const hits = store.storm.hits(day.id);
  const pending = hits.filter((h) => h.status === "pending");
  const skipped = hits.filter((h) => h.status === "skipped" && h.reason && !h.reason.startsWith("No email on file"));
  const sample = pending[0] ?? hits[0];
  const emailPreview = sample ? renderStormEmail(store, client, sample, day.stormDate, deps.appUrl) : null;
  const cardPreview = sample ? renderPostcard(store, client, sample, day.stormDate) : null;

  if (day.status !== "pending_review" || day.expiresAt <= now()) {
    const approved = hits.filter((h) => h.status === "approved");
    const sent = approved.filter((h) => h.emailStatus === "sent").length;
    const queued = approved.filter((h) => h.emailStatus === "queued").length;
    const batch = store.storm.batches(client.id, 100).find((b) => b.stormDayId === day.id);
    const headline =
      day.status === "approved"
        ? html`<p class="ok">Approved ${when(day.reviewedAt, s.timezone)}. ${sent} sent${queued ? html`, ${queued} waiting for ${clock12(s.stormSendStart)} your time` : ""}${batch ? html`, ${batch.pieceCount} postcards ${batch.status === "ordered" ? "ordered" : "being ordered"}` : ""}.</p>`
        : day.status === "dismissed"
          ? html`<p>You chose not to send anything for this storm.</p>`
          : html`<p class="muted">This storm alert expired without being sent. Storm notes more than a few days old read as opportunistic.</p>`;
    return html`${headline}
      ${approved.length
        ? html`<section><table>
            <tr><th>Customer</th><th>Email</th></tr>
            ${approved.map((h) => html`<tr><td>${h.firstName} ${h.lastName}<br /><span class="muted">${h.street}</span></td><td>${emailCell(h)}</td></tr>`)}
          </table></section>`
        : ""}`;
  }

  const withoutEmail = pending.filter((h) => !h.email).length;
  return html`<p>
      Weather radar shows hail near <strong>${pending.length} of your past customers</strong>. Untick anyone you don't want to contact,
      then press Send. ${pending.length - withoutEmail} have an email on file${withoutEmail ? html`; ${withoutEmail} don't` : ""}.
    </p>
    <p class="help">Sizes are radar estimates, not measurements. A nearby ground report makes a hit more certain. This link expires ${when(day.expiresAt, s.timezone)}.</p>
    <form method="post" action="/storm/${day.reviewToken}">
      <section>
        <table>
          <tr><th></th><th>Customer</th><th>Radar estimate</th><th>Ground report</th></tr>
          ${pending.map(
            (h) => html`<tr>
              <td><input type="checkbox" name="hit" value="${h.id}" checked aria-label="Include ${h.firstName} ${h.lastName}" /></td>
              <td>${h.firstName} ${h.lastName}<br /><span class="muted">${h.street}, ${h.city}${h.email ? "" : " · no email"}</span></td>
              <td>${sizeBand(h.meshMm)}</td>
              <td>${reportCell(h)}</td>
            </tr>`,
          )}
        </table>
      </section>
      ${s.postcardsEnabled
        ? html`<label class="check"><input type="checkbox" name="postcards" /> Also mail each one a postcard (about $${(pending.length * s.postcardCost).toFixed(2)} for ${pending.length}, arrives in about a week)</label>
            ${withoutEmail ? html`<p class="help">Customers without an email only get something if you tick this.</p>` : ""}`
        : ""}
      <p>
        <button name="action" value="send">Send</button>
        <button class="quiet" name="action" value="dismiss">Don't send anything</button>
      </p>
      <p class="help">Emails go out between ${clock12(s.stormSendStart)} and ${clock12(s.stormSendEnd)} your time, from ${s.senderName || "you"} at ${s.businessName}. Replies come to ${s.replyTo || "your inbox"}.</p>
    </form>
    ${emailPreview
      ? html`<section>
          <h2>The email${sample ? ` to ${sample.firstName}` : ""}</h2>
          <p><strong>${emailPreview.subject}</strong></p>
          <pre class="email">${emailPreview.body}</pre>
        </section>`
      : ""}
    ${s.postcardsEnabled && cardPreview
      ? html`<section>
          <h2>The postcard</h2>
          <p><strong>${cardPreview.subject}</strong></p>
          <pre class="email">${cardPreview.body}</pre>
        </section>`
      : ""}
    ${skipped.length
      ? html`<section>
          <h2>Also hit, but left out</h2>
          <ul>${skipped.map((h) => html`<li>${hitLine(h)} <span class="muted">(${h.reason})</span></li>`)}</ul>
        </section>`
      : ""}`;
}

function importPage(client: Client): Html {
  return html`<p><a href="/clients/${client.id}#storm">Back to ${client.name}</a></p>
    <section>
      <h2>Import past customers</h2>
      <p>Storm alerts only go to contacts marked as customers. Upload a CSV with a header row. Columns, in any order:
        <code>first_name, last_name, email, phone, street, city, state, zip, job_date</code>. Street, city, state and ZIP are required, and email
        is needed for the email (customers without one can still get a postcard).</p>
      <p class="help">Rows that match an existing contact by email or phone update it and mark it as a customer. Common export names like
        “Address” or “Zip Code” are recognized.</p>
      <form method="post" action="/clients/${client.id}/import" enctype="multipart/form-data">
        <label for="file">CSV file</label>
        <input type="file" id="file" name="file" accept=".csv,text/csv" />
        <label for="csv">Or paste it</label>
        <textarea id="csv" name="csv" placeholder="first_name,last_name,email,phone,street,city,state,zip,job_date"></textarea>
        <p><button>Import</button></p>
      </form>
    </section>`;
}

/** The storm alerts section of the client page. */
export function stormSection(deps: WebDeps, client: Client): Html {
  const { store } = deps;
  const s = client.settings;
  const zone = s.timezone;
  const counts = store.storm.customerCounts(client.id);
  const problems = stormReadinessProblems(s);
  const days = store.storm.stormDays(client.id, 10);
  const batches = store.storm.batches(client.id, 10);
  const reports = store.storm.reports(client.id, 5);
  const unlocated = store.storm.unlocated(client.id, 10);
  const run = store.storm.latestRun();

  const status = !s.stormEnabled
    ? html`<p class="muted">Off. Turn it on in Settings once customers are imported and the postal address is filled in.</p>`
    : problems.length
      ? html`<p class="warn">On, but not running: ${problems.join(" ")}</p>`
      : client.paused
        ? html`<p class="warn">On, but the client is paused.</p>`
        : html`<p class="ok">On. Checks last night's hail every morning once NOAA posts it (after 12:20 UTC, so about 7:30 AM Central in summer and 6:30 AM in winter), at ${s.stormThresholdInches}″ or more.</p>`;

  return html`<section id="storm">
    <h2>Storm alerts</h2>
    ${status}
    <p>
      ${counts.customers} customers: ${counts.located} located, ${counts.waiting} waiting to be located,
      ${counts.notFound ? html`<span class="warn">${counts.notFound} not found</span>` : "0 not found"}. ${counts.withEmail} have an email.
      <a href="/clients/${client.id}/import">Import customers</a>
    </p>
    ${run ? html`<p class="help">Last radar check: storm day ${run.stormDate}, ${run.status === "done" ? "done" : html`<span class="bad">${run.error}</span>`} (${when(run.checkedAt, zone)}).</p>` : ""}

    <table>
      <tr><th>Storm day</th><th>Customers hit</th><th>Status</th></tr>
      ${days.length
        ? days.map((d) => {
            const hits = store.storm.hits(d.id);
            const included = hits.filter((h) => h.status !== "skipped").length;
            return html`<tr>
              <td><a href="/storm-days/${d.id}">${stormDateLong(d.stormDate)}</a></td>
              <td>${included}${hits.length > included ? html` <span class="muted">(+${hits.length - included} left out)</span>` : ""}</td>
              <td>${d.status.replace("_", " ")}</td>
            </tr>`;
          })
        : html`<tr><td colspan="3" class="muted">No storm days yet.</td></tr>`}
    </table>

    ${batches.length
      ? html`<h2 style="margin-top:16px">Postcard batches</h2>
          <table>
            ${batches.map(
              (b) => html`<tr>
                <td><a href="/postcard-batches/${b.id}">${b.pieceCount} postcards</a></td>
                <td class="${b.status === "needs_order" ? "warn" : "muted"}">${b.status.replace("_", " ")}</td>
                <td class="muted">${when(b.createdAt, zone)}</td>
              </tr>`,
            )}
          </table>`
      : ""}

    ${unlocated.length
      ? html`<h2 style="margin-top:16px">Couldn't locate</h2>
          <p class="help">Fix the address in the source list and import again, or try again if the lookup failed on a network error.</p>
          <table>
            ${unlocated.map(
              (u) => html`<tr>
                <td>${u.name}</td><td>${u.address}<br /><span class="muted">${u.note ?? ""}</span></td>
                <td><form method="post" action="/contacts/${u.id}/retry-location"><button class="quiet">Try again</button></form></td>
              </tr>`,
            )}
          </table>`
      : ""}

    <h2 style="margin-top:16px">Past storms report</h2>
    <p class="help">Replays NOAA's radar hail record against this client's located customers. A year takes a few minutes.</p>
    <form method="post" action="/clients/${client.id}/storm-reports">
      <label for="months">How far back</label>
      <select id="months" name="months"><option value="12">12 months</option><option value="24">24 months</option><option value="36">36 months</option></select>
      <p><button>Run report</button></p>
    </form>
    ${reports.length
      ? html`<table>
          ${reports.map((r) => {
            const sum = reportSummary(r);
            return html`<tr>
              <td><a href="/storm-reports/${r.id}">${r.fromDate} to ${r.toDate}</a></td>
              <td>${r.status === "done" ? `${sum.customers} customers hit on ${sum.days} days` : r.status}</td>
            </tr>`;
          })}
        </table>`
      : ""}
  </section>`;
}
