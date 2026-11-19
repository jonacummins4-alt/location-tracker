// Session and data access for Jon's and Amy's location trackers.
// The browser never holds a Supabase key. This module checks a signed
// session, then reads and writes with the service role.

import { MAIL_FROM } from "./mail-from.mjs";

export const PEOPLE = {
  jon: {
    entries: "location_entries",
    settings: "user_settings",
  },
  amy: {
    entries: "location_entries_wife",
    settings: "user_settings_wife",
  },
};

export const SETTINGS_KEYS = ["home_state", "email_address", "location_email_hour"];
export const LOGIN_RATE_KEY = "tracker_login_rate";
export const LOGIN_CHALLENGE_KEY = "tracker_login_challenge";
export const SESSION_VERSION_KEY = "tracker_session_version";

export const ALLOWED_ORIGINS = {
  "https://location-tracker-sand-six.vercel.app": "jon",
  "https://location-tracker-wife.vercel.app": "amy",
};

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_WITHIN_MS = 15 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MIN_SECRET_LENGTH = 32;
export const MAX_SENDS_PER_HOUR = 5;
export const MIN_SEND_GAP_MS = 60 * 1000;
export const MAX_SENDS_PER_IP_PER_HOUR = 20;
export const MAX_VERIFY_ATTEMPTS = 5;
export const HOUR_MS = 60 * 60 * 1000;

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

const encoder = new TextEncoder();

export function tableFor(person) {
  const row = PEOPLE[person];
  if (!row) throw new Error("unknown person");
  return row;
}

export function personForOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS[origin] || null;
}

export function maskEmail(email) {
  const at = String(email).indexOf("@");
  if (at < 1) return "the saved address";
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${name.slice(0, 2)}***@${domain}`;
}

export function randomCode(bytes) {
  const buf = bytes || crypto.getRandomValues(new Uint8Array(4));
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}

function bytesToB64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    const err = new Error("session secret is not configured");
    err.status = 503;
    throw err;
  }
}

export async function hashCode(secret, person, code) {
  return hex(await hmac(secret, `code:${person}:${code}`));
}

export async function signSession(secret, person, nowMs, version = 0) {
  assertSecret(secret);
  if (!PEOPLE[person]) throw new Error("unknown person");
  const sessionVersion = Number.isInteger(version) ? version : Number(version) || 0;
  const payload = {
    p: person,
    sv: sessionVersion,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + SESSION_TTL_MS) / 1000),
  };
  const body = bytesToB64Url(encoder.encode(JSON.stringify(payload)));
  const sig = bytesToB64Url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifySession(secret, token, nowMs) {
  assertSecret(secret);
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig || token.slice(dot + 1).includes(".")) return null;
  const expected = bytesToB64Url(await hmac(secret, body));
  if (!timingSafeEqual(expected, sig)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(body)));
  } catch {
    return null;
  }
  if (!payload || !PEOPLE[payload.p]) return null;
  if (typeof payload.sv !== "number" || !Number.isFinite(payload.sv)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
  return payload;
}

export function bearerToken(req) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
}

export function clientIp(req) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || "unknown";
}

export function decideSend(record, ipHash, nowMs) {
  const current = record && typeof record === "object" ? record : {};
  const next = {
    send_window_start: current.send_window_start || nowMs,
    send_count: current.send_count || 0,
    last_send_at: current.last_send_at || 0,
    ips: { ...(current.ips || {}) },
  };
  if (nowMs - next.send_window_start >= HOUR_MS) {
    next.send_window_start = nowMs;
    next.send_count = 0;
  }
  if (next.last_send_at && nowMs - next.last_send_at < MIN_SEND_GAP_MS) {
    return { ok: false, status: 429, error: "Wait a minute, then ask for another code.", next: current };
  }
  if (next.send_count >= MAX_SENDS_PER_HOUR) {
    return { ok: false, status: 429, error: "Too many codes were sent. Try again in an hour.", next: current };
  }
  const ip = next.ips[ipHash] || { window_start: nowMs, count: 0 };
  if (nowMs - ip.window_start >= HOUR_MS) {
    ip.window_start = nowMs;
    ip.count = 0;
  }
  if (ip.count >= MAX_SENDS_PER_IP_PER_HOUR) {
    return { ok: false, status: 429, error: "Too many codes were sent. Try again in an hour.", next: current };
  }
  ip.count += 1;
  next.ips[ipHash] = ip;
  next.send_count += 1;
  next.last_send_at = nowMs;
  const ipKeys = Object.keys(next.ips);
  if (ipKeys.length > 30) {
    ipKeys.sort((a, b) => (next.ips[a].window_start || 0) - (next.ips[b].window_start || 0));
    for (const key of ipKeys.slice(0, ipKeys.length - 30)) delete next.ips[key];
  }
  return { ok: true, next };
}

export function validateEntry(input) {
  const entry = input || {};
  const date = String(entry.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Enter a date as YYYY-MM-DD." };
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return { error: "That date is not valid." };
  }
  const type = entry.type === "abroad" ? "abroad" : entry.type === "state" ? "state" : "";
  if (!type) return { error: "Type must be state or abroad." };
  let location = String(entry.location || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!location || location.length > 80) return { error: "Enter a location." };
  if (type === "state") {
    location = location.toUpperCase();
    if (!US_STATES.includes(location)) return { error: "Choose a US state." };
  } else if (/[<>]/.test(location)) {
    return { error: "That location is not valid." };
  }
  let id = entry.id == null ? "" : String(entry.id);
  if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { error: "That entry id is not valid." };
  if (!id) {
    const buf = crypto.getRandomValues(new Uint8Array(9));
    id = bytesToB64Url(buf).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  }
  return { entry: { id, date, location, type } };
}

export function validateSettingsPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Settings were missing." };
  const keys = Object.keys(input);
  if (!keys.length) return { error: "Settings were missing." };
  if (keys.some((key) => !SETTINGS_KEYS.includes(key))) return { error: "That setting cannot be changed here." };
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(input, "home_state")) {
    const value = String(input.home_state || "").toUpperCase();
    if (!US_STATES.includes(value)) return { error: "Choose a home state." };
    patch.home_state = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "email_address")) {
    const value = String(input.email_address || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 200) return { error: "Enter a valid email address." };
    if (value.toLowerCase() === "your@email.com") return { error: "Enter a real email address." };
    patch.email_address = value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "location_email_hour")) {
    const hour = Number(input.location_email_hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "Choose an hour from 0 to 23." };
    patch.location_email_hour = String(hour);
  }
  return { patch };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

export function corsHeaders(origin) {
  const person = personForOrigin(origin);
  const headers = {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
  if (person && origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function originAllows(origin, person) {
  return personForOrigin(origin) === person;
}

export function postgrestEq(value) {
  const escaped = String(value).replace(/"/g, '""');
  return `eq."${escaped}"`;
}

async function readJson(req) {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > 20000) {
    const err = new Error("Request is too large.");
    err.status = 413;
    throw err;
  }
  const text = await req.text();
  if (text.length > 20000) {
    const err = new Error("Request is too large.");
    err.status = 413;
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Request was not valid JSON.");
    err.status = 400;
    throw err;
  }
}

function parseStored(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ipHash(secret, ip) {
  return hex(await hmac(secret, `ip:${ip}`)).slice(0, 32);
}

export function serviceKey(env) {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const parsed = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    return "";
  }
  return "";
}

export function restHeaders(env) {
  const key = serviceKey(env);
  const headers = {
    apikey: key,
    "content-type": "application/json",
  };
  if (key && key.split(".").length === 3) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function restFetch(env, fetchImpl, table, { method = "GET", query = {}, body, prefer } = {}) {
  const base = env("SUPABASE_URL");
  const headers = restHeaders(env);
  if (!base || !headers.apikey) {
    const err = new Error("database is not configured");
    err.status = 503;
    throw err;
  }
  const url = new URL(`${base.replace(/\/$/, "")}/rest/v1/${table}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  if (prefer) headers.prefer = prefer;
  const res = await fetchImpl(url.toString(), {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("database request failed");
    err.status = res.status === 409 ? 409 : 502;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export function createSupabaseDb(env, fetchImpl) {
  return {
    async listEntries(person) {
      const table = tableFor(person).entries;
      const rows = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const page = await restFetch(env, fetchImpl, table, {
          query: {
            select: "id,date,location,type",
            order: "date.desc",
            limit: "1000",
            offset: String(offset),
          },
        });
        const list = page || [];
        rows.push(...list);
        if (list.length < 1000) break;
      }
      return rows.map((row) => ({
        id: row.id,
        date: String(row.date).slice(0, 10),
        location: row.location,
        type: row.type || "state",
      }));
    },
    async findEntryByDate(person, date) {
      const table = tableFor(person).entries;
      const rows = await restFetch(env, fetchImpl, table, {
        query: {
          select: "id,date",
          date: `eq.${date}`,
          order: "created_at.asc",
          limit: "1",
        },
      });
      return rows && rows[0] ? rows[0] : null;
    },
    async insertEntry(person, entry) {
      const table = tableFor(person).entries;
      const rows = await restFetch(env, fetchImpl, table, {
        method: "POST",
        body: entry,
        prefer: "return=representation",
      });
      return rows && rows[0] ? rows[0] : entry;
    },
    async updateEntry(person, id, patch) {
      const table = tableFor(person).entries;
      const rows = await restFetch(env, fetchImpl, table, {
        method: "PATCH",
        query: { id: `eq.${id}` },
        body: patch,
        prefer: "return=representation",
      });
      return rows && rows[0] ? rows[0] : { id, ...patch };
    },
    async deleteEntry(person, id) {
      const table = tableFor(person).entries;
      await restFetch(env, fetchImpl, table, {
        method: "DELETE",
        query: { id: `eq.${id}` },
        prefer: "return=minimal",
      });
    },
    async getSettings(person, keys) {
      const table = tableFor(person).settings;
      const rows = await restFetch(env, fetchImpl, table, {
        query: {
          select: "key,value",
          key: `in.(${keys.join(",")})`,
        },
      });
      const out = {};
      for (const row of rows || []) out[row.key] = row.value;
      return out;
    },
    async upsertSetting(person, key, value) {
      const table = tableFor(person).settings;
      await restFetch(env, fetchImpl, table, {
        method: "POST",
        body: { key, value, updated_at: new Date().toISOString() },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    },
    async deleteSetting(person, key) {
      const table = tableFor(person).settings;
      await restFetch(env, fetchImpl, table, {
        method: "DELETE",
        query: { key: `eq.${key}` },
        prefer: "return=minimal",
      });
    },
    async compareAndSwapSetting(person, key, oldValue, newValue) {
      const table = tableFor(person).settings;
      const rows = await restFetch(env, fetchImpl, table, {
        method: "PATCH",
        query: { key: `eq.${key}`, value: postgrestEq(oldValue) },
        body: { value: newValue, updated_at: new Date().toISOString() },
        prefer: "return=representation",
      });
      return Array.isArray(rows) && rows.length > 0;
    },
    async insertSettingIfAbsent(person, key, value) {
      const table = tableFor(person).settings;
      try {
        const rows = await restFetch(env, fetchImpl, table, {
          method: "POST",
          body: { key, value, updated_at: new Date().toISOString() },
          prefer: "return=representation",
        });
        return Array.isArray(rows) && rows.length > 0;
      } catch (err) {
        if (err.status === 409) return false;
        throw err;
      }
    },
    async deleteSettingIfMatch(person, key, oldValue) {
      const table = tableFor(person).settings;
      const rows = await restFetch(env, fetchImpl, table, {
        method: "DELETE",
        query: { key: `eq.${key}`, value: postgrestEq(oldValue) },
        prefer: "return=representation",
      });
      return Array.isArray(rows) && rows.length > 0;
    },
  };
}

async function sendCodeEmail(env, fetchImpl, to, code) {
  const key = env("RESEND_API_KEY");
  if (!key) {
    const err = new Error("email is not configured");
    err.status = 503;
    throw err;
  }
  const html = `<p>Your location tracker sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p>`;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: "Your location tracker sign-in code",
      html,
    }),
  });
  if (!res.ok) {
    const err = new Error("email could not be sent");
    err.status = 502;
    throw err;
  }
}

export function createProductionDeps(deps) {
  return {
    env: deps.env,
    now: deps.now,
    db: createSupabaseDb(deps.env, deps.fetch),
    sendCode: (to, code) => sendCodeEmail(deps.env, deps.fetch, to, code),
  };
}

async function currentSessionVersion(db, person) {
  const raw = (await db.getSettings(person, [SESSION_VERSION_KEY]))[SESSION_VERSION_KEY];
  const version = Number(raw || 0);
  return Number.isFinite(version) ? version : 0;
}

async function requireSession(req, deps, origin) {
  const secret = deps.env("LOCATION_SESSION_SECRET");
  const payload = await verifySession(secret, bearerToken(req), deps.now());
  if (!payload) {
    const err = new Error("Sign in required.");
    err.status = 401;
    throw err;
  }
  if (!originAllows(origin, payload.p)) {
    const err = new Error("This page cannot use that session.");
    err.status = 403;
    throw err;
  }
  const version = await currentSessionVersion(deps.db, payload.p);
  if (payload.sv !== version) {
    const err = new Error("Sign in required.");
    err.status = 401;
    throw err;
  }
  let token = "";
  if (payload.exp * 1000 - deps.now() < SESSION_REFRESH_WITHIN_MS) {
    token = await signSession(secret, payload.p, deps.now(), version);
  }
  return { person: payload.p, token };
}

export async function handleRequest(req, deps) {
  const origin = req.headers.get("origin") || "";
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    const body = await readJson(req);
    const action = body.action;
    const secret = deps.env("LOCATION_SESSION_SECRET");

    if (action === "health") {
      return json({
        ok: true,
        session: typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
        email: Boolean(deps.env("RESEND_API_KEY")),
        database: Boolean(serviceKey(deps.env) && deps.env("SUPABASE_URL")),
      }, 200, origin);
    }

    if (action === "request-code" || action === "verify-code") {
      assertSecret(secret);
      const person = body.person;
      if (!PEOPLE[person]) return json({ error: "Unknown tracker." }, 400, origin);
      if (!originAllows(origin, person)) return json({ error: "This page cannot sign in to that tracker." }, 403, origin);
      if (action === "request-code") return await requestCode(person, req, deps, origin, secret);
      return await verifyCode(person, body.code, deps, origin, secret);
    }

    const session = await requireSession(req, deps, origin);
    if (action === "session") {
      return json({ ok: true, person: session.person, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    if (action === "sign-out") {
      await bumpSessionVersion(deps.db, session.person);
      return json({ ok: true }, 200, origin);
    }
    if (action === "list-entries") {
      const entries = await deps.db.listEntries(session.person);
      return json({ entries, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    if (action === "upsert-entry") {
      const validated = validateEntry(body.entry);
      if (validated.error) return json({ error: validated.error }, 400, origin);
      const saved = await saveEntry(deps.db, session.person, validated.entry);
      return json({ entry: saved, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    if (action === "delete-entry") {
      const id = String(body.id || "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json({ error: "That entry id is not valid." }, 400, origin);
      await deps.db.deleteEntry(session.person, id);
      return json({ ok: true, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    if (action === "get-settings") {
      const stored = await deps.db.getSettings(session.person, SETTINGS_KEYS);
      const settings = {};
      for (const key of SETTINGS_KEYS) if (stored[key] != null) settings[key] = stored[key];
      return json({ settings, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    if (action === "save-settings") {
      const validated = validateSettingsPatch(body.settings);
      if (validated.error) return json({ error: validated.error }, 400, origin);
      for (const [key, value] of Object.entries(validated.patch)) {
        await deps.db.upsertSetting(session.person, key, value);
      }
      return json({ ok: true, ...(session.token ? { token: session.token } : {}) }, 200, origin);
    }
    return json({ error: "Unknown action." }, 400, origin);
  } catch (err) {
    const status = err.status || 500;
    const message = status >= 500 ? "Something went wrong." : err.message;
    return json({ error: message }, status, origin);
  }
}

async function compareAndSet(db, person, key, oldRaw, newRaw) {
  if (oldRaw == null) return db.insertSettingIfAbsent(person, key, newRaw);
  return db.compareAndSwapSetting(person, key, oldRaw, newRaw);
}

async function commitRate(db, person, ipHashValue, nowMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await db.getSettings(person, [LOGIN_RATE_KEY]))[LOGIN_RATE_KEY] ?? null;
    const decision = decideSend(parseStored(raw), ipHashValue, nowMs);
    if (!decision.ok) return decision;
    const wrote = await compareAndSet(db, person, LOGIN_RATE_KEY, raw, JSON.stringify(decision.next));
    if (wrote) return decision;
  }
  return { ok: false, status: 429, error: "Too many codes were sent. Try again in an hour." };
}

async function bumpSessionVersion(db, person) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await db.getSettings(person, [SESSION_VERSION_KEY]))[SESSION_VERSION_KEY] ?? null;
    const next = String((Number(raw) || 0) + 1);
    const wrote = await compareAndSet(db, person, SESSION_VERSION_KEY, raw, next);
    if (wrote) return Number(next);
  }
  const err = new Error("Could not sign out. Try again.");
  err.status = 409;
  throw err;
}

async function requestCode(person, req, deps, origin, secret) {
  const settings = await deps.db.getSettings(person, ["email_address"]);
  const email = settings.email_address || "";
  if (!email || email === "your@email.com") {
    return json({ error: "No email is saved for this tracker yet." }, 400, origin);
  }
  const decision = await commitRate(deps.db, person, await ipHash(secret, clientIp(req)), deps.now());
  if (!decision.ok) return json({ error: decision.error }, decision.status, origin);
  const code = randomCode();
  const challenge = {
    hash: await hashCode(secret, person, code),
    exp: deps.now() + CODE_TTL_MS,
    attempts: 0,
  };
  const challengeRaw = JSON.stringify(challenge);
  let stored = false;
  for (let attempt = 0; attempt < 3 && !stored; attempt++) {
    const current = (await deps.db.getSettings(person, [LOGIN_CHALLENGE_KEY]))[LOGIN_CHALLENGE_KEY] ?? null;
    stored = await compareAndSet(deps.db, person, LOGIN_CHALLENGE_KEY, current, challengeRaw);
  }
  if (!stored) return json({ error: "Too many codes were sent. Try again in an hour." }, 429, origin);
  await deps.sendCode(email, code);
  return json({ ok: true, masked: maskEmail(email) }, 200, origin);
}

async function verifyCode(person, code, deps, origin, secret) {
  const submitted = String(code || "").trim();
  const actual = /^[0-9]{6}$/.test(submitted) ? await hashCode(secret, person, submitted) : "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await deps.db.getSettings(person, [LOGIN_CHALLENGE_KEY]))[LOGIN_CHALLENGE_KEY] ?? null;
    const challenge = parseStored(raw);
    if (!raw || !challenge || typeof challenge.exp !== "number" || challenge.exp <= deps.now()) {
      return json({ error: "That code is expired. Request a new one." }, 401, origin);
    }
    const attempts = Number(challenge.attempts) || 0;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await deps.db.deleteSettingIfMatch(person, LOGIN_CHALLENGE_KEY, raw);
      return json({ error: "That code is expired. Request a new one." }, 401, origin);
    }
    const expected = typeof challenge.hash === "string" ? challenge.hash : "";
    const matches = Boolean(expected && actual && timingSafeEqual(expected, actual));
    if (!matches) {
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_VERIFY_ATTEMPTS) {
        const removed = await deps.db.deleteSettingIfMatch(person, LOGIN_CHALLENGE_KEY, raw);
        if (removed) return json({ error: "That code is expired. Request a new one." }, 401, origin);
        continue;
      }
      const wrote = await deps.db.compareAndSwapSetting(
        person,
        LOGIN_CHALLENGE_KEY,
        raw,
        JSON.stringify({ ...challenge, attempts: nextAttempts }),
      );
      if (wrote) return json({ error: "That code is not valid." }, 401, origin);
      continue;
    }
    const removed = await deps.db.deleteSettingIfMatch(person, LOGIN_CHALLENGE_KEY, raw);
    if (!removed) continue;
    const version = await currentSessionVersion(deps.db, person);
    const token = await signSession(secret, person, deps.now(), version);
    return json({ ok: true, token, person }, 200, origin);
  }
  return json({ error: "That code is not valid." }, 401, origin);
}

async function saveEntry(db, person, entry) {
  const existing = await db.findEntryByDate(person, entry.date);
  if (existing && existing.id) {
    return db.updateEntry(person, existing.id, {
      date: entry.date,
      location: entry.location,
      type: entry.type,
    });
  }
  try {
    return await db.insertEntry(person, entry);
  } catch (err) {
    if (err.status !== 409) throw err;
    const again = await db.findEntryByDate(person, entry.date);
    if (!again) throw err;
    return db.updateEntry(person, again.id, {
      date: entry.date,
      location: entry.location,
      type: entry.type,
    });
  }
}

export function retiredPasswordHint() {
  return new Response(JSON.stringify({
    error: "Password hints are retired. Open the tracker and email yourself a sign-in code.",
  }), {
    status: 410,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, apikey",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
