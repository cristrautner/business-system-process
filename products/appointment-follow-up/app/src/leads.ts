// Validates submissions from a client's website form.

import { phoneDigits } from "./rules.ts";

export interface Lead {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  service: string;
  insuranceClaim: string | null;
  notes: string | null;
}

export type LeadResult = { ok: true; lead: Lead; phoneDigits: string } | { ok: false; spam: boolean; errors: string[] };

const REQUIRED: [keyof Lead, string, string][] = [
  ["firstName", "first_name", "First name"],
  ["lastName", "last_name", "Last name"],
  ["email", "email", "Email"],
  ["phone", "phone", "Phone"],
  ["street", "street", "Street address"],
  ["city", "city", "City"],
  ["state", "state", "State"],
  ["zip", "zip", "ZIP"],
  ["service", "service", "Service needed"],
];

const INSURANCE = new Set(["yes", "no", "not sure"]);

/** The field a real visitor never sees. Bots fill it in. */
export const HONEYPOT_FIELD = "website";

function field(input: Record<string, unknown>, name: string, max: number): string {
  const value = input[name];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseLead(input: Record<string, unknown>): LeadResult {
  if (field(input, HONEYPOT_FIELD, 500)) return { ok: false, spam: true, errors: [] };

  const errors: string[] = [];
  const values: Record<string, string> = {};
  for (const [key, name, label] of REQUIRED) {
    const value = field(input, name, 200);
    if (!value) errors.push(`${label} is required.`);
    values[key] = value;
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.push("Email doesn't look right.");
  const digits = phoneDigits(values.phone ?? "");
  if (values.phone && !digits) errors.push("Phone needs at least 10 digits.");

  const insurance = field(input, "insurance_claim", 20).toLowerCase();
  if (insurance && !INSURANCE.has(insurance)) errors.push("Insurance claim must be yes, no or not sure.");

  if (errors.length > 0) return { ok: false, spam: false, errors };
  return {
    ok: true,
    phoneDigits: digits,
    lead: {
      firstName: values.firstName!,
      lastName: values.lastName!,
      email: values.email!.toLowerCase(),
      phone: values.phone!,
      street: values.street!,
      city: values.city!,
      state: values.state!,
      zip: values.zip!,
      service: values.service!,
      insuranceClaim: insurance || null,
      notes: field(input, "notes", 2000) || null,
    },
  };
}

/** A small in-memory limit per client and address, so a bot can't flood a client's contacts. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
