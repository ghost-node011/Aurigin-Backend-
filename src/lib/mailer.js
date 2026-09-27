import nodemailer from "nodemailer";

// Outgoing mail goes through Gmail SMTP. Gmail only accepts an App Password
// here (Google Account → Security → 2-Step Verification → App passwords),
// never the account's normal password.
let transport = null;

export function mailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  transport ??= nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

/** Portal base URL for links in emails, e.g. https://people.auriginmedia.com */
export function appUrl(path = "/") {
  const base = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");
  return base + path;
}

const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The shared email layout. `rows` are label/value pairs shown as a small
 * table; `action` is the button linking into the portal. Everything passed
 * in is escaped — callers pass plain text.
 */
export function renderEmail({ heading, intro, rows = [], quote, action }) {
  const rowsHtml = rows
    .filter(([, v]) => v != null && v !== "")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#64748b;white-space:nowrap;vertical-align:top">${escape(k)}</td><td style="padding:4px 0;color:#0f172a">${escape(v)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#013fd2;font-size:15px">Aurigin People</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#0f172a">${escape(heading)}</h1>
${intro ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155">${escape(intro)}</p>` : ""}
${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px">${rowsHtml}</table>` : ""}
${quote ? `<div style="margin:0 0 16px;padding:12px 14px;background:#f1f5f9;border-radius:8px;font-size:14px;line-height:1.6;color:#334155;white-space:pre-wrap">${escape(quote)}</div>` : ""}
${action ? `<a href="${escape(action.url)}" style="display:inline-block;background:#013fd2;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">${escape(action.label)}</a>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">You're getting this because of your role on this item in the Aurigin People portal.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    heading,
    intro,
    rows
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
    quote,
    action ? `${action.label}: ${action.url}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { html, text };
}

/**
 * Sends one email. Never throws: a mail failure is logged and reported as
 * `false`, because the action that triggered it (a leave request, a new
 * issue) has already succeeded and shouldn't fail because of email.
 */
export async function sendMail({ to, subject, html, text, replyTo }) {
  const recipients = [...new Set([to].flat().filter(Boolean))];
  if (recipients.length === 0) return false;
  if (!mailConfigured()) {
    console.log(`[mail skipped — SMTP not configured] ${subject} → ${recipients.join(", ")}`);
    return false;
  }
  try {
    await Promise.race([
      getTransport().sendMail({
        from: `"Aurigin People" <${process.env.SMTP_USER}>`,
        to: recipients,
        replyTo,
        subject,
        html,
        text,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timed out")), 15_000)),
    ]);
    return true;
  } catch (err) {
    console.error(`Mail failed (${subject}):`, err.message);
    return false;
  }
}
