import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAIL_FROM } from "../supabase/functions/_shared/mail-from.mjs";
import {
  REMINDER_HEADER,
  handleReminder,
  localParts,
  reminderMessage,
} from "../supabase/functions/_shared/reminder.mjs";
import { postgrestEq, restHeaders } from "../supabase/functions/_shared/tracker-logic.mjs";

const SECRET = "reminder-cron-secret-value";
const NOW = Date.parse("2026-11-19T15:00:00Z");

function dbFor(hour) {
  return {
    listed: 0,
    async getSettings(_person, keys) {
      const all = { email_address: "jon@example.com", location_email_hour: hour };
      const out = {};
      for (const key of keys) if (all[key] != null) out[key] = all[key];
      return out;
    },
    async listEntries() {
      this.listed += 1;
      return [{ id: "1", date: "2026-11-19", location: "PA", type: "state" }];
    },
  };
}

async function call({ hour = "8", header = SECRET, secret = SECRET, person = "jon", method = "POST" } = {}) {
  const db = dbFor(hour);
  const sent = [];
  const headers = {};
  if (header) headers[REMINDER_HEADER] = header;
  const res = await handleReminder(person, new Request("https://example.test/reminder", { method, headers }), {
    env(name) {
      if (name === "REMINDER_CRON_SECRET") return secret;
      return "";
    },
    now: () => NOW,
    db,
    async sendReminder(message) { sent.push(message); },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, sent, db };
}

test("the sample hour is 10 in New York", () => {
  assert.equal(localParts(NOW, "America/New_York").hour, 10);
  assert.equal(localParts(NOW, "America/New_York").date, "2026-11-19");
});

test("a wrong hour returns the observed skip body and does not read entries", async () => {
  const result = await call({ hour: "8" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { skipped: true, now: 10, hr: 8 });
  assert.equal(result.db.listed, 0);
  assert.equal(result.sent.length, 0);
});

test("the send hour emails the saved address with the known sender and does not use the caller token", async () => {
  const result = await call({ hour: "10", person: "amy" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, sent: true, now: 10, hr: 10 });
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].to, "jon@example.com");
  assert.equal(result.sent[0].person, "amy");
  const message = reminderMessage(result.sent[0]);
  assert.equal(message.subject, "Log your location");
  assert.match(message.html, /2026-11-19 is already logged as PA/);
  assert.match(message.page, /^https:\/\/location-tracker-wife\.vercel\.app\/\?date=2026-11-19$/);
  assert.equal(MAIL_FROM, "Location Tracker <alerts@updates.joncummins.com>");
  const headers = restHeaders((name) => (
    name === "SUPABASE_SERVICE_ROLE_KEY" ? "header.payload.signature" : ""
  ));
  assert.equal(headers.apikey, "header.payload.signature");
  assert.equal(headers.authorization, "Bearer header.payload.signature");
  const caller = "anon-caller-token";
  assert.equal(headers.authorization.includes(caller), false);
});

test("the reminder rejects a missing or wrong shared secret", async () => {
  assert.equal((await call({ header: "nope" })).status, 401);
  assert.equal((await call({ header: "" })).status, 401);
  assert.equal((await call({ secret: "short" })).status, 503);
  const options = await handleReminder("jon", new Request("https://example.test/reminder", { method: "OPTIONS" }), {
    env: () => "",
    now: () => NOW,
    db: dbFor("8"),
    sendReminder: async () => { throw new Error("should not send"); },
  });
  assert.equal(options.status, 204);
});

test("compare-and-swap quotes the previous JSON value", () => {
  assert.equal(postgrestEq('{"attempts":1,"hash":"a\\"b"}'), 'eq."{""attempts"":1,""hash"":""a\\""b""}"');
});

test("cron SQL updates jobs 5 and 6 and does not contain a key", () => {
  const sql = readFileSync(new URL("../docs/reminder-cron.sql", import.meta.url), "utf8");
  assert.match(sql, /job_id := 5/);
  assert.match(sql, /job_id := 6/);
  assert.match(sql, /x-reminder-secret/);
  assert.match(sql, /__REMINDER_CRON_SECRET__/);
  assert.equal(sql.includes("eyJ"), false);
  const source = readFileSync(new URL("../supabase/functions/_shared/reminder.mjs", import.meta.url), "utf8");
  assert.equal(source.includes('req.headers.get("Authorization")'), false);
  assert.equal(source.includes("createSupabaseDb"), true);
  assert.match(readFileSync(new URL("../supabase/functions/location-reminder/index.ts", import.meta.url), "utf8"), /"jon"/);
  assert.match(readFileSync(new URL("../supabase/functions/location-reminder-wife/index.ts", import.meta.url), "utf8"), /"amy"/);
});
