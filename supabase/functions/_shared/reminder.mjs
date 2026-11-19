// Reconstructed location-reminder and location-reminder-wife.
// The deployed source could not be downloaded. Behavior that was observed is
// marked below; everything else is an assumption and is listed in
// docs/reminder-assumptions.md so it can be compared with the dashboard copy.

import { MAIL_FROM } from "./mail-from.mjs";
import { createSupabaseDb, restHeaders, timingSafeEqual } from "./tracker-logic.mjs";

export const REMINDER_HEADER = "x-reminder-secret";
export const DEFAULT_TIME_ZONE = "America/New_York";
export const DEFAULT_SEND_HOUR = 8;

export const PAGE_ORIGINS = {
  jon: "https://location-tracker-sand-six.vercel.app",
  amy: "https://location-tracker-wife.vercel.app",
};

export function localParts(nowMs, timeZone) {
  const bag = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs))) {
    bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    hour,
    date: `${bag.year}-${bag.month}-${bag.day}`,
  };
}

export function parseSendHour(raw) {
  if (raw == null || raw === "") return DEFAULT_SEND_HOUR;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return DEFAULT_SEND_HOUR;
  return hour;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function reminderMessage({ person, date, today }) {
  const page = `${PAGE_ORIGINS[person]}/?date=${date}`;
  const logged = today
    ? `${date} is already logged as ${today.location}.`
    : `${date} is not logged yet.`;
  const html = `<p>Time to log your location.</p><p>${escapeHtml(logged)}</p><p><a href="${page}">Open ${date}</a></p>`;
  return {
    subject: "Log your location",
    html,
    page,
  };
}

async function sendReminderEmail(env, fetchImpl, message) {
  const key = env("RESEND_API_KEY");
  if (!key) {
    const err = new Error("email is not configured");
    err.status = 503;
    throw err;
  }
  const text = reminderMessage(message);
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [message.to],
      subject: text.subject,
      html: text.html,
    }),
  });
  if (!res.ok) {
    const err = new Error("email could not be sent");
    err.status = 502;
    throw err;
  }
}

export function createReminderHandler(person, deps) {
  const full = {
    env: deps.env,
    now: deps.now,
    db: deps.db || createSupabaseDb(deps.env, deps.fetch),
    sendReminder: deps.sendReminder || ((message) => sendReminderEmail(deps.env, deps.fetch, message)),
  };
  return (req) => handleReminder(person, req, full);
}

export async function handleReminder(person, req, deps) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-headers": "authorization, content-type, x-reminder-secret",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const secret = deps.env("REMINDER_CRON_SECRET") || "";
  if (secret.length < 16) return json({ error: "Reminder secret is not configured." }, 503);
  const presented = req.headers.get(REMINDER_HEADER) || "";
  if (!timingSafeEqual(presented, secret)) return json({ error: "Unauthorized." }, 401);

  const timeZone = deps.env("REMINDER_TIMEZONE") || DEFAULT_TIME_ZONE;
  const settings = await deps.db.getSettings(person, ["email_address", "location_email_hour"]);
  const hr = parseSendHour(settings.location_email_hour);
  const { hour, date } = localParts(deps.now(), timeZone);
  if (hour !== hr) return json({ skipped: true, now: hour, hr }, 200);

  const email = settings.email_address || "";
  if (!email || email === "your@email.com") {
    return json({ skipped: true, now: hour, hr, reason: "no-email" }, 200);
  }
  const entries = await deps.db.listEntries(person);
  const today = (entries || []).find((row) => String(row.date).slice(0, 10) === date) || null;
  await deps.sendReminder({ to: email, person, date, today });
  return json({ ok: true, sent: true, now: hour, hr }, 200);
}

export function reminderRestIgnoresCaller(env) {
  return restHeaders(env);
}
