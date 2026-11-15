// Page layout and small helpers for the server-rendered dashboard.

import { html } from "hono/html";
import { DateTime } from "luxon";

export type Html = ReturnType<typeof html>;

const STYLE = `
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --accent:#9a4b1c;
  --ok:#2f6b3a; --warn:#8a5a00; --bad:#a1281e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --panel:#1f1f1c; --text:#ecebe6; --muted:#a3a29b;
  --line:#34332f; --accent:#e08a52; --ok:#7ec08a; --warn:#e2b04f; --bad:#ef7d72; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
header.top { display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; margin-bottom: 16px; }
header.top a.home { color:var(--muted); text-decoration:none; }
h1 { font-size: 24px; margin: 0; } h2 { font-size: 18px; margin: 0 0 12px; }
a { color: var(--accent); }
section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin: 16px 0; overflow-x:auto; }
table { border-collapse: collapse; width: 100%; } th, td { text-align:left; padding: 6px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
.muted { color: var(--muted); } .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
.flash { padding: 10px 14px; border-radius: 8px; border:1px solid var(--line); background: var(--panel); margin: 12px 0; }
form.inline { display:inline; }
label { display:block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
label.check { font-weight: 400; display:flex; gap:8px; align-items:center; }
input[type=text], input[type=email], input[type=number], input[type=url], textarea, select {
  width: 100%; max-width: 560px; padding: 8px; border:1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
textarea { min-height: 120px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
textarea.body { min-height: 320px; max-width: 100%; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); }
pre.email { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 14px; font: inherit; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0 24px; }
.help { color: var(--muted); font-size: 13px; margin: 2px 0 0; max-width: 560px; }
`;

export function page(title: string, body: Html, flash?: string): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Follow-ups</title>
        <style>
          ${STYLE}
        </style>
      </head>
      <body>
        <main>
          <header class="top"><a class="home" href="/">Follow-ups</a><h1>${title}</h1></header>
          ${flash ? html`<div class="flash">${flash}</div>` : ""} ${body}
        </main>
      </body>
    </html>`;
}

/** A bare page for people outside the agency, like a contractor connecting their calendar. */
export function publicPage(title: string, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${STYLE}
        </style>
      </head>
      <body>
        <main style="max-width:560px">
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

export function when(ms: number | null | undefined, zone: string): string {
  if (!ms) return "never";
  return DateTime.fromMillis(ms, { zone }).setLocale("en-US").toFormat("ccc LLL d, h:mm a");
}
