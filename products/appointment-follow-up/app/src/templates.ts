// Email templates. Defaults come from templates.md; each client can override any of them.
//
// Syntax:
//   {{variable}}             replaced with the value, or nothing if it's empty
//   [[name: some text]]      kept only when the variable or setting `name` is set
// Blank lines left behind by empty optional parts are collapsed.

import type { TemplateType } from "./settings.ts";

export interface Template {
  subject: string;
  body: string;
}

export const TEMPLATE_LABELS: Record<TemplateType, string> = {
  inspection: "Inspection",
  estimate: "Estimate review",
  adjuster: "Adjuster meeting",
  job_complete: "Job complete",
  general: "General appointment",
  storm_email: "Storm alert email",
  storm_postcard: "Storm alert postcard",
};

export const VARIABLES = [
  "first_name",
  "sender_name",
  "business_name",
  "phone",
  "estimate_due",
  "review_link",
  "warranty_note",
  "street",
  "storm_day",
  "storm_date",
] as const;

export const FLAGS = ["estimate_photos"] as const;

const SIGNATURE = "{{sender_name}}\n{{business_name}}\n{{phone}}";

export const DEFAULT_TEMPLATES: Record<TemplateType, Template> = {
  inspection: {
    subject: "Your roof inspection with {{business_name}}",
    body: `Hi {{first_name}},

Thanks for having me out to look at your roof. I appreciate you making the time.

Here's what happens next: I'll put together your written estimate and have it to you by {{estimate_due}}.[[estimate_photos: It'll include photos of what I found, so you can see what I saw up there.]]

If any questions come up before then, just reply to this email or call me at {{phone}}.

Thanks again,
${SIGNATURE}`,
  },
  estimate: {
    subject: "Thanks for going over the estimate with me",
    body: `Hi {{first_name}},

Thanks for sitting down with me to go over your estimate. A new roof is a big decision, and I don't want you to feel rushed.

If anything in the estimate isn't clear, reply here or call me at {{phone}} and I'll walk through it again. When you're ready to move forward, same thing: let me know and we'll get you on the schedule.

Thanks,
${SIGNATURE}`,
  },
  adjuster: {
    subject: "Next steps after the adjuster visit",
    body: `Hi {{first_name}},

Thanks for having me there when the adjuster came out.

The next step is on the insurance side. Your insurance company will send you a written summary of what they're covering. When it arrives, forward it to me or text a photo of it to {{phone}}, and I'll go over it with you so you know exactly what it means for your roof.

Thanks,
${SIGNATURE}`,
  },
  job_complete: {
    subject: "Thanks for trusting us with your roof",
    body: `Hi {{first_name}},

Thanks for trusting {{business_name}} with your roof. We should be all wrapped up, but if you spot anything we missed during cleanup, a stray nail or anything else, call me at {{phone}} and we'll come back out.

[[warranty_note:{{warranty_note}}]]

[[review_link:If you're happy with the work, a quick Google review helps a small local company like ours more than you'd think: {{review_link}}]]

Thanks again,
${SIGNATURE}`,
  },
  // Storm alerts. The copy rules in products/storm-alert/spec.md apply: no deductibles, no insurance promises,
  // no public-adjuster claims, no urgency, and no hail size (a radar estimate isn't a claim about their roof).
  // The email footer with the postal address and unsubscribe link is added by the app and can't be edited out.
  storm_email: {
    subject: "Hail near your home on {{storm_day}}",
    body: `Hi {{first_name}},

Weather radar showed hail passing near {{street}} on {{storm_day}}. Hail can damage shingles without leaving anything you'd notice from the ground.

If you'd like us to take a look, reply to this email or call {{phone}} and we'll set up a time. There's no charge to check.

{{sender_name}}
{{business_name}}`,
  },
  // Postcards: the subject is the headline. Keep the body short enough for the back of a 4×6 card.
  storm_postcard: {
    subject: "Hail came through your neighborhood",
    body: `Hi {{first_name}},

Weather radar showed hail passing near {{street}} on {{storm_date}}. Hail can damage shingles without leaving anything you'd notice from the ground.

If you'd like us to take a look, call {{phone}}. There's no charge to check.

{{sender_name}}, {{business_name}}`,
  },
  general: {
    subject: "Thanks for your time",
    body: `Hi {{first_name}},

Thanks for having me out. If any questions come up, just reply to this email or call me at {{phone}}.

Thanks,
${SIGNATURE}`,
  },
};

export type TemplateValues = Partial<Record<(typeof VARIABLES)[number] | (typeof FLAGS)[number], string | boolean>>;

function present(value: string | boolean | undefined): boolean {
  return typeof value === "boolean" ? value : Boolean(value && value.trim());
}

function fill(text: string, values: TemplateValues): string {
  const withOptional = text.replace(/\[\[(\w+):([\s\S]*?)\]\]/g, (_, name: string, inner: string) =>
    present(values[name as keyof TemplateValues]) ? inner : "",
  );
  return withOptional.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = values[name as keyof TemplateValues];
    return typeof value === "string" ? value : "";
  });
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function render(template: Template, values: TemplateValues): Template {
  const withGreeting: TemplateValues = { ...values, first_name: present(values.first_name) ? values.first_name : "there" };
  return {
    subject: tidy(fill(template.subject, withGreeting)).replace(/\s+/g, " "),
    body: tidy(fill(template.body, withGreeting)),
  };
}

/** Variable names used in a template that the app doesn't know, so the editor can warn. */
export function unknownNames(template: Template): string[] {
  const known = new Set<string>([...VARIABLES, ...FLAGS]);
  const text = `${template.subject}\n${template.body}`;
  const names = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}|\[\[(\w+):/g)].map((m) => m[1] ?? m[2]!);
  return [...new Set(names.filter((name) => !known.has(name)))];
}
