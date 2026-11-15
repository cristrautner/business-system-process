// Sends email through Resend, or pretends to in dry-run mode.

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string;
  bcc?: string;
  subject: string;
  text: string;
  /** The same key never sends twice, even if the app crashes between sending and recording. */
  idempotencyKey: string;
  /** Extra headers, like List-Unsubscribe on storm emails. */
  headers?: Record<string, string>;
}

export interface Mailer {
  readonly dryRun: boolean;
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export class ResendMailer implements Mailer {
  readonly dryRun = false;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo || undefined,
        bcc: email.bcc ? [email.bcc] : undefined,
        subject: email.subject,
        // Plain text only: these should read like a personal note.
        text: email.text,
        headers: email.headers && Object.keys(email.headers).length ? email.headers : undefined,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!response.ok || !data.id) {
      throw new Error(`Resend rejected the email: ${data.message ?? data.name ?? response.status}`);
    }
    return { id: data.id };
  }
}

export class DryRunMailer implements Mailer {
  readonly dryRun = true;
  readonly sent: OutgoingEmail[] = [];
  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void = console.log) {
    this.log = log;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    this.sent.push(email);
    this.log(`[dry run] would send “${email.subject}” to ${email.to}`);
    return { id: `dry-run-${this.sent.length}` };
  }
}

/** Builds a From header like: "Dusty at Sandhill Roofing" <dusty@sandhillroofing.com> */
export function fromHeader(senderName: string, businessName: string, address: string): string {
  const name = [senderName, businessName].filter(Boolean).join(" at ").replace(/["<>\r\n]/g, "");
  return name ? `"${name}" <${address}>` : address;
}
