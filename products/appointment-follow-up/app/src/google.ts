// Google sign-in (OAuth) and Calendar reads, over plain fetch.

import type { CalendarEvent } from "./rules.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Read-only access to calendar events, plus the account's email address for the dashboard. */
export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"];

export class GoogleAuthError extends Error {}

export interface CalendarApi {
  listEvents(refreshToken: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]>;
  /** Returns null when the event no longer exists. */
  getEvent(refreshToken: string, calendarId: string, eventId: string): Promise<CalendarEvent | null>;
}

export interface OAuthClient {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }>;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleOAuth implements OAuthClient {
  private readonly creds: Credentials;

  constructor(creds: Credentials) {
    this.creds = creds;
  }

  authUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.creds.clientId,
      redirect_uri: this.creds.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      // Always ask, so Google always returns a refresh token, even on a reconnect.
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        redirect_uri: this.creds.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = (await response.json()) as { refresh_token?: string; id_token?: string; scope?: string; error?: string };
    if (!response.ok || !data.refresh_token) {
      throw new GoogleAuthError(`Google sign-in failed: ${data.error ?? response.status}`);
    }
    if (!data.scope?.includes("calendar.events.readonly")) {
      throw new GoogleAuthError("Calendar access wasn't granted. Try again and leave the calendar box checked.");
    }
    return { refreshToken: data.refresh_token, email: emailFromIdToken(data.id_token) };
  }
}

function emailFromIdToken(idToken: string | undefined): string | null {
  // The ID token comes straight from Google's token endpoint over TLS, so reading its payload
  // without verifying the signature is fine for display purposes.
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export class GoogleCalendar implements CalendarApi {
  private readonly creds: Credentials;
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(creds: Credentials) {
    this.creds = creds;
  }

  private async accessToken(refreshToken: string): Promise<string> {
    const cached = this.accessTokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const data = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (data.error === "invalid_grant") {
      throw new GoogleAuthError("Google access was revoked or expired. Send the client a new connect link.");
    }
    if (!response.ok || !data.access_token) throw new Error(`Google token refresh failed: ${data.error ?? response.status}`);
    this.accessTokens.set(refreshToken, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  private async get(refreshToken: string, path: string): Promise<Response> {
    const token = await this.accessToken(refreshToken);
    return fetch(`${CALENDAR_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async listEvents(refreshToken: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "250",
        orderBy: "startTime",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.get(refreshToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
      if (!response.ok) throw new Error(`Google Calendar list failed: ${response.status} ${await response.text()}`);
      const data = (await response.json()) as { items?: CalendarEvent[]; nextPageToken?: string };
      events.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return events;
  }

  async getEvent(refreshToken: string, calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    const response = await this.get(
      refreshToken,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Google Calendar get failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as CalendarEvent;
  }
}
