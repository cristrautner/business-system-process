// Starts the web server and the background jobs.

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { GoogleCalendar, GoogleOAuth } from "./google.ts";
import { startScheduler } from "./jobs.ts";
import { DryRunMailer, ResendMailer } from "./mailer.ts";
import { Store } from "./store.ts";
import { createApp } from "./web/app.ts";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const config = loadConfig();
const db = openDb(config.databasePath);
const store = new Store(db);
const google = {
  clientId: config.googleClientId,
  clientSecret: config.googleClientSecret,
  redirectUri: `${config.appUrl}/oauth/google/callback`,
};
const mailer = config.dryRun ? new DryRunMailer(log) : new ResendMailer(config.resendApiKey);
const now = () => Date.now();

const app = createApp({
  store,
  oauth: new GoogleOAuth(google),
  mailer,
  tokenKey: config.tokenKey,
  appUrl: config.appUrl,
  adminUser: config.adminUser,
  adminPassword: config.adminPassword,
  now,
  log,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log(`listening on port ${info.port}${config.dryRun ? " (dry run: nothing is actually emailed)" : ""}`);
});

const stopScheduler = startScheduler(
  { store, calendar: new GoogleCalendar(google), mailer, tokenKey: config.tokenKey, now, log },
  config.pollIntervalSeconds,
  config.sendIntervalSeconds,
);

function shutdown(signal: string) {
  log(`${signal} received, shutting down`);
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
