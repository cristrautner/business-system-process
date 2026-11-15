// Reads settings from environment variables. See .env.example for what each one does.

export interface Config {
  appUrl: string;
  port: number;
  databasePath: string;
  adminUser: string;
  adminPassword: string;
  tokenKey: Buffer;
  googleClientId: string;
  googleClientSecret: string;
  resendApiKey: string;
  pollIntervalSeconds: number;
  sendIntervalSeconds: number;
  dryRun: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenKey = Buffer.from(required(env, "TOKEN_KEY"), "base64");
  if (tokenKey.length !== 32) {
    throw new Error("TOKEN_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32");
  }
  return {
    appUrl: required(env, "APP_URL").replace(/\/+$/, ""),
    port: number(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH?.trim() || "data/app.db",
    adminUser: required(env, "ADMIN_USER"),
    adminPassword: required(env, "ADMIN_PASSWORD"),
    tokenKey,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    resendApiKey: required(env, "RESEND_API_KEY"),
    pollIntervalSeconds: number(env, "POLL_INTERVAL_SECONDS", 300),
    sendIntervalSeconds: number(env, "SEND_INTERVAL_SECONDS", 60),
    // Defaults to on. Nothing goes to a homeowner until someone sets DRY_RUN=false on purpose.
    dryRun: (env.DRY_RUN?.trim().toLowerCase() ?? "true") !== "false",
  };
}
