import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOGIN_CHALLENGE_KEY,
  LOGIN_RATE_KEY,
  PEOPLE,
  SETTINGS_KEYS,
  decideSend,
  handleRequest,
  personForOrigin,
  retiredPasswordHint,
  signSession,
  tableFor,
  validateEntry,
  validateSettingsPatch,
  verifySession,
} from "../supabase/functions/_shared/tracker-logic.mjs";

const SECRET = "test-session-secret-that-is-long-enough";
const ORIGIN = "https://location-tracker-sand-six.vercel.app";
const AMY_ORIGIN = "https://location-tracker-wife.vercel.app";

function memoryDb() {
  const data = {
    jon: { entries: [], settings: { email_address: "jon@example.com", home_state: "PA", location_email_hour: "8" } },
    amy: { entries: [], settings: { email_address: "amy@example.com", home_state: "NY", location_email_hour: "9" } },
  };
  const calls = [];
  return {
    calls,
    data,
    async listEntries(person) {
      calls.push(["list", person]);
      return data[person].entries.map((row) => ({ ...row }));
    },
    async findEntryByDate(person, date) {
      calls.push(["find", person, date]);
      return data[person].entries.find((row) => row.date === date) || null;
    },
    async insertEntry(person, entry) {
      calls.push(["insert", person, entry.date]);
      data[person].entries.push({ ...entry });
      return { ...entry };
    },
    async updateEntry(person, id, patch) {
      calls.push(["update", person, id]);
      const row = data[person].entries.find((item) => item.id === id);
      Object.assign(row, patch);
      return { ...row };
    },
    async deleteEntry(person, id) {
      calls.push(["delete", person, id]);
      data[person].entries = data[person].entries.filter((row) => row.id !== id);
    },
    async getSettings(person, keys) {
      calls.push(["get-settings", person, keys.join(",")]);
      const out = {};
      for (const key of keys) if (data[person].settings[key] != null) out[key] = data[person].settings[key];
      return out;
    },
    async upsertSetting(person, key, value) {
      calls.push(["upsert-setting", person, key]);
      data[person].settings[key] = value;
    },
    async deleteSetting(person, key) {
      calls.push(["delete-setting", person, key]);
      delete data[person].settings[key];
    },
    async compareAndSwapSetting(person, key, oldValue, newValue) {
      calls.push(["cas", person, key]);
      if (data[person].settings[key] !== oldValue) return false;
      data[person].settings[key] = newValue;
      return true;
    },
    async insertSettingIfAbsent(person, key, value) {
      calls.push(["insert-setting", person, key]);
      if (data[person].settings[key] != null) return false;
      data[person].settings[key] = value;
      return true;
    },
    async deleteSettingIfMatch(person, key, oldValue) {
      calls.push(["delete-match", person, key]);
      if (data[person].settings[key] !== oldValue) return false;
      delete data[person].settings[key];
      return true;
    },
  };
}

function deps(extra = {}) {
  const sent = [];
  const db = extra.db || memoryDb();
  return {
    db,
    sent,
    env(name) {
      const values = {
        LOCATION_SESSION_SECRET: SECRET,
        RESEND_API_KEY: "set",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "set",
        ...extra.env,
      };
      return values[name] ?? "";
    },
    now: () => extra.now || Date.parse("2026-11-19T15:00:00Z"),
    async sendCode(to, code) {
      sent.push({ to, code });
    },
  };
}

async function post(action, body, { token = "", origin = ORIGIN, d = deps() } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handleRequest(new Request("https://example.supabase.co/functions/v1/tracker-api", {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...body }),
  }), d);
  return { status: res.status, body: await res.json(), d };
}

test("origin binding keeps the two sites apart", () => {
  assert.equal(personForOrigin(ORIGIN), "jon");
  assert.equal(personForOrigin("https://location-tracker-sand-six-git-branch-team.vercel.app"), null);
  assert.equal(personForOrigin(AMY_ORIGIN), "amy");
  assert.equal(personForOrigin("https://location-tracker-wife-git-branch-team.vercel.app"), null);
  assert.equal(personForOrigin("http://localhost:3000"), null);
  assert.equal(personForOrigin("https://evil.example"), null);
  assert.equal(tableFor("jon").entries, "location_entries");
  assert.equal(tableFor("amy").settings, "user_settings_wife");
  assert.throws(() => tableFor("wife"));
});

test("session tokens are signed, expire, and do not cross people", async () => {
  const now = Date.parse("2026-11-19T15:00:00Z");
  const token = await signSession(SECRET, "jon", now);
  const payload = await verifySession(SECRET, token, now + 1000);
  assert.equal(payload.p, "jon");
  assert.equal(await verifySession(SECRET, token + "x", now), null);
  assert.equal(await verifySession(SECRET, token, now + 31 * 24 * 60 * 60 * 1000), null);
  const amy = await signSession(SECRET, "amy", now);
  assert.equal((await verifySession(SECRET, amy, now)).p, "amy");
  assert.notEqual(token.split(".")[0], amy.split(".")[0]);
});

test("a Jon session cannot read or write Amy's rows", async () => {
  const d = deps();
  d.db.data.amy.entries.push({ id: "amy1", date: "2026-11-01", location: "NY", type: "state" });
  const token = await signSession(SECRET, "jon", d.now());
  const listed = await post("list-entries", { person: "amy" }, { token, d });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.entries, []);
  assert.deepEqual(d.db.calls.find((row) => row[0] === "list"), ["list", "jon"]);

  const saved = await post("upsert-entry", {
    person: "amy",
    entry: { id: "j1", date: "2026-11-02", location: "PA", type: "state" },
  }, { token, d });
  assert.equal(saved.status, 200);
  assert.equal(d.db.data.jon.entries.length, 1);
  assert.equal(d.db.data.amy.entries.length, 1);

  const settings = await post("get-settings", { person: "amy" }, { token, d });
  assert.equal(settings.body.settings.email_address, "jon@example.com");
  assert.ok(!Object.keys(settings.body.settings).some((key) => key.startsWith("tracker_login")));
});

test("Amy's origin cannot request a code for Jon", async () => {
  const result = await post("request-code", { person: "jon" }, { origin: AMY_ORIGIN });
  assert.equal(result.status, 403);
  assert.equal(result.d.sent.length, 0);
});

test("request-code emails only the stored address and rate limits", async () => {
  const d = deps();
  const sent = await post("request-code", { person: "jon", email: "attacker@example.com" }, { d });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.masked, "jo***@example.com");
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].to, "jon@example.com");
  assert.match(d.sent[0].code, /^[0-9]{6}$/);
  assert.equal(JSON.parse(d.db.data.jon.settings[LOGIN_CHALLENGE_KEY]).hash.includes(d.sent[0].code), false);

  const again = await post("request-code", { person: "jon" }, { d });
  assert.equal(again.status, 429);
  assert.equal(d.sent.length, 1);
});

test("verify-code issues a person-bound token and locks out guesses", async () => {
  const d = deps();
  await post("request-code", { person: "amy" }, { origin: AMY_ORIGIN, d });
  const code = d.sent[0].code;
  const wrong = await post("verify-code", { person: "amy", code: "000000" }, { origin: AMY_ORIGIN, d });
  assert.equal(wrong.status, 401);
  const right = await post("verify-code", { person: "amy", code }, { origin: AMY_ORIGIN, d });
  assert.equal(right.status, 200);
  const payload = await verifySession(SECRET, right.body.token, d.now());
  assert.equal(payload.p, "amy");
  assert.equal(d.db.data.amy.settings[LOGIN_CHALLENGE_KEY], undefined);

  const reuse = await post("verify-code", { person: "amy", code }, { origin: AMY_ORIGIN, d });
  assert.equal(reuse.status, 401);
});

test("five wrong codes clear the challenge", async () => {
  const d = deps();
  await post("request-code", { person: "jon" }, { d });
  for (let i = 0; i < 5; i++) {
    const res = await post("verify-code", { person: "jon", code: "111111" }, { d });
    assert.equal(res.status, 401);
  }
  assert.equal(d.db.data.jon.settings[LOGIN_CHALLENGE_KEY], undefined);
});

test("settings allowlist rejects tracker-private keys and other rows", async () => {
  const token = await signSession(SECRET, "jon", Date.parse("2026-11-19T15:00:00Z"));
  const d = deps();
  d.db.data.jon.settings.digest_sent = "secret-row";
  const bad = await post("save-settings", { settings: { digest_sent: "x", email_address: "a@b.co" } }, { token, d });
  assert.equal(bad.status, 400);
  assert.equal(d.db.data.jon.settings.digest_sent, "secret-row");
  const login = await post("save-settings", { settings: { [LOGIN_RATE_KEY]: "{}" } }, { token, d });
  assert.equal(login.status, 400);
  const ok = await post("save-settings", { settings: { home_state: "ca", location_email_hour: 14 } }, { token, d });
  assert.equal(ok.status, 200);
  assert.equal(d.db.data.jon.settings.home_state, "CA");
  assert.equal(d.db.data.jon.settings.location_email_hour, "14");
});

test("entry validation and same-day update stay on that person's table", async () => {
  assert.equal(validateEntry({ date: "2026-02-31", location: "PA", type: "state" }).error.includes("date"), true);
  assert.equal(validateEntry({ date: "2026-11-01", location: "<script>", type: "abroad" }).error.includes("not valid"), true);
  const d = deps();
  const token = await signSession(SECRET, "jon", d.now());
  const first = await post("upsert-entry", { entry: { date: "2026-11-01", location: "pa", type: "state" } }, { token, d });
  assert.equal(first.body.entry.location, "PA");
  const second = await post("upsert-entry", { entry: { id: "other", date: "2026-11-01", location: "NY", type: "state" } }, { token, d });
  assert.equal(second.status, 200);
  assert.equal(d.db.data.jon.entries.length, 1);
  assert.equal(d.db.data.jon.entries[0].location, "NY");
});

test("unauthenticated data calls and a missing secret fail closed", async () => {
  const open = await post("list-entries", {});
  assert.equal(open.status, 401);
  const d = deps({ env: { LOCATION_SESSION_SECRET: "short" } });
  const health = await post("health", {}, { d });
  assert.equal(health.body.session, false);
  const code = await post("request-code", { person: "jon" }, { d });
  assert.equal(code.status, 503);
  assert.equal(d.sent.length, 0);
});

test("send-password-hint is retired and does not describe a password", async () => {
  const res = retiredPasswordHint();
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.match(body.error, /retired/i);
  assert.equal(JSON.stringify(body).toLowerCase().includes("password is"), false);
});

test("rate limit window resets after an hour", () => {
  const start = Date.parse("2026-11-19T15:00:00Z");
  let record = { send_window_start: start, send_count: 5, last_send_at: start, ips: {} };
  const blocked = decideSend(record, "ip", start + 61 * 1000);
  assert.equal(blocked.ok, false);
  const later = decideSend(record, "ip", start + 61 * 60 * 1000);
  assert.equal(later.ok, true);
  assert.equal(later.next.send_count, 1);
});

test("pages no longer ship a Supabase key, a password, or direct table access", () => {
  const client = readFileSync(new URL("../tracker-page.js", import.meta.url), "utf8");
  assert.equal(client.includes("functions/v1/tracker-api"), true);
  assert.equal(client.includes("eyJ"), false);
  assert.equal(client.includes("rest/v1"), false);
  for (const file of ["index.html", "index-html.html"]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(html.includes("eyJ"), false, file);
    assert.equal(html.includes("rest/v1"), false, file);
    assert.equal(html.includes("SUPABASE_KEY"), false, file);
    assert.equal(html.includes("const P="), false, file);
    assert.equal(html.includes("send-password-hint"), false, file);
    assert.equal(html.includes("tracker-page.js"), true, file);
    assert.equal(html.includes('TRACKER_PERSON = "jon"'), true, file);
    assert.equal(html.includes('id="root" style="display:none"'), true, file);
  }
  assert.deepEqual(SETTINGS_KEYS, ["home_state", "email_address", "location_email_hour"]);
  assert.equal(PEOPLE.jon.entries !== PEOPLE.amy.entries, true);
});

test("lockdown SQL drops location anon access and the settings stopgap", () => {
  const sql = readFileSync(new URL("../docs/lock-location-anon.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../docs/lock-location-anon-rollback.sql", import.meta.url), "utf8");
  assert.match(sql, /begin;/i);
  assert.match(sql, /commit;/i);
  assert.match(sql, /drop policy if exists "Allow anon all" on public.location_entries/i);
  assert.match(sql, /drop policy if exists anon_all_wife_entries on public.location_entries_wife/i);
  assert.match(sql, /drop policy if exists anon_all_wife_settings on public.user_settings_wife/i);
  assert.match(sql, /home_state/);
  assert.match(sql, /location_email_hour/);
  assert.match(sql, /user#_settings#_location#_%/);
  assert.match(sql, /PR 39 supabase\/lock-anon-access.sql FIRST/i);
  assert.match(sql, /anon_all_user_settings/);
  assert.equal(sql.includes("eyJ"), false);
  assert.match(rollback, /create policy "Allow anon all"/i);
  assert.match(rollback, /anon_all_wife_entries/);
  assert.match(rollback, /anon_location_settings_keys/);
  assert.equal(rollback.includes("grant select, insert, update, delete on table public.conversations"), false);
});

test("settings patch rejects a blank email", () => {
  assert.equal(Boolean(validateSettingsPatch({ email_address: "" }).error), true);
  assert.equal(validateSettingsPatch({ location_email_hour: 24 }).error.includes("hour"), true);
});

test("parallel wrong codes cannot pass the five-guess limit", async () => {
  const d = deps();
  await post("request-code", { person: "jon" }, { d });
  const results = await Promise.all(Array.from({ length: 10 }, () => (
    post("verify-code", { person: "jon", code: "000000" }, { d })
  )));
  assert.equal(results.filter((row) => row.body.error === "That code is not valid.").length, 4);
  assert.equal(results.filter((row) => row.body.error === "That code is expired. Request a new one.").length, 6);
  assert.equal(d.db.data.jon.settings[LOGIN_CHALLENGE_KEY], undefined);
});

test("parallel code requests count as one send inside the same minute", async () => {
  const d = deps();
  const results = await Promise.all(Array.from({ length: 6 }, () => post("request-code", { person: "jon" }, { d })));
  assert.equal(results.filter((row) => row.status === 200).length, 1);
  assert.equal(d.sent.length, 1);
});

test("sign-out bumps the session version and the old token stops working", async () => {
  const d = deps();
  await post("request-code", { person: "jon" }, { d });
  const verified = await post("verify-code", { person: "jon", code: d.sent[0].code }, { d });
  const token = verified.body.token;
  assert.equal((await post("list-entries", {}, { token, d })).status, 200);
  assert.equal((await post("sign-out", {}, { token, d })).status, 200);
  assert.equal(d.db.data.jon.settings.tracker_session_version, "1");
  assert.equal((await post("list-entries", {}, { token, d })).status, 401);
});
