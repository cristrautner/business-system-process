// Per-client settings, stored as JSON on the clients row.

export const APPOINTMENT_TYPES = ["inspection", "estimate", "adjuster", "install", "repair", "general"] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

export const TEMPLATE_TYPES = ["inspection", "estimate", "adjuster", "job_complete", "general", "storm_email", "storm_postcard"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export function templateFor(type: AppointmentType): TemplateType {
  return type === "install" || type === "repair" ? "job_complete" : type;
}

export interface ClientSettings {
  businessName: string;
  senderName: string;
  phone: string;
  /** Verified sender address on the client's domain in Resend, e.g. dusty@sandhillroofing.com */
  fromAddress: string;
  /** Where homeowner replies go. Usually the contractor's real inbox. */
  replyTo: string;
  timezone: string;
  delayMinutes: number;
  quietStart: string;
  quietEnd: string;
  estimateTurnaroundDays: number;
  estimatePhotos: boolean;
  reviewLink: string;
  warrantyNote: string;
  /** First word of an event title (lowercase) mapped to an appointment type. */
  keywords: Record<string, AppointmentType>;
  /** The contractor's own addresses, never treated as the homeowner. */
  ownEmails: string[];
  /** Guest domains to ignore, e.g. an office manager's or a supplier's. */
  ignoreDomains: string[];
  /** Only send the job-complete email after the final day of an install. */
  installRequiresFinal: boolean;
  /** Shadow mode: when set, every email goes here instead of to the homeowner. */
  shadowEmail: string;
  bccEmail: string;
  leadNotifyEmail: string;
  /** The client's website origin, allowed to post leads from the browser. */
  allowedOrigin: string;

  // Storm alerts
  stormEnabled: boolean;
  /** Radar hail estimate, in inches, at or above which a customer counts as hit. */
  stormThresholdInches: number;
  /** Homeowner storm emails go out only between these local times. */
  stormSendStart: string;
  stormSendEnd: string;
  /** Who gets the morning-after summary and review link. Falls back to the reply-to address. */
  stormNotifyEmail: string;
  /** Postal address for the footer of every storm email. CAN-SPAM requires one. */
  businessAddress: string;
  postcardsEnabled: boolean;
  /** Who places the Smartpress order when a contractor asks for postcards. */
  postcardOrderEmail: string;
  /** Rough cost per postcard, shown to the contractor before he approves. */
  postcardCost: number;
}

export const DEFAULT_KEYWORDS: Record<string, AppointmentType> = {
  inspection: "inspection",
  estimate: "estimate",
  adjuster: "adjuster",
  install: "install",
  repair: "repair",
  appointment: "general",
};

export function defaultSettings(name: string): ClientSettings {
  return {
    businessName: name,
    senderName: "",
    phone: "",
    fromAddress: "",
    replyTo: "",
    timezone: "America/Chicago",
    delayMinutes: 120,
    quietStart: "20:00",
    quietEnd: "07:30",
    estimateTurnaroundDays: 2,
    estimatePhotos: false,
    reviewLink: "",
    warrantyNote: "",
    keywords: { ...DEFAULT_KEYWORDS },
    ownEmails: [],
    ignoreDomains: [],
    installRequiresFinal: true,
    shadowEmail: "",
    bccEmail: "",
    leadNotifyEmail: "",
    allowedOrigin: "",
    stormEnabled: false,
    stormThresholdInches: 1,
    stormSendStart: "09:00",
    stormSendEnd: "18:00",
    stormNotifyEmail: "",
    businessAddress: "",
    postcardsEnabled: false,
    postcardOrderEmail: "",
    postcardCost: 0.85,
  };
}

export function parseSettings(json: string, name: string): ClientSettings {
  const stored = JSON.parse(json || "{}") as Partial<ClientSettings>;
  return { ...defaultSettings(name), ...stored, keywords: stored.keywords ?? { ...DEFAULT_KEYWORDS } };
}

/** Reasons a client can't send yet. Empty means ready. */
export function readinessProblems(s: ClientSettings): string[] {
  const problems: string[] = [];
  if (!s.fromAddress) problems.push("No sender address. Add one verified in Resend.");
  if (!s.senderName) problems.push("No sender name.");
  if (!s.phone) problems.push("No phone number for the email signature.");
  if (!isValidZone(s.timezone)) problems.push(`Unknown time zone “${s.timezone}”.`);
  return problems;
}

/** Reasons storm alerts can't run for this client yet. Empty means ready. */
export function stormReadinessProblems(s: ClientSettings): string[] {
  const problems = readinessProblems(s);
  if (!s.businessAddress) problems.push("No business postal address. Storm emails are marketing, and CAN-SPAM requires one.");
  if (!s.stormNotifyEmail && !s.replyTo) problems.push("No address for the morning storm summary.");
  if (s.postcardsEnabled && !s.postcardOrderEmail) problems.push("Postcards are on but nobody is set to place the Smartpress order.");
  return problems;
}

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Parses "keyword = type" lines from the settings form. */
export function parseKeywordLines(text: string): { keywords: Record<string, AppointmentType>; errors: string[] } {
  const keywords: Record<string, AppointmentType> = {};
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [left, right] = line.split("=").map((part) => part?.trim().toLowerCase());
    if (!left || !right) {
      errors.push(`Couldn't read “${line}”. Use “keyword = type”.`);
      continue;
    }
    if (!(APPOINTMENT_TYPES as readonly string[]).includes(right)) {
      errors.push(`Unknown type “${right}”. Use one of: ${APPOINTMENT_TYPES.join(", ")}.`);
      continue;
    }
    keywords[left] = right as AppointmentType;
  }
  return { keywords, errors };
}

export function keywordLines(keywords: Record<string, AppointmentType>): string {
  return Object.entries(keywords)
    .map(([keyword, type]) => `${keyword} = ${type}`)
    .join("\n");
}
