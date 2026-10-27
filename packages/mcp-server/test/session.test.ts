import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NotLoggedInError, SessionManager, readSession, writeSession, type FetchLike, type StoredSession } from "../src/session.ts";

const URL_ = "https://example.supabase.co";

const tmpSession = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seine-session-")), "session.json");

const stored = (expiresInS: number, refresh = "r0"): StoredSession => ({
  access_token: `a-${refresh}`,
  refresh_token: refresh,
  expires_at: Math.floor(Date.now() / 1000) + expiresInS,
  user: { id: "u1", email: "zac@example.org" },
  supabase_url: URL_,
});

// A fake GoTrue token endpoint that rotates the refresh token on every call and
// (like the real one) rejects a spent refresh token.
const fakeAuth = () => {
  let current = "r0";
  let n = 0;
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.refresh_token);
    await new Promise((r) => setTimeout(r, 30));
    if (body.refresh_token !== current) {
      return new Response(JSON.stringify({ error_description: "Invalid Refresh Token: Already Used" }), { status: 400 });
    }
    n += 1;
    current = `r${n}`;
    return new Response(
      JSON.stringify({ access_token: `a-${current}`, refresh_token: current, expires_in: 3600, user: { id: "u1", email: "zac@example.org" } }),
      { status: 200 }
    );
  };
  return { fetchImpl, calls };
};

test("a fresh token is used without contacting auth", async () => {
  const p = tmpSession();
  writeSession(p, stored(3600));
  const { fetchImpl, calls } = fakeAuth();
  const m = new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: p, fetchImpl });
  assert.equal(await m.accessToken(), "a-r0");
  assert.equal(calls.length, 0);
});

test("an expiring token is refreshed once, rotated pair persisted with 0600", async () => {
  const p = tmpSession();
  writeSession(p, stored(10));
  const { fetchImpl, calls } = fakeAuth();
  const m = new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: p, fetchImpl });
  assert.equal(await m.accessToken(), "a-r1");
  assert.equal(await m.accessToken(), "a-r1");
  assert.deepEqual(calls, ["r0"]);
  assert.equal(readSession(p)?.refresh_token, "r1");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test("concurrent processes sharing one session refresh exactly once", async () => {
  const p = tmpSession();
  writeSession(p, stored(10));
  const { fetchImpl, calls } = fakeAuth();
  const managers = Array.from({ length: 5 }, () => new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: p, fetchImpl }));
  const tokens = await Promise.all(managers.map((m) => m.accessToken()));
  assert.deepEqual(new Set(tokens), new Set(["a-r1"]));
  assert.deepEqual(calls, ["r0"]);
  assert.ok(!fs.existsSync(`${p}.lock`), "lock released");
});

test("a revoked refresh token surfaces as NotLoggedInError", async () => {
  const p = tmpSession();
  writeSession(p, stored(10, "stale"));
  const { fetchImpl } = fakeAuth();
  const m = new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: p, fetchImpl });
  await assert.rejects(m.accessToken(), NotLoggedInError);
});

test("no session file means not logged in", async () => {
  const m = new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: tmpSession() });
  await assert.rejects(m.accessToken(), NotLoggedInError);
  assert.throws(() => m.user(), NotLoggedInError);
});

test("a stale lock left by a dead process is taken over", async () => {
  const p = tmpSession();
  writeSession(p, stored(10));
  fs.mkdirSync(`${p}.lock`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${p}.lock`, old, old);
  const { fetchImpl } = fakeAuth();
  const m = new SessionManager({ supabaseUrl: URL_, anonKey: "k", sessionPath: p, fetchImpl });
  assert.equal(await m.accessToken(), "a-r1");
});
