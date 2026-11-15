import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { decrypt } from "../src/crypto.ts";
import { openDb } from "../src/db.ts";
import type { OAuthClient } from "../src/google.ts";
import { DryRunMailer } from "../src/mailer.ts";
import { Store, type Client } from "../src/store.ts";
import { createApp } from "../src/web/app.ts";

const APP_URL = "https://followup.agency.example";
const AUTH = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };
const FROM_DASHBOARD = { ...AUTH, origin: APP_URL };

class FakeOAuth implements OAuthClient {
  lastState = "";
  authUrl(state: string): string {
    this.lastState = state;
    return `https://accounts.google.example/auth?state=${state}`;
  }
  async exchangeCode(code: string) {
    if (code !== "good-code") throw new Error("bad code");
    return { refreshToken: "refresh-123", email: "dusty@gmail.example" };
  }
}

describe("web", () => {
  let store: Store;
  let oauth: FakeOAuth;
  let mailer: DryRunMailer;
  let client: Client;
  let clock: number;
  const tokenKey = randomBytes(32);
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new Store(openDb(":memory:"));
    oauth = new FakeOAuth();
    mailer = new DryRunMailer(() => {});
    clock = Date.parse("2026-11-16T18:00:00Z");
    client = store.createClient("Sandhill Roofing", "sandhill", clock);
    app = createApp({
      store, oauth, mailer, tokenKey, appUrl: APP_URL, adminUser: "admin", adminPassword: "secret", now: () => clock, log: () => {},
    });
  });

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  it("requires the login for the dashboard but not for health checks", async () => {
    assert.equal((await app.request("/")).status, 401);
    assert.equal((await app.request("/", { headers: AUTH })).status, 200);
    assert.equal((await app.request("/healthz")).status, 200);
  });

  it("rejects dashboard posts from other sites", async () => {
    const res = await app.request(`/clients/${client.id}/pause`, { method: "POST", headers: { ...AUTH, origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(store.client(client.id)?.paused, false);
    const ok = await app.request(`/clients/${client.id}/pause`, { method: "POST", headers: FROM_DASHBOARD });
    assert.equal(ok.status, 303);
    assert.equal(store.client(client.id)?.paused, true);
  });

  it("connects a Google account through the public link", async () => {
    const page = await app.request(`/connect/${client.connectToken}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Connect Google Calendar/);

    const res = await app.request(`/oauth/google/callback?code=good-code&state=${encodeURIComponent(oauth.lastState)}`);
    assert.match(await res.text(), /connected as dusty@gmail\.example/);
    const connection = store.connection(client.id);
    assert.equal(connection?.googleEmail, "dusty@gmail.example");
    assert.equal(decrypt(connection!.refreshTokenEnc, tokenKey), "refresh-123");
    assert.equal((await app.request(`/connect/${client.connectToken}`)).status, 404, "the link works once");
  });

  it("rejects a forged or expired sign-in state", async () => {
    await app.request(`/connect/${client.connectToken}`);
    const forged = oauth.lastState.replace(/\.[^.]+$/, ".forged");
    assert.equal((await app.request(`/oauth/google/callback?code=good-code&state=${forged}`)).status, 400);
    clock += 31 * 60 * 1000;
    assert.equal((await app.request(`/oauth/google/callback?code=good-code&state=${oauth.lastState}`)).status, 400);
    assert.equal(store.connection(client.id), undefined);
  });

  it("ignores an unknown connect link", async () => {
    assert.equal((await app.request("/connect/nope")).status, 404);
  });

  describe("leads", () => {
    const lead = {
      first_name: "Linda", last_name: "Smith", email: "Linda@Example.com", phone: "(555) 222-3333",
      street: "1 Oak St", city: "Austin", state: "TX", zip: "78701", service: "inspection", insurance_claim: "Not sure",
    };

    it("needs a valid key", async () => {
      const res = await app.request("/api/leads", { method: "POST", body: form(lead) });
      assert.equal(res.status, 401);
    });

    it("stores a contact from a form post", async () => {
      const res = await app.request("/api/leads", { method: "POST", body: form({ ...lead, api_key: client.leadApiKey }) });
      assert.equal(res.status, 201);
      const [contact] = store.contacts(client.id);
      assert.equal(contact?.email, "linda@example.com");
      assert.equal(contact?.lastName, "Smith");
      assert.equal(contact?.insuranceClaim, "not sure");
    });

    it("accepts JSON with the key in a header, and updates the same contact", async () => {
      const post = (body: object) =>
        app.request("/api/leads", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": client.leadApiKey },
          body: JSON.stringify(body),
        });
      assert.equal((await post(lead)).status, 201);
      assert.equal((await post({ ...lead, street: "2 Elm St" })).status, 201);
      const contacts = store.contacts(client.id);
      assert.equal(contacts.length, 1);
      assert.equal(contacts[0]?.street, "2 Elm St");
    });

    it("lists missing fields", async () => {
      const res = await app.request("/api/leads", { method: "POST", body: form({ api_key: client.leadApiKey, first_name: "Linda" }) });
      assert.equal(res.status, 422);
      const body = (await res.json()) as { errors: string[] };
      assert.ok(body.errors.includes("Last name is required."));
      assert.equal(store.contacts(client.id).length, 0);
    });

    it("quietly drops bot submissions", async () => {
      const res = await app.request("/api/leads", { method: "POST", body: form({ ...lead, website: "http://spam.example", api_key: client.leadApiKey }) });
      assert.equal(res.status, 201);
      assert.equal(store.contacts(client.id).length, 0);
    });

    it("redirects to the client's thank-you page and allows its origin", async () => {
      store.saveSettings(client.id, { ...client.settings, allowedOrigin: "https://sandhillroofing.example" });
      const res = await app.request("/api/leads", {
        method: "POST",
        headers: { origin: "https://sandhillroofing.example" },
        body: form({ ...lead, api_key: client.leadApiKey, redirect: "https://sandhillroofing.example/thanks" }),
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "https://sandhillroofing.example/thanks");
      assert.equal(res.headers.get("access-control-allow-origin"), "https://sandhillroofing.example");
    });

    it("won't redirect anywhere else", async () => {
      store.saveSettings(client.id, { ...client.settings, allowedOrigin: "https://sandhillroofing.example" });
      const res = await app.request("/api/leads", { method: "POST", body: form({ ...lead, api_key: client.leadApiKey, redirect: "https://evil.example" }) });
      assert.equal(res.status, 201);
    });

    it("emails the contractor about new leads when set up", async () => {
      store.saveSettings(client.id, { ...client.settings, fromAddress: "dusty@sandhillroofing.example", leadNotifyEmail: "dusty@gmail.example" });
      await app.request("/api/leads", { method: "POST", body: form({ ...lead, api_key: client.leadApiKey }) });
      assert.equal(mailer.sent.length, 1);
      assert.equal(mailer.sent[0]?.subject, "New website lead: Linda Smith");
      assert.equal(mailer.sent[0]?.replyTo, "linda@example.com");
    });

    it("rate-limits a flood", async () => {
      let last = 0;
      for (let i = 0; i < 12; i++) {
        last = (await app.request("/api/leads", { method: "POST", body: form({ ...lead, api_key: client.leadApiKey }) })).status;
      }
      assert.equal(last, 429);
    });
  });

  describe("settings and templates", () => {
    const settingsForm = {
      businessName: "Sandhill Roofing", senderName: "Dusty", phone: "(555) 010-0199", fromAddress: "dusty@sandhillroofing.example",
      replyTo: "dusty@gmail.example", timezone: "America/Chicago", delayMinutes: "120", quietStart: "20:00", quietEnd: "07:30",
      estimateTurnaroundDays: "3", estimatePhotos: "on", installRequiresFinal: "on", reviewLink: "", warrantyNote: "",
      keywords: "inspection = inspection\ninsp = inspection\nestimate = estimate", ownEmails: "Dusty@SandhillRoofing.example",
      ignoreDomains: "@officehelp.example", shadowEmail: "", bccEmail: "", leadNotifyEmail: "", allowedOrigin: "https://sandhillroofing.example/",
    };

    it("saves valid settings", async () => {
      const res = await app.request(`/clients/${client.id}/settings`, { method: "POST", headers: FROM_DASHBOARD, body: form(settingsForm) });
      assert.equal(res.status, 303);
      const s = store.client(client.id)!.settings;
      assert.equal(s.senderName, "Dusty");
      assert.equal(s.estimateTurnaroundDays, 3);
      assert.equal(s.estimatePhotos, true);
      assert.deepEqual(s.keywords, { inspection: "inspection", insp: "inspection", estimate: "estimate" });
      assert.deepEqual(s.ownEmails, ["dusty@sandhillroofing.example"]);
      assert.deepEqual(s.ignoreDomains, ["officehelp.example"]);
      assert.equal(s.allowedOrigin, "https://sandhillroofing.example");
    });

    it("refuses invalid settings and says why", async () => {
      const res = await app.request(`/clients/${client.id}/settings`, {
        method: "POST", headers: FROM_DASHBOARD, body: form({ ...settingsForm, timezone: "Mars/Olympus", quietStart: "8pm" }),
      });
      const message = decodeURIComponent(res.headers.get("location") ?? "");
      assert.match(message, /Not saved\./);
      assert.match(message, /20:00/);
      assert.match(message, /Mars\/Olympus/);
      assert.equal(store.client(client.id)!.settings.senderName, "");
    });

    it("saves a template and refuses unknown variables", async () => {
      const path = `/clients/${client.id}/templates/inspection`;
      const bad = await app.request(path, { method: "POST", headers: FROM_DASHBOARD, body: form({ subject: "Hi", body: "Hi {{frist_name}}" }) });
      assert.match(decodeURIComponent(bad.headers.get("location") ?? ""), /Unknown names: frist_name/);
      await app.request(path, { method: "POST", headers: FROM_DASHBOARD, body: form({ subject: "Thanks", body: "Hi {{first_name}}" }) });
      assert.equal(store.template(client.id, "inspection").custom, true);
      const page = await app.request(path, { headers: AUTH });
      assert.match(await page.text(), /Hi Linda/);
      await app.request(`${path}/reset`, { method: "POST", headers: FROM_DASHBOARD });
      assert.equal(store.template(client.id, "inspection").custom, false);
    });

    it("renders the client page", async () => {
      const res = await app.request(`/clients/${client.id}`, { headers: AUTH });
      const text = await res.text();
      assert.match(text, /Needs setup before anything sends/);
      assert.match(text, new RegExp(`/connect/${client.connectToken}`));
    });

    it("escapes what it shows", async () => {
      store.saveSettings(client.id, { ...client.settings, businessName: "<script>alert(1)</script>" });
      const text = await (await app.request(`/clients/${client.id}`, { headers: AUTH })).text();
      assert.doesNotMatch(text, /<script>alert/);
    });
  });
});
