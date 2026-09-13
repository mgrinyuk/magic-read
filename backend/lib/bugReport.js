// Bug reports: which details the app may attach, and the email sent to support.

const CONTEXT_FIELDS = [
  "platform",
  "appVersion",
  "appBuild",
  "webBuild",
  "uiLang",
  "learningLang",
  "plan",
  "viewport",
  "timezone",
  "userAgent"
];

export const MAX_REPORT_LENGTH = 5000;

// Keep only known fields, as short strings — the context is client-supplied.
export function sanitizeReportContext(raw) {
  const context = {};
  if (!raw || typeof raw !== "object") return context;
  for (const key of CONTEXT_FIELDS) {
    const value = raw[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim().slice(0, 300);
    if (text) context[key] = text;
  }
  return context;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildBugReportEmail({ reportId, email, userId, message, context = {} }) {
  const firstLine = message.split("\n").find(line => line.trim()) || "";
  const where = [context.platform, context.appVersion].filter(Boolean).join(" ");
  const subject = `Bug report${where ? ` (${where})` : ""}: ${firstLine.replace(/\s+/g, " ").trim().slice(0, 70)}`;

  const details = [
    ["From", email || "unknown"],
    ["User ID", userId || "unknown"],
    ["Report ID", reportId || "not saved"],
    ...Object.entries(context)
  ];

  const text = `${message}\n\n---\n${details.map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">
<p style="white-space:pre-wrap">${escapeHtml(message)}</p>
<hr style="border:none;border-top:1px solid #ddd">
<table style="font-size:13px;color:#555">${details
    .map(([key, value]) => `<tr><td style="padding-right:12px"><b>${escapeHtml(key)}</b></td><td>${escapeHtml(value)}</td></tr>`)
    .join("")}</table>
</div>`;

  return { subject, text, html };
}
