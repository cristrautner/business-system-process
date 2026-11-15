// HTTP routes: the agency dashboard (behind basic auth), the contractor's Google connect page,
// and the endpoint the contractor's website form posts leads to.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html } from "hono/html";
import { encrypt } from "../crypto.ts";
import type { OAuthClient } from "../google.ts";
import { renderFor } from "../jobs.ts";
import { parseLead, RateLimiter, type Lead } from "../leads.ts";
import { fromHeader, type Mailer } from "../mailer.ts";
import {
  APPOINTMENT_TYPES,
  isValidZone,
  keywordLines,
  parseKeywordLines,
  readinessProblems,
  TEMPLATE_TYPES,
  templateFor,
  type AppointmentType,
  type ClientSettings,
  type TemplateType,
} from "../settings.ts";
import type { Client, Store } from "../store.ts";
import { render, TEMPLATE_LABELS, unknownNames, VARIABLES } from "../templates.ts";
import { page, publicPage, when, type Html } from "./html.ts";
import { registerStormRoutes, STORM_PUBLIC_PREFIXES, stormSection } from "./storm.ts";

export interface WebDeps {
  store: Store;
  oauth: OAuthClient;
  mailer: Mailer;
  tokenKey: Buffer;
  appUrl: string;
  adminUser: string;
  adminPassword: string;
  now: () => number;
  log: (message: string) => void;
}

const PUBLIC_PREFIXES = ["/healthz", "/connect/", "/oauth/", "/api/", ...STORM_PUBLIC_PREFIXES];
const STATE_MAX_AGE_MS = 30 * 60 * 1000;

export function createApp(deps: WebDeps): Hono {
  const { store, now } = deps;
  const app = new Hono();
  const leadLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const appHost = new URL(deps.appUrl).host;

  // Signed OAuth state: which client is connecting, and when the link was opened.
  const sign = (payload: string) => createHmac("sha256", deps.tokenKey).update(payload).digest("base64url");
  const makeState = (clientId: number) => {
    const payload = `${clientId}.${now()}`;
    return `${payload}.${sign(payload)}`;
  };
  const readState = (state: string): number | null => {
    const [clientId, issuedAt, signature] = state.split(".");
    if (!clientId || !issuedAt || !signature) return null;
    const expected = Buffer.from(sign(`${clientId}.${issuedAt}`));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    if (now() - Number(issuedAt) > STATE_MAX_AGE_MS) return null;
    return Number(clientId);
  };

  // Everything except the public routes requires the agency login.
  const auth = basicAuth({ username: deps.adminUser, password: deps.adminPassword });
  app.use("*", async (c, next) => {
    if (PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next();
    return auth(c, next);
  });

  // Browsers send basic-auth credentials on cross-site requests too, so dashboard forms
  // only accept posts that come from the dashboard itself.
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST" || PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next();
    const source = c.req.header("origin") ?? c.req.header("referer");
    let host: string | null = null;
    try {
      host = source ? new URL(source).host : null;
    } catch {
      host = null;
    }
    if (host !== appHost) return c.text("Forbidden: this form must be submitted from the dashboard.", 403);
    return next();
  });

  app.get("/healthz", (c) => c.text("ok"));

  // Contractor connects their Google Calendar

  app.get("/connect/:token", (c) => {
    const client = store.clientByConnectToken(c.req.param("token"));
    if (!client) return c.html(publicPage("Link expired", html`<p>This connect link isn't valid anymore. Ask for a new one.</p>`), 404);
    const connection = store.connection(client.id);
    return c.html(
      publicPage(
        `Connect ${client.name}'s calendar`,
        html`<p>
            After each appointment on your Google Calendar, this sends the homeowner a short thank-you email from you, a couple of hours
            later. It needs permission to <strong>read</strong> your calendar events. It can't change your calendar or read your email.
          </p>
          ${connection
            ? html`<p class="ok">Already connected${connection.googleEmail ? html` as ${connection.googleEmail}` : ""}. Connecting again replaces it.</p>`
            : ""}
          <p><a href="${deps.oauth.authUrl(makeState(client.id))}"><button type="button">Connect Google Calendar</button></a></p>
          <p class="help">Google may say the app isn't verified yet. That's expected for a small private app. Choose “Advanced,” then continue.</p>`,
      ),
    );
  });

  app.get("/oauth/google/callback", async (c) => {
    const clientId = readState(c.req.query("state") ?? "");
    const client = clientId ? store.client(clientId) : undefined;
    if (!client) return c.html(publicPage("Link expired", html`<p>That sign-in took too long or the link was changed. Open the connect link again.</p>`), 400);
    if (c.req.query("error") || !c.req.query("code")) {
      return c.html(publicPage("Not connected", html`<p>Google didn't grant access, so nothing was connected. You can close this tab.</p>`));
    }
    try {
      const { refreshToken, email } = await deps.oauth.exchangeCode(c.req.query("code")!);
      store.saveConnection(client.id, encrypt(refreshToken, deps.tokenKey), email, now());
      // One use per link, so a forwarded link can't later attach someone else's calendar to this client.
      store.rotateConnectToken(client.id);
      deps.log(`connected Google Calendar for ${client.slug}${email ? ` (${email})` : ""}`);
      return c.html(publicPage("Connected", html`<p class="ok">Your calendar is connected${email ? html` as ${email}` : ""}. You can close this tab.</p>`));
    } catch (error) {
      deps.log(`Google connect failed for ${client.slug}: ${error instanceof Error ? error.message : String(error)}`);
      return c.html(publicPage("Not connected", html`<p class="bad">${error instanceof Error ? error.message : "Something went wrong."}</p>`), 400);
    }
  });

  // Website form leads

  const corsHeaders = (c: Context, origin: string | undefined, allowed: boolean) => {
    if (origin && allowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Headers", "content-type, x-api-key");
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  };

  app.options("/api/leads", (c) => {
    const origin = c.req.header("origin");
    corsHeaders(c, origin, store.clients().some((client) => client.settings.allowedOrigin && client.settings.allowedOrigin === origin));
    return c.body(null, 204);
  });

  app.post("/api/leads", async (c) => {
    const isJson = (c.req.header("content-type") ?? "").includes("application/json");
    const body = (isJson ? await c.req.json().catch(() => ({})) : await c.req.parseBody()) as Record<string, unknown>;
    const key = c.req.header("x-api-key") ?? (typeof body.api_key === "string" ? body.api_key : "");
    const client = key ? store.clientByLeadKey(key) : undefined;
    if (!client) return c.json({ ok: false, errors: ["Unknown API key."] }, 401);

    const origin = c.req.header("origin");
    corsHeaders(c, origin, Boolean(client.settings.allowedOrigin) && client.settings.allowedOrigin === origin);

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || remoteAddress(c);
    if (!leadLimiter.allow(`${client.id}:${ip}`, now())) return c.json({ ok: false, errors: ["Too many submissions. Try again later."] }, 429);

    const redirect = typeof body.redirect === "string" && client.settings.allowedOrigin && body.redirect.startsWith(client.settings.allowedOrigin)
      ? body.redirect
      : null;
    const result = parseLead(body);
    if (!result.ok) {
      if (result.spam) return redirect ? c.redirect(redirect, 303) : c.json({ ok: true }, 201);
      return c.json({ ok: false, errors: result.errors }, 422);
    }

    const { lead } = result;
    store.upsertContact(client.id, { ...lead, source: "website" }, result.phoneDigits, now());
    await notifyLead(deps, client, lead).catch((error) =>
      deps.log(`lead notification failed for ${client.slug}: ${error instanceof Error ? error.message : String(error)}`),
    );
    return redirect ? c.redirect(redirect, 303) : c.json({ ok: true }, 201);
  });

  // Dashboard

  app.get("/", (c) => {
    const clients = store.clients();
    const rows = clients.map((client) => {
      const connection = store.connection(client.id);
      const problems = readinessProblems(client.settings);
      const status = client.paused
        ? html`<span class="warn">Paused</span>`
        : !connection
          ? html`<span class="warn">Calendar not connected</span>`
          : connection.lastError
            ? html`<span class="bad">Error</span>`
            : problems.length
              ? html`<span class="warn">Needs setup</span>`
              : html`<span class="ok">Running</span>`;
      return html`<tr>
        <td><a href="/clients/${client.id}">${client.name}</a></td>
        <td>${status}</td>
        <td>${store.countScheduled(client.id)}</td>
        <td class="muted">${when(connection?.lastPollAt, client.settings.timezone)}</td>
      </tr>`;
    });
    return c.html(
      page(
        "Clients",
        html`${deps.mailer.dryRun ? html`<div class="flash warn">Dry run is on. Nothing is actually emailed. Set DRY_RUN=false to go live.</div>` : ""}
          <section>
            <table>
              <tr><th>Client</th><th>Status</th><th>Scheduled</th><th>Last calendar check</th></tr>
              ${rows.length ? rows : html`<tr><td colspan="4" class="muted">No clients yet.</td></tr>`}
            </table>
          </section>
          <section>
            <h2>Add a client</h2>
            <form method="post" action="/clients">
              <label for="name">Business name</label>
              <input type="text" id="name" name="name" required placeholder="Sandhill Roofing" />
              <p><button>Add client</button></p>
            </form>
          </section>`,
        c.req.query("msg"),
      ),
    );
  });

  app.post("/clients", async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.redirect("/?msg=Business+name+is+required", 303);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    let slug = base;
    for (let n = 2; store.clients().some((existing) => existing.slug === slug); n++) slug = `${base}-${n}`;
    const client = store.createClient(name, slug, now());
    return c.redirect(`/clients/${client.id}?msg=Client+added.+Fill+in+the+settings,+then+send+the+connect+link.`, 303);
  });

  app.get("/clients/:id", (c) => {
    const client = store.client(Number(c.req.param("id")));
    if (!client) return c.notFound();
    return c.html(page(client.name, clientPage(deps, client), c.req.query("msg")));
  });

  app.post("/clients/:id/settings", async (c) => {
    const client = store.client(Number(c.req.param("id")));
    if (!client) return c.notFound();
    const { settings, errors } = readSettingsForm(await c.req.parseBody(), client.settings);
    if (errors.length) return c.redirect(`/clients/${client.id}?msg=${encodeURIComponent(`Not saved. ${errors.join(" ")}`)}#settings`, 303);
    store.saveSettings(client.id, settings);
    return c.redirect(`/clients/${client.id}?msg=Settings+saved.#settings`, 303);
  });

  const clientAction = (path: string, action: (client: Client) => string) =>
    app.post(`/clients/:id/${path}`, (c) => {
      const client = store.client(Number(c.req.param("id")));
      if (!client) return c.notFound();
      return c.redirect(`/clients/${client.id}?msg=${encodeURIComponent(action(client))}`, 303);
    });
  clientAction("pause", (client) => (store.setPaused(client.id, true), "Paused. Nothing will send until you resume."));
  clientAction("resume", (client) => (store.setPaused(client.id, false), "Resumed."));
  clientAction("disconnect", (client) => (store.deleteConnection(client.id), "Google Calendar disconnected."));
  clientAction("rotate-lead-key", (client) => (store.rotateLeadKey(client.id), "New lead API key created. Update the website form."));
  clientAction("rotate-connect-link", (client) => (store.rotateConnectToken(client.id), "New connect link created. The old one no longer works."));

  app.post("/appointments/:id/skip", (c) => {
    const appointment = store.appointment(Number(c.req.param("id")));
    if (!appointment) return c.notFound();
    store.markSkipped(appointment.id, "Skipped by hand", now());
    return c.redirect(`/clients/${appointment.clientId}?msg=Skipped.`, 303);
  });

  app.get("/appointments/:id", (c) => {
    const appointment = store.appointment(Number(c.req.param("id")));
    const client = appointment ? store.client(appointment.clientId) : undefined;
    if (!appointment || !client) return c.notFound();
    const zone = client.settings.timezone;
    const sent = store.sendFor(appointment.id);
    const preview = sent
      ? sent
      : renderFor(store, client, templateFor(appointment.type as AppointmentType), appointment.firstName, appointment.startAt);
    return c.html(
      page(
        appointment.title || "Appointment",
        html`<section>
            <table>
              <tr><th>Client</th><td><a href="/clients/${client.id}">${client.name}</a></td></tr>
              <tr><th>Type</th><td>${appointment.type}</td></tr>
              <tr><th>Appointment</th><td>${when(appointment.startAt, zone)} to ${when(appointment.endAt, zone)}</td></tr>
              <tr><th>Homeowner</th><td>${appointment.recipient ?? html`<span class="muted">none found</span>`}</td></tr>
              <tr><th>Status</th><td>${appointment.status}${appointment.reason ? html` <span class="muted">(${appointment.reason})</span>` : ""}</td></tr>
              <tr><th>${sent ? "Sent" : "Sends"}</th><td>${when(sent?.sentAt ?? appointment.sendAt, zone)}${sent?.dryRun ? " (dry run)" : ""}</td></tr>
            </table>
          </section>
          <section>
            <h2>${sent ? `What went to ${sent.to}` : "What it will say"}</h2>
            <p><strong>${preview.subject}</strong></p>
            <pre class="email">${preview.body}</pre>
            ${sent ? "" : html`<p class="help">Preview from what's known now. The calendar is checked again right before sending.</p>`}
          </section>`,
      ),
    );
  });

  app.get("/clients/:id/contacts", (c) => {
    const client = store.client(Number(c.req.param("id")));
    if (!client) return c.notFound();
    const rows = store.contacts(client.id).map(
      (contact) => html`<tr>
        <td>${contact.firstName} ${contact.lastName}</td>
        <td>${contact.email ?? ""}<br /><span class="muted">${contact.phone ?? ""}</span></td>
        <td>${contact.street ?? ""}<br /><span class="muted">${[contact.city, contact.state, contact.zip].filter(Boolean).join(", ")}</span></td>
        <td>${contact.service ?? ""}${contact.insuranceClaim ? html`<br /><span class="muted">Insurance: ${contact.insuranceClaim}</span>` : ""}</td>
        <td>
          ${contact.isCustomer ? html`Customer${contact.jobDate ? html`<br /><span class="muted">Job ${contact.jobDate}</span>` : ""}` : html`<span class="muted">Lead</span>`}
          <form method="post" action="/contacts/${contact.id}/customer">
            <input type="hidden" name="customer" value="${contact.isCustomer ? "0" : "1"}" />
            <button class="quiet">${contact.isCustomer ? "Mark as lead" : "Mark as customer"}</button>
          </form>
        </td>
        <td>${contact.geocodeStatus === "matched"
          ? html`<span class="ok">Located</span>`
          : contact.geocodeStatus
            ? html`<span class="warn">Not found</span>`
            : html`<span class="muted">Waiting</span>`}${contact.stormOptOut ? html`<br /><span class="muted">Unsubscribed</span>` : ""}</td>
        <td class="muted">${when(contact.createdAt, client.settings.timezone)}</td>
      </tr>`,
    );
    return c.html(
      page(
        `${client.name}: contacts`,
        html`<p><a href="/clients/${client.id}">Back to ${client.name}</a></p>
          <section>
            <table>
              <tr><th>Name</th><th>Contact</th><th>Property</th><th>Service</th><th>Storm alerts</th><th>Map</th><th>Added</th></tr>
              ${rows.length ? rows : html`<tr><td colspan="7" class="muted">No contacts yet. They arrive from the website form, or <a href="/clients/${client.id}/import">import past customers</a>.</td></tr>`}
            </table>
          </section>`,
      ),
    );
  });

  const templateType = (value: string): TemplateType | null =>
    (TEMPLATE_TYPES as readonly string[]).includes(value) ? (value as TemplateType) : null;

  app.get("/clients/:id/templates/:type", (c) => {
    const client = store.client(Number(c.req.param("id")));
    const type = templateType(c.req.param("type"));
    if (!client || !type) return c.notFound();
    return c.html(page(`${client.name}: ${TEMPLATE_LABELS[type]}`, templatePage(deps, client, type), c.req.query("msg")));
  });

  app.post("/clients/:id/templates/:type", async (c) => {
    const client = store.client(Number(c.req.param("id")));
    const type = templateType(c.req.param("type"));
    if (!client || !type) return c.notFound();
    const body = await c.req.parseBody();
    const template = {
      subject: typeof body.subject === "string" ? body.subject.trim() : "",
      body: typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "",
    };
    const back = `/clients/${client.id}/templates/${type}`;
    if (!template.subject || !template.body) return c.redirect(`${back}?msg=Subject+and+body+are+both+required.`, 303);
    const unknown = unknownNames(template);
    if (unknown.length) return c.redirect(`${back}?msg=${encodeURIComponent(`Not saved. Unknown names: ${unknown.join(", ")}.`)}`, 303);
    store.saveTemplate(client.id, type, template, now());
    return c.redirect(`${back}?msg=Template+saved.`, 303);
  });

  app.post("/clients/:id/templates/:type/reset", (c) => {
    const client = store.client(Number(c.req.param("id")));
    const type = templateType(c.req.param("type"));
    if (!client || !type) return c.notFound();
    store.resetTemplate(client.id, type);
    return c.redirect(`/clients/${client.id}/templates/${type}?msg=Back+to+the+default+template.`, 303);
  });

  registerStormRoutes(app, deps);
  return app;
}

function remoteAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function notifyLead(deps: WebDeps, client: Client, lead: Lead) {
  const s = client.settings;
  if (!s.leadNotifyEmail || !s.fromAddress) return;
  const lines = [
    `New lead from the website:`,
    ``,
    `${lead.firstName} ${lead.lastName}`,
    `${lead.email}`,
    `${lead.phone}`,
    `${lead.street}, ${lead.city}, ${lead.state} ${lead.zip}`,
    ``,
    `Service: ${lead.service}`,
    lead.insuranceClaim ? `Insurance claim: ${lead.insuranceClaim}` : null,
    lead.notes ? `\nNotes:\n${lead.notes}` : null,
  ].filter((line) => line !== null);
  await deps.mailer.send({
    from: fromHeader("Website", s.businessName, s.fromAddress),
    to: s.leadNotifyEmail,
    replyTo: lead.email,
    subject: `New website lead: ${lead.firstName} ${lead.lastName}`,
    text: lines.join("\n"),
    idempotencyKey: `lead-${client.id}-${lead.email}-${deps.now()}`,
  });
}

function clientPage(deps: WebDeps, client: Client): Html {
  const { store, now } = deps;
  const s = client.settings;
  const zone = s.timezone;
  const connection = store.connection(client.id);
  const problems = readinessProblems(s);
  const upcoming = store.upcoming(client.id, now() + 48 * 60 * 60 * 1000);
  const history = store.history(client.id);
  const unrecognized = store.unrecognized(client.id);
  const connectUrl = `${deps.appUrl}/connect/${client.connectToken}`;
  const statusClass = (status: string) => (status === "sent" ? "ok" : status === "failed" ? "bad" : "muted");

  return html`
    ${client.paused ? html`<div class="flash warn">Paused. Nothing sends until you resume.</div>` : ""}
    ${problems.length ? html`<div class="flash warn">Needs setup before anything sends: ${problems.join(" ")}</div>` : ""}
    ${s.shadowEmail ? html`<div class="flash">Shadow mode: every email goes to ${s.shadowEmail} instead of the homeowner.</div>` : ""}

    <section>
      <h2>Google Calendar</h2>
      ${connection
        ? html`<p>
              Connected${connection.googleEmail ? html` as <strong>${connection.googleEmail}</strong>` : ""} on ${when(connection.connectedAt, zone)}.
              Last checked ${when(connection.lastPollAt, zone)}.
            </p>
            ${connection.lastError ? html`<p class="bad">Last error: ${connection.lastError}</p>` : ""}`
        : html`<p class="warn">Not connected yet.</p>`}
      <p>Send this link to the contractor. They open it and sign in with the Google account that holds their appointments. It works once, then changes. Check that the connected account above is really theirs.</p>
      <p><code>${connectUrl}</code></p>
      <form class="inline" method="post" action="/clients/${client.id}/rotate-connect-link"><button class="quiet">New link</button></form>
      ${connection
        ? html`<form class="inline" method="post" action="/clients/${client.id}/disconnect"><button class="quiet">Disconnect</button></form>`
        : ""}
      ${client.paused
        ? html`<form class="inline" method="post" action="/clients/${client.id}/resume"><button>Resume sending</button></form>`
        : html`<form class="inline" method="post" action="/clients/${client.id}/pause"><button class="quiet">Pause sending</button></form>`}
    </section>

    <section>
      <h2>Upcoming</h2>
      <table>
        <tr><th>Sends</th><th>Appointment</th><th>Homeowner</th><th></th></tr>
        ${upcoming.length
          ? upcoming.map(
              (a) => html`<tr>
                <td>${when(a.sendAt, zone)}</td>
                <td><a href="/appointments/${a.id}">${a.title}</a><br /><span class="muted">${a.type}, ends ${when(a.endAt, zone)}</span></td>
                <td>${a.recipient ?? ""}${a.reason ? html`<br /><span class="warn">${a.reason}</span>` : ""}</td>
                <td><form method="post" action="/appointments/${a.id}/skip"><button class="quiet">Skip</button></form></td>
              </tr>`,
            )
          : html`<tr><td colspan="4" class="muted">Nothing scheduled in the next 48 hours.</td></tr>`}
      </table>
    </section>

    <section>
      <h2>History</h2>
      <table>
        <tr><th>When</th><th>Appointment</th><th>Result</th></tr>
        ${history.length
          ? history.map(
              (a) => html`<tr>
                <td>${when(a.updatedAt, zone)}</td>
                <td><a href="/appointments/${a.id}">${a.title}</a><br /><span class="muted">${a.recipient ?? "no homeowner email"}</span></td>
                <td><span class="${statusClass(a.status)}">${a.status}</span>${a.reason ? html`<br /><span class="muted">${a.reason}</span>` : ""}</td>
              </tr>`,
            )
          : html`<tr><td colspan="3" class="muted">Nothing sent or skipped yet.</td></tr>`}
      </table>
    </section>

    <section>
      <h2>Not recognized</h2>
      <p class="help">Calendar events from the last week whose title doesn't start with an appointment keyword. If a real appointment shows up here, add its first word as a keyword in Settings.</p>
      <table>
        ${unrecognized.length
          ? unrecognized.map((u) => html`<tr><td>${u.title}</td><td class="muted">${when(u.startAt, zone)}</td></tr>`)
          : html`<tr><td class="muted">None.</td></tr>`}
      </table>
    </section>

    <section>
      <h2>Templates</h2>
      <table>
        ${TEMPLATE_TYPES.map((type) => {
          const template = store.template(client.id, type);
          return html`<tr>
            <td><a href="/clients/${client.id}/templates/${type}">${TEMPLATE_LABELS[type]}</a></td>
            <td class="muted">${template.custom ? "Customized" : "Default"}</td>
          </tr>`;
        })}
      </table>
    </section>

    <section>
      <h2>Website form</h2>
      <p>The site posts leads to <code>${deps.appUrl}/api/leads</code> with this key in an <code>X-Api-Key</code> header or an <code>api_key</code> field:</p>
      <p><code>${client.leadApiKey}</code></p>
      <p class="help">Fields: first_name, last_name, email, phone, street, city, state, zip, service, insurance_claim (yes, no, not sure), notes.
        Add a hidden, empty field named <code>website</code> to catch bots, and an optional <code>redirect</code> to a thank-you page on the client's site.</p>
      <p><a href="/clients/${client.id}/contacts">View contacts</a></p>
      <form class="inline" method="post" action="/clients/${client.id}/rotate-lead-key"><button class="quiet">New key</button></form>
    </section>

    ${stormSection(deps, client)}

    <section id="settings">
      <h2>Settings</h2>
      ${settingsForm(client)}
    </section>
  `;
}

function settingsForm(client: Client): Html {
  const s = client.settings;
  const text = (name: keyof ClientSettings, label: string, help = "", type = "text") =>
    html`<label for="${name}">${label}</label><input type="${type}" id="${name}" name="${name}" value="${String(s[name] ?? "")}" />
      ${help ? html`<p class="help">${help}</p>` : ""}`;
  const check = (name: keyof ClientSettings, label: string) =>
    html`<label class="check"><input type="checkbox" name="${name}" ${s[name] ? "checked" : ""} /> ${label}</label>`;

  return html`<form method="post" action="/clients/${client.id}/settings">
    <div class="grid">
      <div>
        ${text("businessName", "Business name")}
        ${text("senderName", "Sender name", "The contractor's first name. Emails come from “Dusty at Sandhill Roofing.”")}
        ${text("phone", "Phone", "Appears in every email's signature.")}
        ${text("fromAddress", "From address", "Must be on a domain verified in Resend.", "email")}
        ${text("replyTo", "Reply-to address", "Where homeowner replies go. Usually the contractor's real inbox.", "email")}
        ${text("timezone", "Time zone", "For example America/Chicago or America/Denver.")}
      </div>
      <div>
        ${text("delayMinutes", "Minutes after the appointment ends", "", "number")}
        ${text("quietStart", "Quiet hours start", "24-hour time, like 20:00. Sends due during quiet hours wait until they end.")}
        ${text("quietEnd", "Quiet hours end", "Like 07:30. Set both to the same time to turn quiet hours off.")}
        ${text("estimateTurnaroundDays", "Estimate turnaround (business days)", "Used for the date promised in the inspection email.", "number")}
        ${check("estimatePhotos", "Estimates include photos")}
        ${check("installRequiresFinal", "Only send the job-complete email after the final install day")}
      </div>
    </div>
    ${text("reviewLink", "Google review link", "Used in the job-complete email. Leave empty to leave that line out.", "url")}
    ${text("warrantyNote", "Warranty note", "One sentence for the job-complete email. Leave empty to leave it out.")}
    <label for="keywords">Appointment keywords</label>
    <textarea id="keywords" name="keywords">${keywordLines(s.keywords)}</textarea>
    <p class="help">One per line as “keyword = type.” An event counts as an appointment when its title starts with a keyword. Types: ${APPOINTMENT_TYPES.join(", ")}.</p>
    <div class="grid">
      <div>
        <label for="ownEmails">The contractor's own addresses</label>
        <textarea id="ownEmails" name="ownEmails">${s.ownEmails.join("\n")}</textarea>
        <p class="help">Never treated as the homeowner. One per line.</p>
      </div>
      <div>
        <label for="ignoreDomains">Guest domains to ignore</label>
        <textarea id="ignoreDomains" name="ignoreDomains">${s.ignoreDomains.join("\n")}</textarea>
        <p class="help">For example an office manager's or a supplier's domain. One per line.</p>
      </div>
    </div>
    <div class="grid">
      <div>
        ${text("shadowEmail", "Shadow mode address", "When set, every email goes here instead of to the homeowner. Use it for the first week.", "email")}
        ${text("bccEmail", "BCC every email to", "", "email")}
      </div>
      <div>
        ${text("leadNotifyEmail", "Email new website leads to", "", "email")}
        ${text("allowedOrigin", "Client website origin", "Like https://sandhillroofing.com. Lets that site post leads from the browser.", "url")}
      </div>
    </div>
    <h2 style="margin-top:20px">Storm alerts</h2>
    <div class="grid">
      <div>
        ${check("stormEnabled", "Check customers' addresses for hail every morning")}
        ${text("stormThresholdInches", "Hail size that counts (inches)", "Radar estimate at or above this. 1 is about quarter size.")}
        ${text("stormSendStart", "Send storm emails from", "24-hour local time, like 09:00.")}
        ${text("stormSendEnd", "Until", "Like 18:00. Approvals after this wait for the next morning.")}
      </div>
      <div>
        ${text("stormNotifyEmail", "Morning summary goes to", "The contractor. Leave empty to use the reply-to address.", "email")}
        ${text("businessAddress", "Business postal address", "Printed in every storm email's footer. Required by CAN-SPAM.")}
        ${check("postcardsEnabled", "Offer postcards through Smartpress")}
        ${text("postcardOrderEmail", "Postcard orders go to", "Whoever places the Smartpress order.", "email")}
        ${text("postcardCost", "Cost per postcard ($)", "Shown to the contractor before he approves.")}
      </div>
    </div>
    <p><button>Save settings</button></p>
  </form>`;
}

export function readSettingsForm(body: Record<string, unknown>, current: ClientSettings): { settings: ClientSettings; errors: string[] } {
  const errors: string[] = [];
  const str = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  const list = (name: string) => str(name).split(/[\s,]+/).map((v) => v.toLowerCase()).filter(Boolean);
  const int = (name: string, label: string, min: number, max: number) => {
    const value = Number(str(name));
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${label} must be a whole number from ${min} to ${max}.`);
      return current[name as keyof ClientSettings] as number;
    }
    return value;
  };
  const time = (name: string, label: string) => {
    const value = str(name);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      errors.push(`${label} must look like 20:00.`);
      return current[name as keyof ClientSettings] as string;
    }
    return value;
  };
  const email = (name: string, label: string) => {
    const value = str(name).toLowerCase();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) errors.push(`${label} doesn't look like an email address.`);
    return value;
  };
  const decimal = (name: string, label: string, min: number, max: number) => {
    const value = Number(str(name));
    if (!str(name) || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${label} must be a number from ${min} to ${max}.`);
      return current[name as keyof ClientSettings] as number;
    }
    return value;
  };
  // Storm fields keep their current values when a form doesn't include them.
  const has = (name: string) => body[name] !== undefined;
  const stormForm = has("stormSendStart");

  const { keywords, errors: keywordErrors } = parseKeywordLines(str("keywords"));
  errors.push(...keywordErrors);
  if (Object.keys(keywords).length === 0) errors.push("Add at least one appointment keyword.");
  const timezone = str("timezone");
  if (!isValidZone(timezone)) errors.push(`Unknown time zone “${timezone}”.`);
  const allowedOrigin = str("allowedOrigin").replace(/\/+$/, "");
  if (allowedOrigin && !/^https?:\/\/[^/\s]+$/.test(allowedOrigin)) errors.push("Website origin must look like https://example.com.");

  const settings: ClientSettings = {
    ...current,
    businessName: str("businessName") || current.businessName,
    senderName: str("senderName"),
    phone: str("phone"),
    fromAddress: email("fromAddress", "From address"),
    replyTo: email("replyTo", "Reply-to address"),
    timezone,
    delayMinutes: int("delayMinutes", "Delay", 0, 24 * 60),
    quietStart: time("quietStart", "Quiet hours start"),
    quietEnd: time("quietEnd", "Quiet hours end"),
    estimateTurnaroundDays: int("estimateTurnaroundDays", "Estimate turnaround", 0, 30),
    estimatePhotos: body.estimatePhotos === "on",
    installRequiresFinal: body.installRequiresFinal === "on",
    reviewLink: str("reviewLink"),
    warrantyNote: str("warrantyNote"),
    keywords: keywords as Record<string, AppointmentType>,
    ownEmails: list("ownEmails"),
    ignoreDomains: list("ignoreDomains").map((d) => d.replace(/^@/, "")),
    shadowEmail: email("shadowEmail", "Shadow mode address"),
    bccEmail: email("bccEmail", "BCC address"),
    leadNotifyEmail: email("leadNotifyEmail", "Lead notification address"),
    allowedOrigin,
    stormEnabled: stormForm ? body.stormEnabled === "on" : current.stormEnabled,
    stormThresholdInches: stormForm ? decimal("stormThresholdInches", "Storm hail size", 0.5, 4) : current.stormThresholdInches,
    stormSendStart: stormForm ? time("stormSendStart", "Storm send start") : current.stormSendStart,
    stormSendEnd: stormForm ? time("stormSendEnd", "Storm send end") : current.stormSendEnd,
    stormNotifyEmail: stormForm ? email("stormNotifyEmail", "Storm summary address") : current.stormNotifyEmail,
    businessAddress: stormForm ? str("businessAddress") : current.businessAddress,
    postcardsEnabled: stormForm ? body.postcardsEnabled === "on" : current.postcardsEnabled,
    postcardOrderEmail: stormForm ? email("postcardOrderEmail", "Postcard order address") : current.postcardOrderEmail,
    postcardCost: stormForm ? decimal("postcardCost", "Postcard cost", 0, 10) : current.postcardCost,
  };
  if (settings.stormSendStart >= settings.stormSendEnd) errors.push("Storm emails need a send window that starts before it ends.");
  return { settings, errors };
}

function templatePage(deps: WebDeps, client: Client, type: TemplateType): Html {
  const template = deps.store.template(client.id, type);
  const sample = render(template, {
    first_name: "Linda",
    sender_name: client.settings.senderName || "Dusty",
    business_name: client.settings.businessName,
    phone: client.settings.phone || "(555) 010-0199",
    estimate_due: "Thursday, November 20",
    review_link: client.settings.reviewLink,
    warranty_note: client.settings.warrantyNote,
    estimate_photos: client.settings.estimatePhotos,
    street: "1418 Mesquite Ln",
    storm_day: "Tuesday",
    storm_date: "Tuesday, May 12",
  });
  const stormNote =
    type === "storm_email"
      ? html`<p class="help">The app adds a footer to every storm email with ${client.settings.businessAddress || "the business postal address"} and an unsubscribe link. It can't be edited out. Keep to the copy rules: no deductibles, no insurance promises, no public-adjuster claims, no urgency, and no hail size.</p>`
      : type === "storm_postcard"
        ? html`<p class="help">The subject is the postcard headline. Every card in a Smartpress batch uses this wording, rendered into the mailing list's Message column. Keep it short enough for the back of a 4×6 card, and keep to the storm email's copy rules.</p>`
        : "";
  return html`<p><a href="/clients/${client.id}">Back to ${client.name}</a></p>
    <section>
      <form method="post" action="/clients/${client.id}/templates/${type}">
        <label for="subject">Subject</label>
        <input type="text" id="subject" name="subject" value="${template.subject}" />
        <label for="body">Body</label>
        <textarea class="body" id="body" name="body">${template.body}</textarea>
        <p class="help">
          Variables: ${VARIABLES.map((v) => `{{${v}}}`).join(", ")}. Wrap a sentence in [[name: ...]] to include it only when that
          variable or the estimate_photos setting is set. Write plain text, and avoid “today,” since quiet hours can move a send to the next morning.
        </p>
        ${stormNote}
        <p><button>Save template</button></p>
      </form>
      ${template.custom
        ? html`<form method="post" action="/clients/${client.id}/templates/${type}/reset"><button class="quiet">Reset to default</button></form>`
        : html`<p class="muted">Using the default template.</p>`}
    </section>
    <section>
      <h2>Preview with sample values</h2>
      <p><strong>${sample.subject}</strong></p>
      <pre class="email">${sample.body}</pre>
    </section>`;
}
